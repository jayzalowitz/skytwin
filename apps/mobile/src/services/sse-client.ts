/**
 * Server-Sent Events client for real-time approval notifications.
 *
 * Connects to the SkyTwin API SSE endpoint and dispatches typed events
 * to a callback. Automatically reconnects with exponential backoff on
 * disconnect or error.
 */

import {
  DEFAULT_BACKOFF,
  nextReconnectDelay,
  reduceConnectionState,
  type SSEConnectionState,
} from './sse-reconnect';

export interface SSEEvent {
  type: 'new-approval' | 'approval-expired' | 'status-change' | 'connected' | 'approval:resolved' | 'decision:step' | 'approval:new' | 'decision:executed';
  data: unknown;
}

export type { SSEConnectionState };

interface SSEConnectionHandle {
  /** Close the SSE connection and stop reconnection attempts. */
  disconnect: () => void;
  /** Whether the connection is currently open. */
  isConnected: () => boolean;
  /** Current connection state for richer UI (banner vs. dot). */
  getState: () => SSEConnectionState;
  /**
   * Force an immediate reconnect, resetting the backoff to the floor.
   * Wired to pull-to-refresh so a user who sees the "Reconnecting…"
   * banner can skip the remaining backoff wait (#388).
   */
  reconnectNow: () => void;
}

/**
 * Connect to the SkyTwin SSE endpoint for real-time event streaming.
 *
 * React Native does not natively support EventSource, so we use a raw
 * fetch with a streaming reader. This approach works with the Hermes
 * engine and handles the SSE text/event-stream protocol directly.
 *
 * `onStateChange` receives the full connection state machine
 * (connecting / connected / reconnecting / disconnected); the legacy
 * `onConnectionChange(boolean)` is still fired for the existing dot.
 */
export function connectSSE(
  baseUrl: string,
  token: string,
  userId: string,
  onEvent: (event: SSEEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
  onStateChange?: (state: SSEConnectionState) => void,
): SSEConnectionHandle {
  let abortController: AbortController | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connected = false;
  let state: SSEConnectionState = 'connecting';

  const setState = (event: 'open' | 'drop' | 'stop'): void => {
    const next = reduceConnectionState(state, event);
    if (next !== state) {
      state = next;
      onStateChange?.(state);
    }
    const nowConnected = state === 'connected';
    if (connected !== nowConnected) {
      connected = nowConnected;
      onConnectionChange?.(nowConnected);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    setState('drop');

    const delay = nextReconnectDelay(reconnectAttempt, DEFAULT_BACKOFF);
    reconnectAttempt += 1;

    reconnectTimer = setTimeout(() => {
      if (!stopped) {
        startConnection();
      }
    }, delay);
  };

  const parseSSEChunk = (chunk: string): void => {
    // SSE format: "event: <type>\ndata: <json>\n\n"
    const lines = chunk.split('\n');
    let eventType: string | null = null;
    let eventData: string | null = null;

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        eventData = line.slice(6).trim();
      } else if (line.startsWith(':')) {
        // Comment line (heartbeat), ignore
        continue;
      }
    }

    if (eventType && eventData) {
      try {
        const parsed: unknown = JSON.parse(eventData);
        onEvent({
          type: eventType as SSEEvent['type'],
          data: parsed,
        });
      } catch {
        console.warn('[sse] Failed to parse SSE data:', eventData);
      }

      // Reset backoff on successful message receipt — a live stream
      // means the connection is healthy, so the next drop should start
      // its backoff from the floor again.
      reconnectAttempt = 0;
    }
  };

  const startConnection = async (): Promise<void> => {
    if (stopped) return;

    abortController = new AbortController();
    const url = `${baseUrl.replace(/\/+$/, '')}/api/events/stream/${encodeURIComponent(userId)}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        console.warn(`[sse] HTTP ${response.status} from SSE endpoint`);
        scheduleReconnect();
        return;
      }

      if (!response.body) {
        console.warn('[sse] No response body from SSE endpoint');
        scheduleReconnect();
        return;
      }

      setState('open');
      reconnectAttempt = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE messages are delimited by double newlines
        const messages = buffer.split('\n\n');
        // Last element is either empty or an incomplete message
        buffer = messages.pop() ?? '';

        for (const message of messages) {
          if (message.trim()) {
            parseSSEChunk(message);
          }
        }
      }

      // Stream ended normally, reconnect
      if (!stopped) {
        scheduleReconnect();
      }
    } catch (err: unknown) {
      if (stopped) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.warn('[sse] Connection error:', err instanceof Error ? err.message : err);
      scheduleReconnect();
    }
  };

  // Start the initial connection
  startConnection();

  return {
    disconnect: () => {
      stopped = true;
      setState('stop');
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
    isConnected: () => connected,
    getState: () => state,
    reconnectNow: () => {
      if (stopped) return;
      // Reset the backoff and retry right now. Cancel any pending
      // timer + abort the in-flight (likely-dead) connection so we
      // don't end up with two readers.
      reconnectAttempt = 0;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      startConnection();
    },
  };
}
