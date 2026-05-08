/**
 * Thrown by Null* port implementations when callers invoke an operation on a
 * runtime that is not available on this machine.
 */
export class NotAvailableError extends Error {
  /**
   * Identifies which embedded runtime is unavailable so callers can format
   * user-facing messages accordingly.
   */
  readonly runtime: 'llama' | 'whisper' | 'piper';

  constructor(runtime: 'llama' | 'whisper' | 'piper') {
    super(
      `Embedded runtime '${runtime}' is not available on this machine. ` +
        'Install the corresponding binary and restart the application.',
    );
    this.name = 'NotAvailableError';
    this.runtime = runtime;
  }
}
