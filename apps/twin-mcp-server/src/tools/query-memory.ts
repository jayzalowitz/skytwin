import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** PII-adjacent fields we strip from semantic search results before returning. */
const REDACT_KEYS = new Set(['email', 'phone', 'ssn', 'password', 'token', 'secret', 'api_key']);

function redactObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactObject(v);
  }
  return result;
}

export interface QueryMemoryArgs {
  question: string;
  limit?: number;
}

/**
 * Semantic search over the user's MemoryPort.
 * Requires scope: read.
 */
export async function queryMemory(
  userId: string,
  args: QueryMemoryArgs,
): Promise<CallToolResult> {
  const { question, limit = 10 } = args;

  if (!question || typeof question !== 'string' || !question.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'question must be a non-empty string' }],
    };
  }

  const clampedLimit = Math.min(Math.max(1, limit), 50);

  // Search the user's memory via the mempalace DB repository.
  // v1: keyword search over drawers (content) and episodes (situation_summary)
  // as a best-effort text fallback until the full embedding pipeline is wired.
  //
  // TODO (#182 follow-up): replace with MemPalaceMemoryPort.searchSemantic()
  // once the embedding pipeline is wired to the DB.
  let results: unknown[] = [];
  try {
    const { mempalaceRepository } = await import('@skytwin/db');
    // Split question into search terms for drawer search
    const terms = question.trim().split(/\s+/).filter((t) => t.length > 2);
    const [drawers, episodes] = await Promise.allSettled([
      terms.length > 0
        ? mempalaceRepository.searchDrawers(userId, terms, Math.ceil(clampedLimit / 2))
        : Promise.resolve([]),
      terms.length > 0
        ? mempalaceRepository.searchEpisodes(userId, terms, Math.ceil(clampedLimit / 2))
        : Promise.resolve([]),
    ]);

    const drawerResults = drawers.status === 'fulfilled'
      ? drawers.value.map((d: { content: string; metadata: unknown }) => ({
          type: 'drawer', content: d.content, metadata: d.metadata,
        }))
      : [];
    const episodeResults = episodes.status === 'fulfilled'
      ? episodes.value.map((e: { situation_summary: string; domain: string }) => ({
          type: 'episode', summary: e.situation_summary, domain: e.domain,
        }))
      : [];

    // Both underlying searches failing means memory is effectively unavailable
    // for this user — surface a note rather than silently returning empty.
    if (drawers.status === 'rejected' && episodes.status === 'rejected') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results: [],
              note: 'Memory search unavailable for this user. Full semantic search requires the mempalace pipeline to be wired.',
              error: drawers.reason instanceof Error ? drawers.reason.message : String(drawers.reason),
            }),
          },
        ],
      };
    }

    results = [...drawerResults, ...episodeResults]
      .slice(0, clampedLimit)
      .map((r) => redactObject(r as Record<string, unknown>)) as unknown[];
  } catch (err) {
    // MemoryPort may not be configured for every user — return empty rather than 500.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [],
            note: 'Memory search unavailable for this user. Full semantic search requires the mempalace pipeline to be wired.',
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ results, question, limit: clampedLimit }),
      },
    ],
  };
}
