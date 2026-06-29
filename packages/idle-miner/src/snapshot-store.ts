import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CursorRepo, FileIndexEntry, FileIndexRepo, ScanCursor } from './types.js';

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILENAME = 'idle-miner-index.json';
const DEFAULT_FLUSH_DELAY_MS = 5_000;

function fileKey(rootId: string, relativePath: string): string {
  // JSON-encoded pair: unambiguous, so no two distinct (rootId, relativePath)
  // pairs can ever collide onto the same key.
  return JSON.stringify([rootId, relativePath]);
}

interface Snapshot {
  version: number;
  files: FileIndexEntry[];
  cursors: Record<string, ScanCursor>;
}

export interface SnapshotFileStoreOptions {
  /** Debounce window before an in-memory mutation is flushed to disk (ms). */
  flushDelayMs?: number;
}

/**
 * Device-local persistence for the idle-miner's file index + scan cursor —
 * implements both `FileIndexRepo` and `CursorRepo` over a single JSON snapshot.
 *
 * Why it exists: `MinerOptions` requires a `fileIndexRepo` and a `cursorRepo`,
 * but the package shipped no concrete implementation, so every host had to write
 * one before it could run the miner at all. This is the sensible default.
 *
 * Why device-local (and NOT a shared DB like CockroachDB): a file index is
 * per-machine state — "which files on THIS device have I already scanned". A
 * shared index would let one paired device suppress scans on another, which have
 * entirely different files.
 *
 * Why persistence is load-bearing, not an optimization: the signal pipeline does
 * not content-dedup, so without a durable index a host restart re-emits every
 * scanned file as a fresh signal. An in-memory-only repo floods downstream on
 * every restart and is not viable for a real deployment.
 *
 * Durability model: reads/writes are in-memory; the snapshot is flushed on a
 * debounce and on `close()`, written atomically (write-temp + rename) so a crash
 * mid-write can never corrupt the index. The worst a crash can cost is the loss
 * of the last unflushed window — a re-scan of those files, never corruption.
 *
 * The storage directory is injected so the host owns the path (an Electron
 * `userData` dir, a managed child process's data dir, …) and tests point at a
 * temp dir.
 */
export class SnapshotFileStore implements FileIndexRepo, CursorRepo {
  private readonly snapshotPath: string;
  private readonly flushDelayMs: number;
  private readonly files = new Map<string, FileIndexEntry>();
  private readonly cursors = new Map<string, ScanCursor>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private loaded = false;

  constructor(dir: string, options: SnapshotFileStoreOptions = {}) {
    this.snapshotPath = join(dir, SNAPSHOT_FILENAME);
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort: a genuinely unwritable dir surfaces on the first flush.
    }
  }

  /** Lazy-load the snapshot on first access so construction never throws. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.snapshotPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as Partial<Snapshot>;
      // An incompatible schema version is discarded rather than misread — the
      // cost is one full re-scan, which is safe.
      if (parsed.version !== SNAPSHOT_VERSION) return;
      for (const entry of parsed.files ?? []) {
        if (entry && typeof entry.rootId === 'string' && typeof entry.relativePath === 'string') {
          this.files.set(fileKey(entry.rootId, entry.relativePath), entry);
        }
      }
      for (const [rootId, cursor] of Object.entries(parsed.cursors ?? {})) {
        if (cursor && typeof cursor.lastVisitedPath === 'string') {
          this.cursors.set(rootId, cursor);
        }
      }
    } catch {
      // Corrupt / partially-written JSON → start from an empty index. Worst case
      // is a full re-scan; never a crash.
      this.files.clear();
      this.cursors.clear();
    }
  }

  async lookup(rootId: string, relativePath: string): Promise<FileIndexEntry | null> {
    this.ensureLoaded();
    return this.files.get(fileKey(rootId, relativePath)) ?? null;
  }

  async upsert(entry: FileIndexEntry): Promise<void> {
    this.ensureLoaded();
    this.files.set(fileKey(entry.rootId, entry.relativePath), entry);
    this.markDirty();
  }

  async load(rootId: string): Promise<ScanCursor | null> {
    this.ensureLoaded();
    return this.cursors.get(rootId) ?? null;
  }

  async save(rootId: string, cursor: ScanCursor): Promise<void> {
    this.ensureLoaded();
    this.cursors.set(rootId, cursor);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDelayMs);
    // Don't keep the host process alive solely to flush the index.
    this.flushTimer.unref?.();
  }

  /**
   * Write the current snapshot to disk atomically. A no-op when nothing changed
   * since the last flush. Never throws — a failed write leaves the store dirty
   * so a later flush retries.
   */
  flush(): void {
    if (!this.dirty) return;
    const snapshot: Snapshot = {
      version: SNAPSHOT_VERSION,
      files: [...this.files.values()],
      cursors: Object.fromEntries(this.cursors),
    };
    const tmpPath = `${this.snapshotPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8');
      renameSync(tmpPath, this.snapshotPath); // atomic within one filesystem
      this.dirty = false;
    } catch {
      // Keep dirty=true; the next markDirty/close flush retries.
    }
  }

  /** Flush any pending changes and cancel the debounce timer. Call on shutdown. */
  close(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
