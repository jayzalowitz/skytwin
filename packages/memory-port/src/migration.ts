import type { MemoryPort } from './port.js';
import type {
  MemoryRecord,
  RawSignal,
  KnowledgeEntity,
  KnowledgeTriple,
  Episode,
} from './types.js';

/**
 * exportAllStream yields all records from a port in deterministic order:
 *   1. signals — chronological (timestamp ascending)
 *   2. entities — alphabetical by name
 *   3. triples — lexicographic by subject, then predicate, then object
 *   4. episodes — chronological (startedAt ascending)
 *
 * The ordering guarantee is intentional: importers that process records in
 * stream order will write entities before triples that reference them, and
 * episodes after all signals they might reference.
 */
export async function* exportAllStream(port: MemoryPort): AsyncIterable<MemoryRecord> {
  // We gather each category by using the port's export primitive which
  // streams MemoryRecord. We buffer per-kind to sort deterministically.
  const signals: Array<MemoryRecord & { kind: 'signal' }> = [];
  const entities: Array<MemoryRecord & { kind: 'entity' }> = [];
  const triples: Array<MemoryRecord & { kind: 'triple' }> = [];
  const episodes: Array<MemoryRecord & { kind: 'episode' }> = [];

  for await (const record of port.exportAll()) {
    switch (record.kind) {
      case 'signal': signals.push(record as MemoryRecord & { kind: 'signal' }); break;
      case 'entity': entities.push(record as MemoryRecord & { kind: 'entity' }); break;
      case 'triple': triples.push(record as MemoryRecord & { kind: 'triple' }); break;
      case 'episode': episodes.push(record as MemoryRecord & { kind: 'episode' }); break;
    }
  }

  // Sort signals chronologically
  signals.sort((a, b) => {
    const aTs = (a.payload as { timestamp: Date }).timestamp;
    const bTs = (b.payload as { timestamp: Date }).timestamp;
    return aTs.getTime() - bTs.getTime();
  });

  // Sort entities alphabetically by name
  entities.sort((a, b) => {
    const aName = (a.payload as { name: string }).name;
    const bName = (b.payload as { name: string }).name;
    return aName.localeCompare(bName);
  });

  // Sort triples lexicographically: subject → predicate → object
  triples.sort((a, b) => {
    const ap = a.payload as { subject: string; predicate: string; object: string };
    const bp = b.payload as { subject: string; predicate: string; object: string };
    const subjectCmp = ap.subject.localeCompare(bp.subject);
    if (subjectCmp !== 0) return subjectCmp;
    const predicateCmp = ap.predicate.localeCompare(bp.predicate);
    if (predicateCmp !== 0) return predicateCmp;
    return ap.object.localeCompare(bp.object);
  });

  // Sort episodes chronologically by startedAt
  episodes.sort((a, b) => {
    const aStart = (a.payload as { startedAt: Date }).startedAt;
    const bStart = (b.payload as { startedAt: Date }).startedAt;
    return aStart.getTime() - bStart.getTime();
  });

  yield* signals;
  yield* entities;
  yield* triples;
  yield* episodes;
}

/**
 * importAllStream consumes records from a stream and writes them via the port.
 * Duplicate-id errors are swallowed and counted as skipped (idempotent).
 * Returns a count of imported and skipped records.
 */
export async function importAllStream(
  port: MemoryPort,
  records: AsyncIterable<MemoryRecord>,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for await (const record of records) {
    try {
      switch (record.kind) {
        case 'signal':
          await port.recordSignal(record.payload as RawSignal);
          break;
        case 'entity':
          await port.recordEntity(record.payload as KnowledgeEntity);
          break;
        case 'triple':
          await port.recordTriple(record.payload as KnowledgeTriple);
          break;
        case 'episode':
          await port.recordEpisode(record.payload as Episode);
          break;
      }
      imported++;
    } catch (err: unknown) {
      // Treat duplicate-id errors as skipped; re-throw anything unexpected.
      if (isDuplicateError(err)) {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  return { imported, skipped };
}

/**
 * Heuristic detection for duplicate-key / conflict errors from any storage
 * backend. Inspects the error message for common patterns.
 */
function isDuplicateError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('duplicate') ||
    msg.includes('already exists') ||
    msg.includes('unique constraint') ||
    msg.includes('conflict') ||
    msg.includes('unique_violation')
  );
}
