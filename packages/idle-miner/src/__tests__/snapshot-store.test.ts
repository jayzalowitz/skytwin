import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotFileStore } from '../snapshot-store.js';
import type { FileIndexEntry, ScanCursor } from '../types.js';

const SNAPSHOT = 'idle-miner-index.json';

// A large debounce so the auto-flush timer never fires mid-test — every test
// drives persistence explicitly via flush()/close().
const NO_AUTO_FLUSH = { flushDelayMs: 1_000_000 };

const entry = (over: Partial<FileIndexEntry> = {}): FileIndexEntry => ({
  rootId: 'root1',
  relativePath: 'a/b.ts',
  mtimeMs: 100,
  sizeBytes: 42,
  ...over,
});

const cursor = (over: Partial<ScanCursor> = {}): ScanCursor => ({
  lastVisitedPath: 'a/b.ts',
  offsetInDir: 3,
  ...over,
});

describe('SnapshotFileStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idle-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a file index entry (upsert → lookup)', async () => {
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    expect(await store.lookup('root1', 'a/b.ts')).toBeNull();
    await store.upsert(entry({ contentHash: 'deadbeef' }));
    expect(await store.lookup('root1', 'a/b.ts')).toMatchObject({ sizeBytes: 42, contentHash: 'deadbeef' });
  });

  it('round-trips a scan cursor (save → load) and isolates by rootId', async () => {
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    expect(await store.load('root1')).toBeNull();
    await store.save('root1', cursor({ offsetInDir: 7 }));
    expect(await store.load('root1')).toEqual(cursor({ offsetInDir: 7 }));
    expect(await store.load('root2')).toBeNull();
  });

  it('does not collide two distinct (rootId, relativePath) pairs', async () => {
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    await store.upsert(entry({ rootId: 'a', relativePath: 'b/c', sizeBytes: 1 }));
    await store.upsert(entry({ rootId: 'a/b', relativePath: 'c', sizeBytes: 2 }));
    expect((await store.lookup('a', 'b/c'))?.sizeBytes).toBe(1);
    expect((await store.lookup('a/b', 'c'))?.sizeBytes).toBe(2);
  });

  it('PERSISTS across instances after flush (the load-bearing property — no re-emit on restart)', async () => {
    const a = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    await a.upsert(entry({ relativePath: 'persist.ts', mtimeMs: 999 }));
    await a.save('root1', cursor({ lastVisitedPath: 'persist.ts' }));
    a.flush();

    const b = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    expect(await b.lookup('root1', 'persist.ts')).toMatchObject({ mtimeMs: 999 });
    expect(await b.load('root1')).toMatchObject({ lastVisitedPath: 'persist.ts' });
  });

  it('does NOT leak unflushed mutations to a new instance (flush is required to persist)', async () => {
    const a = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    await a.upsert(entry({ relativePath: 'unflushed.ts' }));
    // no flush()
    const b = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    expect(await b.lookup('root1', 'unflushed.ts')).toBeNull();
  });

  it('close() flushes pending mutations', async () => {
    const a = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    await a.upsert(entry({ relativePath: 'closed.ts' }));
    a.close();
    const b = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    expect(await b.lookup('root1', 'closed.ts')).not.toBeNull();
  });

  it('flush writes atomically (no lingering .tmp; snapshot is valid JSON)', async () => {
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    await store.upsert(entry());
    store.flush();
    expect(existsSync(join(dir, `${SNAPSHOT}.tmp`))).toBe(false);
    const parsed = JSON.parse(readFileSync(join(dir, SNAPSHOT), 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.files).toHaveLength(1);
  });

  it('starts fresh (no throw) when the snapshot on disk is corrupt', async () => {
    writeFileSync(join(dir, SNAPSHOT), '{ this is not valid json', 'utf8');
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    expect(await store.lookup('root1', 'a/b.ts')).toBeNull();
    // and is still usable
    await store.upsert(entry({ relativePath: 'recovered.ts' }));
    expect(await store.lookup('root1', 'recovered.ts')).not.toBeNull();
  });

  it('ignores AND quarantines a snapshot from an incompatible schema version (no silent data loss on downgrade)', async () => {
    writeFileSync(
      join(dir, SNAPSHOT),
      JSON.stringify({ version: 999, files: [entry({ relativePath: 'future.ts' })], cursors: {} }),
      'utf8',
    );
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    // Not loaded...
    expect(await store.lookup('root1', 'future.ts')).toBeNull();
    // ...and the newer snapshot was moved aside, not left to be overwritten.
    expect(existsSync(join(dir, `${SNAPSHOT}.v999.bak`))).toBe(true);

    // A subsequent v1 write must not clobber the quarantined newer data.
    await store.upsert(entry({ relativePath: 'now.ts' }));
    store.flush();
    expect(existsSync(join(dir, `${SNAPSHOT}.v999.bak`))).toBe(true);
    const backup = JSON.parse(readFileSync(join(dir, `${SNAPSHOT}.v999.bak`), 'utf8'));
    expect(backup.version).toBe(999);
  });

  it('defensively copies at the boundary — mutating a returned/passed object cannot diverge stored state', async () => {
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    const passed = entry({ relativePath: 'alias.ts', sizeBytes: 1 });
    await store.upsert(passed);
    passed.sizeBytes = 9999; // mutate the object we passed in

    const got = await store.lookup('root1', 'alias.ts');
    expect(got?.sizeBytes).toBe(1); // store kept its own copy
    got!.sizeBytes = 7777; // mutate the object we got back

    const again = await store.lookup('root1', 'alias.ts');
    expect(again?.sizeBytes).toBe(1); // still pristine
  });

  it('flush is a no-op when nothing changed (no write amplification)', async () => {
    const store = new SnapshotFileStore(dir, NO_AUTO_FLUSH);
    await store.upsert(entry());
    store.flush();
    const firstMtime = readFileSync(join(dir, SNAPSHOT), 'utf8');
    store.flush(); // nothing changed since
    expect(readFileSync(join(dir, SNAPSHOT), 'utf8')).toBe(firstMtime);
  });
});
