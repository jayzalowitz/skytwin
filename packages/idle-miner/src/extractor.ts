import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DocumentMemoryCandidate } from '@skytwin/shared-types';

export interface ExtractedFileMetadata {
  absPath: string;
  relPath: string;
  rootId: string;
  sizeBytes: number;
  mtimeMs: number;
  mimeType?: string;
  contentHash?: Buffer;
  structuredFields?: Record<string, unknown>;
  documentMemory?: DocumentMemoryCandidate;
  skippedReason?: string;
}

export interface FileTypeExtractor {
  match(absPath: string): boolean;
  extract(absPath: string): Promise<Record<string, unknown>>;
}

export interface DocumentContentExtractionOptions {
  enabled?: boolean;
  /**
   * Roots the user explicitly treats as their own authored material. Content
   * extraction is denied unless the file falls under one of these roots.
   */
  authoredRoots?: readonly string[];
  /** Max bytes to read from a candidate document. Default: 128 KiB. */
  maxBytes?: number;
}

export interface ExtractFileOptions {
  documentContent?: DocumentContentExtractionOptions;
}

const MIME_MAGIC: Array<{ magic: Buffer; mime: string }> = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' },
  { magic: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' },
  { magic: Buffer.from([0x47, 0x49, 0x46]), mime: 'image/gif' },
  { magic: Buffer.from([0x25, 0x50, 0x44, 0x46]), mime: 'application/pdf' },
  { magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]), mime: 'application/zip' },
];

const DEFAULT_DOCUMENT_MAX_BYTES = 128 * 1024;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);
const SECRET_CONTENT_RE = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private key|password)\b/i;

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

function lowerExt(absPath: string): string {
  const base = basename(absPath).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

function isDocumentMemoryCandidate(absPath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(lowerExt(absPath));
}

function isUnderRoot(absPath: string, root: string): boolean {
  const file = resolve(absPath);
  const base = resolve(root);
  return file === base || file.startsWith(`${base}/`);
}

function isDownloadedPath(absPath: string): boolean {
  return /(^|\/)Downloads(\/|$)/.test(absPath.replace(/\\/g, '/'));
}

function hasMacWhereFroms(absPath: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const out = execFileSync('xattr', ['-p', 'com.apple.metadata:kMDItemWhereFroms', absPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function firstHeading(lines: string[], fallback: string): string {
  for (const line of lines) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim().slice(0, 120);
  }
  return fallback;
}

function extractReadableExcerpt(raw: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) continue;
    if (line === '---' || line === '+++' || line.startsWith('<!--')) continue;
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^[-*+]\s+\[[ x]\]/i.test(line)) lines.push(line.replace(/^[-*+]\s+\[[ x]\]\s*/i, ''));
    else lines.push(line.replace(/^[-*+]\s+/, ''));
    if (lines.join(' ').length >= 900 || lines.length >= 8) break;
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export function extractDocumentMemoryCandidate(
  absPath: string,
  relPath: string,
  sizeBytes: number,
  options: DocumentContentExtractionOptions = {},
): DocumentMemoryCandidate | undefined {
  if (!options.enabled) return undefined;
  if (!isDocumentMemoryCandidate(absPath)) return undefined;

  const title = basename(relPath);
  const downloaded = isDownloadedPath(absPath) || hasMacWhereFroms(absPath);
  if (downloaded) {
    return {
      title,
      authoringTier: 'downloaded_external',
      actionProvenance: 'untrusted_external',
      contentExtracted: false,
      confidence: 0.95,
      reason: 'downloaded_or_where_froms',
    };
  }

  const authoredRoots = options.authoredRoots ?? [];
  const authored = authoredRoots.some((root) => isUnderRoot(absPath, root));
  if (!authored) {
    return {
      title,
      authoringTier: 'unknown_untrusted',
      actionProvenance: 'untrusted_external',
      contentExtracted: false,
      confidence: 0.4,
      reason: 'outside_authored_roots',
    };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_DOCUMENT_MAX_BYTES;
  if (sizeBytes > maxBytes) {
    return {
      title,
      authoringTier: 'authored_originated',
      actionProvenance: 'untrusted_external',
      contentExtracted: false,
      confidence: 0.8,
      reason: 'document_too_large',
    };
  }

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return {
      title,
      authoringTier: 'authored_originated',
      actionProvenance: 'untrusted_external',
      contentExtracted: false,
      confidence: 0.8,
      reason: 'read_failed',
    };
  }

  if (SECRET_CONTENT_RE.test(raw)) {
    return {
      title,
      authoringTier: 'authored_originated',
      actionProvenance: 'untrusted_external',
      contentExtracted: false,
      confidence: 0.8,
      reason: 'secret_like_content',
    };
  }

  const lines = raw.split(/\r?\n/);
  const extractedTitle = firstHeading(lines, title);
  const excerpt = extractReadableExcerpt(raw);
  if (!excerpt) {
    return {
      title: extractedTitle,
      authoringTier: 'authored_originated',
      actionProvenance: 'untrusted_external',
      contentExtracted: false,
      confidence: 0.8,
      reason: 'no_readable_text',
    };
  }

  return {
    title: extractedTitle,
    excerpt,
    text: `${extractedTitle}: ${excerpt}`.slice(0, 1200),
    authoringTier: 'authored_originated',
    actionProvenance: 'untrusted_external',
    contentExtracted: true,
    confidence: 0.85,
    reason: 'under_authored_root',
  };
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
  options: ExtractFileOptions = {},
): Promise<ExtractedFileMetadata> {
  const base: ExtractedFileMetadata = {
    absPath,
    relPath,
    rootId,
    sizeBytes,
    mtimeMs,
  };

  const documentMemory = extractDocumentMemoryCandidate(
    absPath,
    relPath,
    sizeBytes,
    options.documentContent,
  );
  if (documentMemory) {
    const mimeType = sniffMimeType(absPath);
    return { ...base, mimeType, documentMemory };
  }

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
