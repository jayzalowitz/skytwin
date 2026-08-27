/**
 * A raw signal from a connected data source. Signals are the primary
 * input to SkyTwin's decision pipeline.
 */
export interface RawSignal {
  id: string;
  source: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

/**
 * A handler function that processes incoming signals.
 */
export type SignalHandler = (signal: RawSignal) => void;

/**
 * Interface for signal connectors that feed data into SkyTwin.
 *
 * Connectors abstract the integration with external services (email,
 * calendar, shopping platforms, etc.) and normalize their data into
 * RawSignals.
 */
export interface SignalConnector {
  /** Human-readable name for this connector. */
  readonly name: string;

  /**
   * Connect to the data source. This may involve authentication,
   * establishing WebSocket connections, or starting polling timers.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the data source and clean up resources.
   */
  disconnect(): Promise<void>;

  /**
   * Manually poll for new signals. Returns all signals available since
   * the last poll.
   */
  poll(): Promise<RawSignal[]>;

  /**
   * Register a handler to be called when new signals arrive.
   * This is used for push-based connectors.
   */
  onSignal(handler: SignalHandler): void;

  /**
   * Durably advance the cursor for the signals returned by the most recent
   * `poll()`. Optional — connectors with no durable cursor omit it.
   *
   * Cursor advancement is an AT-LEAST-ONCE acknowledgement, not part of
   * reading. A connector that persists its cursor inside `poll()` has already
   * declared the batch handled before the caller has done anything with it,
   * so any downstream failure (a 401 from the ingest endpoint, a crash, a
   * closed circuit) permanently skips those items. Connectors therefore STAGE
   * the new cursor during `poll()` and persist it only when the caller calls
   * this after successfully handling every returned signal. Re-delivery on
   * failure is the intended trade: the ingest endpoint dedupes on
   * (user_id, signal_id).
   *
   * Idempotent, and a no-op when nothing is staged.
   */
  commitCursor?(): Promise<void>;
}
