import { NotAvailableError } from './errors.js';

/**
 * Read-only capabilities advertised by an embedded text-to-speech runtime.
 */
export interface EmbeddedTtsCapabilities {
  readonly available: boolean;
  readonly voices: string[];
}

/**
 * Port interface for embedded text-to-speech (Piper).
 *
 * Real implementations back this with the piper binary. The Null
 * implementation is the current default — it allows the rest of the codebase
 * to import and reference the port without requiring the binary to be present.
 */
export interface EmbeddedTtsPort {
  readonly capabilities: EmbeddedTtsCapabilities;
  synthesize(text: string, opts?: { voice?: string }): Promise<Buffer>;
}

/**
 * No-op fallback used when the Piper binary is absent.
 * Every method call throws a typed NotAvailableError.
 */
export class NullEmbeddedTtsPort implements EmbeddedTtsPort {
  readonly capabilities: EmbeddedTtsCapabilities = {
    available: false,
    voices: [],
  };

  async synthesize(_text: string, _opts?: { voice?: string }): Promise<Buffer> {
    throw new NotAvailableError('piper');
  }
}
