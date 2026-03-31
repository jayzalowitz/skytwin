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
}
