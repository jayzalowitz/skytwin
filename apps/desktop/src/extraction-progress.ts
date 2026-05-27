/**
 * Extraction-progress helper (#383 P2.3).
 *
 * On first launch (and after a version bump) the desktop app extracts
 * `apps.tar.gz` (~45 MB compressed, ~100 MB uncompressed) from the
 * Electron resources path to `<userData>/embedded/`. That takes 5-15s
 * depending on disk + AV scanning. Pre-fix the splash showed a spinner
 * + "Starting up…" — no indication of progress, no upper bound on the
 * pause, no reassurance that anything was happening at all.
 *
 * The Electron wiring in service-manager.ts emits raw counts
 * (filesExtracted, totalFiles); this pure helper turns those into a
 * (percent, phase, label) tuple the splash window renders. Keeping
 * the mapping pure makes it unit-testable without spinning Electron
 * or a real tar process.
 *
 * Why file-count instead of bytes:
 *   System `tar -xzvf` prints one stdout line per extracted entry,
 *   which gives us a cheap newline-counter for progress. Real byte
 *   progress would require either a custom node-tar pipeline (extra
 *   dep, extra surface area) or polling `du -sb` on the extracted
 *   tree every tick (more syscalls, platform-specific flags). File
 *   count diverges from bytes on a heterogeneous tarball — the first
 *   10% of files might be 30% of bytes if the small files cluster at
 *   the start — but the UI difference is invisible at human speed
 *   and the phase labels carry the qualitative reassurance the user
 *   actually reads.
 */

/** The three discrete phases the splash window shows. */
export type ExtractionPhase = 'unpacking' | 'almost-ready' | 'ready';

export interface ExtractionProgress {
  /** Integer 0-100, monotonically non-decreasing across a run. */
  percent: number;
  /** Bucket the splash uses to pick the label + colour. */
  phase: ExtractionPhase;
  /** Plain-English line under the bar. */
  label: string;
}

/**
 * Map a (filesExtracted, totalFiles) pair into the wire shape the
 * splash consumes. Robust to:
 *   - totalFiles = 0 (degenerate tarball / counter failed) → 0% / unpacking
 *   - filesExtracted > totalFiles (counter overshoots; bsdtar prints
 *     trailing junk on some platforms) → clamped at 99% until the
 *     caller flips to "done"
 *   - negative inputs → clamped at 0
 *
 * The 99% ceiling is intentional: the splash promotes to 100% / "ready"
 * only when the caller knows tar exited cleanly. A premature 100% from
 * counting alone would land the user on a black screen if the tar
 * process is still flushing the final files.
 */
export function extractionProgress(
  filesExtracted: number,
  totalFiles: number,
): ExtractionProgress {
  if (!Number.isFinite(filesExtracted) || filesExtracted < 0) filesExtracted = 0;
  if (!Number.isFinite(totalFiles) || totalFiles <= 0) {
    return { percent: 0, phase: 'unpacking', label: 'Unpacking SkyTwin (45 MB)…' };
  }
  const raw = Math.floor((filesExtracted / totalFiles) * 100);
  const percent = Math.max(0, Math.min(99, raw));
  if (percent < 30) {
    return { percent, phase: 'unpacking', label: 'Unpacking SkyTwin (45 MB)…' };
  }
  return { percent, phase: 'almost-ready', label: 'Almost ready…' };
}

/** Terminal state: tar exited cleanly. Always 100% / "Ready!". */
export function extractionDone(): ExtractionProgress {
  return { percent: 100, phase: 'ready', label: 'Ready!' };
}
