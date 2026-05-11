/**
 * Embedding providers for the gbrain CRDB backend.
 *
 * The MemoryPort contract takes free-text queries; the CRDB backend needs
 * fixed-dim float vectors to do similarity search. This module provides:
 *
 *   - `EmbeddingProvider` — the interface the repository depends on.
 *   - `HashEmbeddingProvider` — deterministic, dependency-free fallback. Uses
 *     the hashing trick (each token contributes to a deterministic dimension
 *     via FNV-1a hash). Output is normalised to a unit vector. Quality is
 *     modest but stable, which makes it ideal for tests and offline boots.
 *   - `OpenAiEmbeddingProvider` — calls any OpenAI-compatible
 *     `/v1/embeddings` endpoint. Configurable base URL → also works with
 *     Ollama, llamafile, and other local providers that expose the OpenAI API.
 *
 * Quality ordering is OpenAI-compatible >> Hash. We default to Hash so the
 * stack boots with zero configuration (and tests run hermetically); admins
 * configure a real provider via env when they want production-grade recall.
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// ── HashEmbeddingProvider ───────────────────────────────────────────────────

const DEFAULT_HASH_DIM = 384;

/**
 * Deterministic hashing-trick embedding. Tokenises on whitespace + punctuation,
 * hashes each token to a dimension via FNV-1a, increments by an inverse-length
 * weight, then normalises. Identical input → identical output. No I/O.
 *
 * Cosine similarity over hash embeddings approximates Jaccard similarity over
 * the token sets, which is enough to differentiate documents in tests and to
 * give the hybrid retrieval engine *something* to fuse with FTS rank.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'hash-fnv1a-v1';
  readonly dim: number;

  constructor(dim: number = DEFAULT_HASH_DIM) {
    if (dim < 16 || dim > 4096) {
      throw new Error(`HashEmbeddingProvider dim must be in [16, 4096]; got ${dim}`);
    }
    this.dim = dim;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t));
  }

  private embedSync(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = tokenise(text);
    if (tokens.length === 0) return vec;

    for (const tok of tokens) {
      const h = fnv1a32(tok);
      // Two probes per token (sign trick) — reduces collisions a touch.
      const idxA = h % this.dim;
      const idxB = (h >>> 16) % this.dim;
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[idxA] = (vec[idxA] ?? 0) + sign;
      vec[idxB] = (vec[idxB] ?? 0) + sign * 0.5;
    }

    // L2 normalise so cosine similarity reduces to dot product.
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    for (let i = 0; i < vec.length; i++) {
      vec[i] = (vec[i] ?? 0) / norm;
    }
    return vec;
  }
}

// ── OpenAiEmbeddingProvider ─────────────────────────────────────────────────

export interface OpenAiEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dim?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * OpenAI-compatible embedding provider. Posts to `${baseUrl}/embeddings`,
 * which works with OpenAI, Ollama, llamafile, vLLM, etc.
 *
 * On any network error or non-2xx the method throws; the caller is expected
 * to catch and decide whether to fall back to the hash provider.
 */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenAiEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dim = opts.dim ?? 1536;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    if (!v) throw new Error('OpenAiEmbeddingProvider: empty response');
    return v;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`embedding HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const data = json.data ?? [];
      if (data.length !== texts.length) {
        throw new Error(`embedding response count mismatch: got ${data.length}, expected ${texts.length}`);
      }
      return data.map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const TOKEN_RE = /[a-z0-9]+/gi;

export function tokenise(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(lower)) !== null) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  return out;
}

/**
 * 32-bit FNV-1a. Stable across Node versions; no crypto required.
 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ax = a[i] ?? 0;
    const bx = b[i] ?? 0;
    dot += ax * bx;
    normA += ax * ax;
    normB += bx * bx;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
