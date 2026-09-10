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

export type DocumentAuthoringTier =
  | 'authored_originated'
  | 'authored_edited'
  | 'downloaded_external'
  | 'received_shared'
  | 'unknown_untrusted';

/**
 * Optional, bounded document-memory evidence emitted only by explicit
 * content-memory scans. The normal idle-miner path remains metadata-only.
 *
 * `contentExtracted=false` is a deliberate result for downloaded/received or
 * ambiguous documents: the scanner can preserve the provenance verdict without
 * copying the file body into memory.
 */
export interface DocumentMemoryCandidate {
  title: string;
  excerpt?: string;
  text?: string;
  authoringTier: DocumentAuthoringTier;
  actionProvenance: 'untrusted_external';
  contentExtracted: boolean;
  confidence: number;
  reason: string;
}

/**
 * A raw signal emitted by the idle-miner for downstream capability inference.
 *
 * By default this is metadata-only. Opt-in content-memory scans may attach a
 * bounded, provenance-tagged `documentMemory` candidate; untrusted documents
 * carry provenance metadata but no body text.
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
  documentMemory?: DocumentMemoryCandidate;
  skippedReason?: string;
  extractedAt: Date;
}
