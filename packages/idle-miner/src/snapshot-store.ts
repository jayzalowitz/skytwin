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

// Distinguishes temp files when more than one store (a second process, or a
// second instance in the same process) points at the same directory, so
// concurrent flushes can't clobber each other's temp file and rename a
// half-written snapshot into place. One store per dir is the intended use; this
// is cheap insurance against misuse.
let instanceCounter = 0;

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
  private readonly tmpPath: string;
  private readonly flushDelayMs: number;
  // In-memory index + cursors. Size is bounded by the number of scanned files;
  // `flush()` serializes the whole map synchronously, but the debounce coalesces
  // a burst of upserts into one write per window, so churn doesn't flush
  // per-file. For very large trees (hundreds of thousands of files) prefer a
  // streaming / SQLite-backed repo (see docs/idle-miner-desktop-integration.md);
  // this snapshot store is the simple default for the typical allowlist.
  private readonly files = new Map<string, FileIndexEntry>();
  private readonly cursors = new Map<string, ScanCursor>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private loaded = false;

  constructor(dir: string, options: SnapshotFileStoreOptions = {}) {
    this.snapshotPath = join(dir, SNAPSHOT_FILENAME);
    this.tmpPath = `${this.snapshotPath}.${process.pid}.${++instanceCounter}.tmp`;
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
      // A snapshot from a DIFFERENT schema version (e.g. a newer one left by a
      // version we then downgraded from) is not loaded — but it must NOT be
      // silently overwritten by our v1 on the next flush, which would discard the
      // newer data permanently. Quarantine it aside so it survives, then start
      // fresh (cost: one re-scan, which is safe).
      if (parsed.version !== SNAPSHOT_VERSION) {
        try {
          renameSync(this.snapshotPath, `${this.snapshotPath}.v${String(parsed.version ?? 'unknown')}.bak`);
        } catch {
          // Best-effort; if we can't move it we at least haven't loaded it.
        }
        return;
      }
      for (const entry of parsed.files ?? []) {
        if (entry && typeof entry.rootId === 'string' && typeof entry.relativePath === 'string') {
          // Stored object is owned by the store (parsed fresh from JSON, no
          // caller alias), so no copy needed on load.
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

  // The four repo methods defensively copy at the boundary: stored values are
  // cloned on the way in (upsert/save) and on the way out (lookup/load) so a
  // caller mutating an object it passed or received can't silently diverge the
  // in-memory state from what the repo calls recorded. The entries are flat
  // (primitive fields), so a shallow spread is a full copy.

  async lookup(rootId: string, relativePath: string): Promise<FileIndexEntry | null> {
    this.ensureLoaded();
    const found = this.files.get(fileKey(rootId, relativePath));
    return found ? { ...found } : null;
  }

  async upsert(entry: FileIndexEntry): Promise<void> {
    this.ensureLoaded();
    this.files.set(fileKey(entry.rootId, entry.relativePath), { ...entry });
    this.markDirty();
  }

  async load(rootId: string): Promise<ScanCursor | null> {
    this.ensureLoaded();
    const found = this.cursors.get(rootId);
    return found ? { ...found } : null;
  }

  async save(rootId: string, cursor: ScanCursor): Promise<void> {
    this.ensureLoaded();
    this.cursors.set(rootId, { ...cursor });
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
    try {
      // Instance-unique temp name so two stores sharing a dir can't clobber each
      // other's temp file mid-write. rename() is atomic within one filesystem.
      // We deliberately do NOT fsync the temp file or parent dir: a power-loss
      // window can lose the most recent flush, but the file index is fully
      // reconstructible (the loss costs a re-scan of those files), so the fsync
      // latency on every flush isn't worth it for this data.
      writeFileSync(this.tmpPath, JSON.stringify(snapshot), 'utf8');
      renameSync(this.tmpPath, this.snapshotPath);
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
