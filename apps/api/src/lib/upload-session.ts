/**
 * Resumable chunked-upload session store (#386 P2.2 voice upload).
 *
 * A 2-minute voice memo is ~3MB on the wire as base64. On flaky
 * cellular the single POST drops mid-flight with no resume. This store
 * lets a client open a session, push fixed-size base64 chunks (in any
 * order, retrying individual chunks), and finalize once every chunk has
 * landed — at which point the chunks are concatenated in index order
 * into the original base64 payload.
 *
 * Chunks are base64 STRING slices, not binary. The client already holds
 * the recording as a base64 string (expo-file-system `File.base64()`),
 * so slicing the string and concatenating it back in order avoids any
 * binary framing / per-chunk alignment concern — the full string is
 * decoded exactly once, at finalize.
 *
 * State is in-memory and ephemeral by design (sessions live ~10min via
 * TTL sweep); a process restart drops in-flight uploads and the client
 * re-records. No persistence — see the issue's rollback note.
 *
 * The store takes a `now()` clock so tests drive TTL deterministically
 * without real timers.
 */

export interface UploadSessionMeta {
  userId: string;
  totalChunks: number;
  language?: string;
}

export interface ChunkAck {
  received: number;
  total: number;
  /** Indices not yet received, ascending. Empty ⇒ ready to finalize. */
  missing: number[];
}

interface Session {
  userId: string;
  totalChunks: number;
  language?: string;
  chunks: Map<number, string>;
  createdAt: number;
  lastTouchedAt: number;
}

export interface UploadSessionStoreOptions {
  /** Session idle TTL in ms (since last chunk). Default 10 minutes. */
  ttlMs?: number;
  /** Max total base64 length across all chunks. Default ~33MB (25MB binary). */
  maxTotalBase64?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
// 25MB binary ≈ ceil(25MB * 4/3) base64 chars — matches the transcribe
// route's MAX_AUDIO_BYTES so the chunked path can't smuggle a bigger
// payload past the single-shot limit.
const DEFAULT_MAX_BASE64 = Math.ceil((25 * 1024 * 1024 * 4) / 3);

export type OpenResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: 'invalid_total'; message: string };

export type AddChunkResult =
  | { ok: true; ack: ChunkAck }
  | { ok: false; code: 'no_session' | 'bad_index' | 'too_large' | 'not_base64'; message: string };

export type FinalizeResult =
  | { ok: true; base64: string; meta: UploadSessionMeta }
  | { ok: false; code: 'no_session' | 'incomplete'; message: string; missing?: number[] };

export class UploadSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly maxTotalBase64: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(opts: UploadSessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxTotalBase64 = opts.maxTotalBase64 ?? DEFAULT_MAX_BASE64;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Deterministic, collision-free id without Math.random (which is
   * banned in some runtimes here) — userId-scoped monotonic counter +
   * timestamp. Not a security token; ownership is enforced by the route
   * middleware, this only needs to be unique per process.
   */
  private mintId(userId: string): string {
    this.seq += 1;
    return `up_${this.now().toString(36)}_${this.seq.toString(36)}_${userId.slice(0, 8)}`;
  }

  open(meta: UploadSessionMeta): OpenResult {
    this.sweep();
    if (
      !Number.isInteger(meta.totalChunks) ||
      meta.totalChunks <= 0 ||
      meta.totalChunks > 100_000
    ) {
      return { ok: false, code: 'invalid_total', message: 'totalChunks must be a positive integer' };
    }
    const sessionId = this.mintId(meta.userId);
    const t = this.now();
    const session: Session = {
      userId: meta.userId,
      totalChunks: meta.totalChunks,
      chunks: new Map(),
      createdAt: t,
      lastTouchedAt: t,
    };
    if (meta.language !== undefined) session.language = meta.language;
    this.sessions.set(sessionId, session);
    return { ok: true, sessionId };
  }

  private currentBase64Length(session: Session): number {
    let total = 0;
    for (const part of session.chunks.values()) total += part.length;
    return total;
  }

  addChunk(sessionId: string, userId: string, index: number, chunkBase64: string): AddChunkResult {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      return { ok: false, code: 'no_session', message: 'upload session not found or expired' };
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      return { ok: false, code: 'bad_index', message: `index must be in [0, ${session.totalChunks})` };
    }
    if (typeof chunkBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunkBase64)) {
      return { ok: false, code: 'not_base64', message: 'chunk must be base64' };
    }
    // Size guard: only count toward the cap if this is a NEW index (a
    // retried chunk replaces in place and must not double-count).
    const prior = session.chunks.get(index)?.length ?? 0;
    const projected = this.currentBase64Length(session) - prior + chunkBase64.length;
    if (projected > this.maxTotalBase64) {
      return { ok: false, code: 'too_large', message: 'upload exceeds maximum size' };
    }
    session.chunks.set(index, chunkBase64);
    session.lastTouchedAt = this.now();
    return { ok: true, ack: this.ack(session) };
  }

  private ack(session: Session): ChunkAck {
    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.chunks.has(i)) missing.push(i);
    }
    return { received: session.chunks.size, total: session.totalChunks, missing };
  }

  /** Read the current ack without mutating (for a GET status probe). */
  status(sessionId: string, userId: string): ChunkAck | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    return this.ack(session);
  }

  finalize(sessionId: string, userId: string): FinalizeResult {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      return { ok: false, code: 'no_session', message: 'upload session not found or expired' };
    }
    const ack = this.ack(session);
    if (ack.missing.length > 0) {
      return {
        ok: false,
        code: 'incomplete',
        message: `upload incomplete: ${ack.missing.length} chunk(s) missing`,
        missing: ack.missing,
      };
    }
    // Concatenate the base64 string slices in index order, then the
    // route decodes the single payload exactly once.
    let base64 = '';
    for (let i = 0; i < session.totalChunks; i++) {
      base64 += session.chunks.get(i)!;
    }
    const meta: UploadSessionMeta = {
      userId: session.userId,
      totalChunks: session.totalChunks,
    };
    if (session.language !== undefined) meta.language = session.language;
    // Consume the session — finalize is terminal.
    this.sessions.delete(sessionId);
    return { ok: true, base64, meta };
  }

  cancel(sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    this.sessions.delete(sessionId);
    return true;
  }

  /** Drop sessions idle longer than the TTL. Called on every mutation. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastTouchedAt < cutoff) this.sessions.delete(id);
    }
  }

  /** Test/debug: live session count. */
  size(): number {
    return this.sessions.size;
  }
}
