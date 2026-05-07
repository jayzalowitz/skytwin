import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface ExtractedFileMetadata {
  absPath: string;
  relPath: string;
  rootId: string;
  sizeBytes: number;
  mtimeMs: number;
  mimeType?: string;
  contentHash?: Buffer;
  structuredFields?: Record<string, unknown>;
  skippedReason?: string;
}

export interface FileTypeExtractor {
  match(absPath: string): boolean;
  extract(absPath: string): Promise<Record<string, unknown>>;
}

const MIME_MAGIC: Array<{ magic: Buffer; mime: string }> = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' },
  { magic: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' },
  { magic: Buffer.from([0x47, 0x49, 0x46]), mime: 'image/gif' },
  { magic: Buffer.from([0x25, 0x50, 0x44, 0x46]), mime: 'application/pdf' },
  { magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), mime: 'application/zip' },
];

function sniffMimeType(absPath: string): string | undefined {
  try {
    const fd = readFileSync(absPath, { flag: 'r' });
    const header = fd.subarray(0, 512);
    for (const { magic, mime } of MIME_MAGIC) {
      if (header.subarray(0, magic.length).equals(magic)) {
        return mime;
      }
    }
    // Check extension-based fallbacks
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.toml')) return 'application/toml';
    if (lower.endsWith('.ts') || lower.endsWith('.js')) return 'text/javascript';
    if (lower.endsWith('.md')) return 'text/markdown';
    if (lower.endsWith('.txt')) return 'text/plain';
    if (lower.endsWith('.py')) return 'text/x-python';
    if (lower.endsWith('.go')) return 'text/x-go';
    if (lower.endsWith('.rs')) return 'text/x-rust';
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * package.json extractor — dependency keys only, never description or values.
 */
export const packageJsonExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return basename(absPath) === 'package.json';
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const dep = (obj: unknown): string[] => {
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          return Object.keys(obj as Record<string, unknown>);
        }
        return [];
      };
      const name = typeof parsed['name'] === 'string' ? parsed['name'] : undefined;
      const result: Record<string, unknown> = {};
      if (name !== undefined) result['name'] = name;
      result['dependencies'] = dep(parsed['dependencies']);
      result['devDependencies'] = dep(parsed['devDependencies']);
      // NOTE: 'description' intentionally excluded — natural-language text
      return result;
    } catch {
      return {};
    }
  },
};

/**
 * .git/config extractor — remote origin URL only.
 */
export const gitConfigExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return absPath.endsWith('/.git/config') || absPath.endsWith('\\.git\\config');
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const lines = raw.split('\n');
      let inRemoteOrigin = false;
      let remoteOrigin: string | undefined;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '[remote "origin"]') {
          inRemoteOrigin = true;
          continue;
        }
        if (trimmed.startsWith('[') && inRemoteOrigin) {
          inRemoteOrigin = false;
        }
        if (inRemoteOrigin && trimmed.startsWith('url')) {
          const match = /url\s*=\s*(.+)/.exec(trimmed);
          if (match?.[1]) {
            remoteOrigin = match[1].trim();
          }
        }
      }
      const result: Record<string, unknown> = {};
      if (remoteOrigin !== undefined) result['remoteOrigin'] = remoteOrigin;
      return result;
    } catch {
      return {};
    }
  },
};

/**
 * ~/.gitconfig extractor — userEmail and userName only.
 */
export const globalGitConfigExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return basename(absPath) === '.gitconfig';
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const lines = raw.split('\n');
      let inUser = false;
      let userEmail: string | undefined;
      let userName: string | undefined;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '[user]') {
          inUser = true;
          continue;
        }
        if (trimmed.startsWith('[') && inUser) {
          inUser = false;
        }
        if (inUser) {
          const emailMatch = /email\s*=\s*(.+)/.exec(trimmed);
          if (emailMatch?.[1]) userEmail = emailMatch[1].trim();
          const nameMatch = /name\s*=\s*(.+)/.exec(trimmed);
          if (nameMatch?.[1]) userName = nameMatch[1].trim();
        }
      }
      const result: Record<string, unknown> = {};
      if (userEmail !== undefined) result['userEmail'] = userEmail;
      if (userName !== undefined) result['userName'] = userName;
      return result;
    } catch {
      return {};
    }
  },
};

/**
 * pyproject.toml extractor — project name and dependency keys only.
 */
export const pyprojectTomlExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return basename(absPath) === 'pyproject.toml';
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const lines = raw.split('\n');
      let projectName: string | undefined;
      const deps: string[] = [];
      let inDeps = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!projectName) {
          const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
          if (nameMatch?.[1]) projectName = nameMatch[1];
        }
        if (trimmed === 'dependencies = [') {
          inDeps = true;
          continue;
        }
        if (inDeps) {
          if (trimmed === ']') {
            inDeps = false;
            continue;
          }
          // Extract package name — strip version pins and quotes
          const depMatch = /^"?([A-Za-z0-9_.-]+)/.exec(trimmed.replace(/^"/, ''));
          if (depMatch?.[1]) deps.push(depMatch[1]);
        }
      }
      const result: Record<string, unknown> = {};
      if (projectName !== undefined) result['projectName'] = projectName;
      result['dependencies'] = deps;
      return result;
    } catch {
      return {};
    }
  },
};

