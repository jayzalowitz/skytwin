import { signalRepository } from '@skytwin/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface SubscribeSignalsArgs {
  /** Only return signals of this type, e.g. 'email', 'calendar'. Optional. */
  type?: string;
  /** Maximum signals to return. Default 20, max 100. */
  limit?: number;
  /** Return signals created after this ISO timestamp. Optional. */
  since?: string;
}

/**
 * Returns recent signals matching the given filter.
 * Requires scope: subscribe.
 *
 * v1: polling endpoint that returns recent signals. Full SSE streaming is a
 * follow-up if the MCP SDK supports it cleanly via the streamable HTTP
 * transport. Clients should poll on their preferred interval.
 *
 * Signals are scoped to the authenticated user — cross-user leakage is
 * prevented by the userId parameter from the resolved token.
 */
export async function subscribeSignals(
  userId: string,
  args: SubscribeSignalsArgs,
): Promise<CallToolResult> {
  const { type, since } = args;
  const limit = args.limit ?? 20;
  const clampedLimit = Math.min(Math.max(1, limit), 100);

  let sinceDate: Date | undefined;
  if (since) {
    const parsed = new Date(since);
    if (isNaN(parsed.getTime())) {
      return {
        isError: true,
        content: [{ type: 'text', text: `since must be a valid ISO timestamp, got: ${since}` }],
      };
    }
    sinceDate = parsed;
  }

  // signalRepository.getRecent returns signals within the last N hours.
  // When a `since` timestamp is provided we compute the hours lookback from it;
  // otherwise we default to 48 hours. We then filter by type client-side
  // since the repository only filters by domain, not type.
  const hoursBack = sinceDate
    ? Math.ceil((Date.now() - sinceDate.getTime()) / (1000 * 60 * 60))
    : 48;

  const allSignals = await signalRepository.getRecent(userId, type, hoursBack);

  // Apply sinceDate filter (getRecent uses the hours interval, not an exact timestamp)
  const filtered = sinceDate
    ? allSignals.filter((s: { timestamp: Date; created_at: Date }) => {
        const ts = new Date(s.timestamp ?? s.created_at ?? 0);
        return ts > sinceDate!;
      })
    : allSignals;

  const signals = filtered.slice(0, clampedLimit);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          signals,
          count: signals.length,
          note: 'v1: polling endpoint. Re-call with since=<last_signal.timestamp> for incremental updates.',
        }),
      },
    ],
  };
}
