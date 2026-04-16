/**
 * Server-Sent Events client for real-time approval notifications.
 *
 * Connects to the SkyTwin API SSE endpoint and dispatches typed events
 * to a callback. Automatically reconnects with exponential backoff on
 * disconnect or error.
 */

export interface SSEEvent {
  type: 'new-approval' | 'approval-expired' | 'status-change' | 'connected' | 'approval:resolved' | 'decision:step' | 'approval:new' | 'decision:executed';
  data: unknown;
}

interface SSEConnectionHandle {
  /** Close the SSE connection and stop reconnection attempts. */
  disconnect: () => void;
  /** Whether the connection is currently open. */
  isConnected: () => boolean;
}

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * Connect to the SkyTwin SSE endpoint for real-time event streaming.
 *
 * React Native does not natively support EventSource, so we use a raw
 * fetch with a streaming reader. This approach works with the Hermes
 * engine and handles the SSE text/event-stream protocol directly.
 */
export function connectSSE(
  baseUrl: string,
  token: string,
  userId: string,
  onEvent: (event: SSEEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
): SSEConnectionHandle {
  let abortController: AbortController | null = null;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let connected = false;

  const setConnected = (value: boolean): void => {
    if (connected !== value) {
      connected = value;
      onConnectionChange?.(value);
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    setConnected(false);

    reconnectTimer = setTimeout(() => {
      if (!stopped) {
        startConnection();
      }
    }, reconnectDelay);

    // Exponential backoff with cap
    reconnectDelay = Math.min(reconnectDelay * BACKOFF_MULTIPLIER, MAX_RECONNECT_MS);
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

      // Reset backoff on successful message receipt
      reconnectDelay = MIN_RECONNECT_MS;
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

      setConnected(true);
      reconnectDelay = MIN_RECONNECT_MS;

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
      setConnected(false);
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
  };
}