/**
 * requirements.txt extractor — package names only, version pins stripped.
 */
export const requirementsTxtExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return basename(absPath) === 'requirements.txt';
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const deps: string[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
        // Strip version pins (==, >=, <=, ~=, !=, >)
        const nameMatch = /^([A-Za-z0-9_.-]+)/.exec(trimmed);
        if (nameMatch?.[1]) deps.push(nameMatch[1]);
      }
      return { dependencies: deps };
    } catch {
      return {};
    }
  },
};

/**
 * Cargo.toml extractor — package name and dependency keys only.
 */
export const cargoTomlExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return basename(absPath) === 'Cargo.toml';
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const lines = raw.split('\n');
      let packageName: string | undefined;
      const deps: string[] = [];
      let inDeps = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!packageName) {
          const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(trimmed);
          if (nameMatch?.[1]) packageName = nameMatch[1];
        }
        if (trimmed === '[dependencies]' || trimmed === '[dev-dependencies]' || trimmed === '[build-dependencies]') {
          inDeps = true;
          continue;
        }
        if (trimmed.startsWith('[') && inDeps) {
          inDeps = false;
        }
        if (inDeps && trimmed && !trimmed.startsWith('#')) {
          const depMatch = /^([A-Za-z0-9_-]+)\s*[=]/.exec(trimmed);
          if (depMatch?.[1]) deps.push(depMatch[1]);
        }
      }
      const result: Record<string, unknown> = {};
      if (packageName !== undefined) result['packageName'] = packageName;
      result['dependencies'] = deps;
      return result;
    } catch {
      return {};
    }
  },
};

/**
 * go.mod extractor — module name and require entries only.
 */
export const goModExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    return basename(absPath) === 'go.mod';
  },
  async extract(absPath: string): Promise<Record<string, unknown>> {
    try {
      const raw = readFileSync(absPath, 'utf8');
      const lines = raw.split('\n');
      let moduleName: string | undefined;
      const requires: string[] = [];
      let inRequire = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!moduleName) {
          const moduleMatch = /^module\s+(\S+)/.exec(trimmed);
          if (moduleMatch?.[1]) moduleName = moduleMatch[1];
        }
        if (trimmed.startsWith('require (')) {
          inRequire = true;
          continue;
        }
        if (inRequire) {
          if (trimmed === ')') {
            inRequire = false;
            continue;
          }
          const reqMatch = /^(\S+)\s/.exec(trimmed);
          if (reqMatch?.[1]) requires.push(reqMatch[1]);
        } else if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
          const reqMatch = /^require\s+(\S+)/.exec(trimmed);
          if (reqMatch?.[1]) requires.push(reqMatch[1]);
        }
      }
      const result: Record<string, unknown> = {};
      if (moduleName !== undefined) result['moduleName'] = moduleName;
      result['requires'] = requires;
      return result;
    } catch {
      return {};
    }
  },
};

/**
 * README.md skip extractor — natural-language content, never extracted.
 */
export const readmeSkipExtractor: FileTypeExtractor = {
  match(absPath: string): boolean {
    const b = basename(absPath).toLowerCase();
    return b === 'readme.md' || b === 'readme.txt' || b === 'readme.rst';
  },
  async extract(_absPath: string): Promise<Record<string, unknown>> {
    // Intentionally returns nothing — content is natural language.
    return {};
  },
};

export const DEFAULT_EXTRACTORS: readonly FileTypeExtractor[] = Object.freeze([
  packageJsonExtractor,
  gitConfigExtractor,
  globalGitConfigExtractor,
  pyprojectTomlExtractor,
  requirementsTxtExtractor,
  cargoTomlExtractor,
  goModExtractor,
  readmeSkipExtractor,
]);

const SKIP_REASON_NATURAL_LANGUAGE = 'natural_language_no_extract';

export function isReadmeFile(absPath: string): boolean {
  return readmeSkipExtractor.match(absPath);
}

export function getSkipReason(absPath: string): string | undefined {
  if (isReadmeFile(absPath)) return SKIP_REASON_NATURAL_LANGUAGE;
  return undefined;
}

/**
 * Extract structured fields from a file. Returns only metadata-level fields.
 * Never reads natural-language text body.
 */
export async function extractFile(
  absPath: string,
  relPath: string,
  rootId: string,
  sizeBytes: number,
  mtimeMs: number,
  extractors: readonly FileTypeExtractor[] = DEFAULT_EXTRACTORS,
): Promise<ExtractedFileMetadata> {
  const base: ExtractedFileMetadata = {
    absPath,
    relPath,
    rootId,
    sizeBytes,
    mtimeMs,
  };

  // Check for README skip first
  if (isReadmeFile(absPath)) {
    return { ...base, skippedReason: SKIP_REASON_NATURAL_LANGUAGE };
  }

  // Try matching extractors
  for (const extractor of extractors) {
    if (extractor.match(absPath)) {
      const fields = await extractor.extract(absPath);
      const mimeType = sniffMimeType(absPath);
      return { ...base, mimeType, structuredFields: fields };
    }
  }

  // Generic fallback — only filename + size + mtime + sniffed mime
  const mimeType = sniffMimeType(absPath);
  return { ...base, mimeType };
}
