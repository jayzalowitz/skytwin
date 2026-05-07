import type { FsScanRoot, RawSignal } from '@skytwin/shared-types';

export type { FsScanRoot, RawSignal };

export interface ScanCursor {
  lastVisitedPath: string;
  offsetInDir: number;
}

export interface FileIndexEntry {
  rootId: string;
  relativePath: string;
  mtimeMs: number;
  sizeBytes: number;
  contentHash?: string;
}

export interface FileIndexRepo {
  lookup(rootId: string, relativePath: string): Promise<FileIndexEntry | null>;
  upsert(entry: FileIndexEntry): Promise<void>;
}

export interface CursorRepo {
  load(rootId: string): Promise<ScanCursor | null>;
  save(rootId: string, cursor: ScanCursor): Promise<void>;
}
