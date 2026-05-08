import { NotAvailableError } from './errors.js';

/**
 * Read-only capabilities advertised by an embedded speech-to-text runtime.
 */
export interface EmbeddedSttCapabilities {
  readonly available: boolean;
  readonly supportedFormats: string[];
}

/**
 * Port interface for embedded speech-to-text (Whisper-tiny).
 *
 * Real implementations back this with the whisper-cli binary. The Null
 * implementation is the current default — it allows the rest of the codebase
 * to import and reference the port without requiring the binary to be present.
 */
export interface EmbeddedSttPort {
  readonly capabilities: EmbeddedSttCapabilities;
  transcribe(audio: Buffer, opts?: { language?: string }): Promise<string>;
}

/**
 * No-op fallback used when the Whisper binary is absent.
 * Every method call throws a typed NotAvailableError.
 */
export class NullEmbeddedSttPort implements EmbeddedSttPort {
  readonly capabilities: EmbeddedSttCapabilities = {
    available: false,
    supportedFormats: [],
  };

  async transcribe(_audio: Buffer, _opts?: { language?: string }): Promise<string> {
    throw new NotAvailableError('whisper');
  }
}
