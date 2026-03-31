/**
 * A signal is a raw event from an external system (email, calendar, etc.)
 * that SkyTwin needs to interpret and potentially act on.
 */
export interface Signal {
  id: string;
  source: string;
  type: string;
  data: Record<string, unknown>;
  userId: string;
  timestamp: Date;
}

/**
 * Abstract base class for signal connectors.
 * Each connector knows how to poll or receive signals from a specific external system.
 */
export abstract class SignalConnector {
  abstract readonly name: string;
  abstract readonly source: string;

  /**
   * Poll the external system for new signals since the last check.
   */
  abstract poll(): Promise<Signal[]>;

  /**
   * Initialize the connector (authenticate, set up webhooks, etc.).
   */
  abstract initialize(): Promise<void>;

  /**
   * Tear down the connector gracefully.
   */
  abstract shutdown(): Promise<void>;
}
