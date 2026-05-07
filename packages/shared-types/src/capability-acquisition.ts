/**
 * Types for the Capability Acquisition Loop (#195).
 * Idle-miner output, fs scan roots, and related signal shapes.
 */

/**
 * A single scan root record (mirrors fs_scan_roots table shape).
 */
export interface FsScanRoot {
  id: string;
  userId: string;
  rootPath: string;
  enabled: boolean;
  source: 'fs' | 'browser_history';
  lastScanAt?: Date;
  lastScanCompleted: boolean;
  resumeCursor?: string;
  bytesToday: number;
  bytesTotal: number;
  filesTotal: number;
  rollingDayStartedAt: string; // ISO date string
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A raw signal emitted by the idle-miner for downstream capability inference.
 *
 * Metadata only — never file body content. See docs/architecture-philosophy.md
 * "Hard rails (deterministic for SAFETY)".
 */
export interface RawSignal {
  id: string;
  userId: string;
  rootId: string;
  absPath: string;
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  mimeType?: string;
  contentHash?: string;
  structuredFields?: Record<string, unknown>;
  skippedReason?: string;
  extractedAt: Date;
}
