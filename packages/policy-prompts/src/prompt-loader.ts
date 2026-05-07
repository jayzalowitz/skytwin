import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadedPrompt, PromptFrontmatter, PromptFixture } from './types.js';

function resolvePromptsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  // In src/ during dev: thisDir = packages/policy-prompts/src
  // In dist/ after build: thisDir = packages/policy-prompts/dist
  // Prompts directory is always a sibling of src/ or dist/
  const candidate1 = join(thisDir, '..', 'prompts');
  const candidate2 = join(thisDir, 'prompts');
  if (existsSync(candidate2)) return candidate2;
  return candidate1;
}

const PROMPTS_DIR = resolvePromptsDir();

function parseFrontmatter(content: string): { meta: PromptFrontmatter; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { meta: { name: '', version: 1 }, body: content };
  }
  const end = trimmed.indexOf('---', 3);
  if (end === -1) {
    return { meta: { name: '', version: 1 }, body: content };
  }
  const yamlText = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trimStart();
  const meta = parseSimpleYaml(yamlText);
  return { meta, body };
}

function parseSimpleYaml(yaml: string): PromptFrontmatter {
  const lines = yaml.split('\n');
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (rawVal === '') {
      // Could be a block or list below
      const children: string[] = [];
      i++;
      while (i < lines.length) {
        const child = lines[i] ?? '';
        if (!child.startsWith('  ') && !child.startsWith('\t') && child.trim() !== '') break;
        if (child.trim() === '') {
          i++;
          continue;
        }
        children.push(child);
        i++;
      }
      if (children.length > 0) {
        const firstChild = children[0] ?? '';
        if (firstChild.trimStart().startsWith('-')) {
          result[key] = children
            .map((c) => c.trim().replace(/^-\s*/, '').trim())
            .filter(Boolean);
        } else {
          const nested: Record<string, unknown> = {};
          for (const child of children) {
            const ci = child.indexOf(':');
            if (ci === -1) continue;
            const ck = child.slice(0, ci).trim();
            const cv = child.slice(ci + 1).trim();
            nested[ck] = parseScalar(cv);
          }
          result[key] = nested;
        }
      }
      continue;
    }

    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (rawVal.startsWith('|')) {
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const bl = lines[i] ?? '';
        if (!bl.startsWith('  ') && bl.trim() !== '') break;
        blockLines.push(bl.slice(2));
        i++;
      }
      result[key] = blockLines.join('\n').trimEnd() + '\n';
      continue;
    } else {
      result[key] = parseScalar(rawVal);
    }
    i++;
  }

  return result as unknown as PromptFrontmatter;
}

function parseScalar(val: string): unknown {
  const v = val.replace(/^['"]|['"]$/g, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  const n = Number(v);
  if (!isNaN(n) && v !== '') return n;
  return v;
}

function loadFixtures(fixturesDir: string): PromptFixture[] {
  if (!existsSync(fixturesDir)) return [];
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
  const fixtures: PromptFixture[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(fixturesDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      fixtures.push({
        name: file.replace('.json', ''),
        inputs: (parsed['inputs'] as Record<string, unknown>) ?? {},
        expected: parsed['expected'],
        notes: typeof parsed['notes'] === 'string' ? parsed['notes'] : undefined,
      });
    } catch {
      // skip malformed fixture
    }
  }
  return fixtures;
}

function loadSchema(promptDir: string, schemaRef: string | undefined): unknown {
  if (!schemaRef) return undefined;
  const schemaPath = join(promptDir, schemaRef);
  if (!existsSync(schemaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(schemaPath, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

export function loadPrompt(name: string, version?: number): LoadedPrompt {
  const promptDir = join(PROMPTS_DIR, name);
  if (!existsSync(promptDir)) {
    throw new Error(`Prompt not found: ${name}`);
  }

  const resolvedVersion = version ?? resolveLatestVersion(promptDir);
  const promptFile = join(promptDir, `v${resolvedVersion}.md`);
  if (!existsSync(promptFile)) {
    throw new Error(`Prompt version not found: ${name} v${resolvedVersion}`);
  }

  const content = readFileSync(promptFile, 'utf-8');
  const { meta, body } = parseFrontmatter(content);

  if (!meta.name) meta.name = name;
  if (!meta.version) meta.version = resolvedVersion;

  const schema = loadSchema(promptDir, meta.output_schema_ref);
  const fixtures = loadFixtures(join(promptDir, 'eval-fixtures'));

  return { meta, templateBody: body, schema, fixtures };
}

function resolveLatestVersion(promptDir: string): number {
  const files = readdirSync(promptDir).filter((f) => /^v\d+\.md$/.test(f));
  if (files.length === 0) throw new Error(`No versioned prompt files found in ${promptDir}`);
  const versions = files.map((f) => parseInt(f.replace(/^v/, '').replace(/\.md$/, ''), 10));
  return Math.max(...versions);
}

export function listPromptNames(): string[] {
  if (!existsSync(PROMPTS_DIR)) return [];
  return readdirSync(PROMPTS_DIR).filter((entry) => {
    return existsSync(join(PROMPTS_DIR, entry, 'v1.md'));
  });
}
