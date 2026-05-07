import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { generateId } from '@skytwin/core';
import { isDenied } from './denylist.js';
import { extractFile } from './extractor.js';
import type { ResourceGovernorPort } from './governor.js';
import type { FileTypeExtractor } from './extractor.js';
import type { RawSignal, FsScanRoot } from './types.js';
import type { FileIndexRepo, CursorRepo, ScanCursor } from './types.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const CONTENT_HASH_MAX_BYTES = 256 * 1024; // 256 KB
const YIELD_SLEEP_MS = 100;

export interface MinerOptions {
  roots: FsScanRoot[];
  governor: ResourceGovernorPort;
  extractors: readonly FileTypeExtractor[];
  signalEmitter: (signal: RawSignal) => Promise<void>;
  homedir: string;
  fileIndexRepo: FileIndexRepo;
  cursorRepo: CursorRepo;
  userId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeContentHash(absPath: string, sizeBytes: number): Buffer | undefined {
  if (sizeBytes > CONTENT_HASH_MAX_BYTES) return undefined;
  try {
    const data = readFileSync(absPath);
    return createHash('sha256').update(data).digest();
  } catch {
    return undefined;
  }
}

async function yieldIfNeeded(governor: ResourceGovernorPort): Promise<void> {
  while (governor.shouldYield()) {
    await sleep(YIELD_SLEEP_MS);
  }
}

export class IdleMiner {
  private readonly opts: MinerOptions;
  private running = false;

  constructor(opts: MinerOptions) {
    this.opts = opts;
  }

  async scanBatch(): Promise<void> {
    this.running = true;
    try {
      for (const root of this.opts.roots) {
        if (!root.enabled) continue;
        await this.scanRoot(root);
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.running = false;
  }

  private async scanRoot(root: FsScanRoot): Promise<void> {
    const cursor = await this.opts.cursorRepo.load(root.id);
    const queue: string[] = [root.rootPath];
    let resumeReached = cursor === null;

    while (queue.length > 0 && this.running) {
      const dir = queue.shift();
      if (dir === undefined) break;

      // Resume from cursor
      if (!resumeReached) {
        if (dir === cursor?.lastVisitedPath) {
          resumeReached = true;
        } else {
          // Still need to find cursor position
          resumeReached = false;
        }
      }

      if (this.opts.governor.shouldYield()) {
        // Save cursor and yield
        await this.saveCursor(root.id, dir, cursor);
        await sleep(YIELD_SLEEP_MS);
        // Re-check after yield
        while (this.opts.governor.shouldYield()) {
          await sleep(YIELD_SLEEP_MS);
        }
      }

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!this.running) return;

        const absPath = join(dir, entry);

        // Denylist check
        if (isDenied(absPath, this.opts.homedir)) {
          continue;
        }

        let stat;
        try {
          stat = statSync(absPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          queue.push(absPath);
          continue;
        }

        if (!stat.isFile()) continue;

        // Skip files > 4 MB
        if (stat.size > MAX_FILE_BYTES) continue;

        const relPath = relative(root.rootPath, absPath);
        const mtimeMs = stat.mtimeMs;
        const sizeBytes = stat.size;

        // Hash-dedupe against file index
        const indexed = await this.opts.fileIndexRepo.lookup(root.id, relPath);
        if (
          indexed !== null &&
          indexed.mtimeMs === mtimeMs &&
          indexed.sizeBytes === sizeBytes
        ) {
          // Unchanged — skip extraction
          continue;
        }

        // Yield check between each file
        await yieldIfNeeded(this.opts.governor);
        if (!this.running) return;

        // Extract metadata
        const extracted = await extractFile(
          absPath,
          relPath,
          root.id,
          sizeBytes,
          mtimeMs,
          this.opts.extractors,
        );

        // Report bytes to governor
        this.opts.governor.reportBytesRead(sizeBytes);

        // Compute content hash for small files (not for skipped files)
        let contentHash: Buffer | undefined;
        if (!extracted.skippedReason) {
          contentHash = computeContentHash(absPath, sizeBytes);
        }

        // Upsert file index
        await this.opts.fileIndexRepo.upsert({
          rootId: root.id,
          relativePath: relPath,
          mtimeMs,
          sizeBytes,
          contentHash: contentHash?.toString('hex'),
        });

        // Emit signal
        const signal: RawSignal = {
          id: generateId(),
          userId: this.opts.userId,
          rootId: root.id,
          absPath,
          relPath,
          sizeBytes,
          mtimeMs,
          mimeType: extracted.mimeType,
          contentHash: contentHash?.toString('hex'),
          structuredFields: extracted.structuredFields,
          skippedReason: extracted.skippedReason,
          extractedAt: new Date(),
        };

        await this.opts.signalEmitter(signal);
      }

      // Save cursor after processing each directory
      await this.saveCursor(root.id, dir, cursor);
    }
  }

  private async saveCursor(
    rootId: string,
    lastDir: string,
    _prev: ScanCursor | null,
  ): Promise<void> {
    const cursor: ScanCursor = {
      lastVisitedPath: lastDir,
      offsetInDir: 0,
    };
    await this.opts.cursorRepo.save(rootId, cursor);
  }
}
