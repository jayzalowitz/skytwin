import { NotAvailableError } from './errors.js';

/**
 * Read-only capabilities advertised by an embedded text-generation runtime.
 */
export interface EmbeddedTextCapabilities {
  readonly available: boolean;
  readonly modelName: string | null;
  readonly contextWindow: number | null;
}

/**
 * Port interface for embedded text generation (llama.cpp).
 *
 * Real implementations back this with the llama-cli binary. The Null
 * implementation is the current default — it allows the rest of the codebase
 * to import and reference the port without requiring the binary to be present.
 */
export interface EmbeddedTextPort {
  readonly capabilities: EmbeddedTextCapabilities;
  generate(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string>;
}

/**
 * No-op fallback used when the llama.cpp binary is absent.
 * Every method call throws a typed NotAvailableError.
 */
export class NullEmbeddedTextPort implements EmbeddedTextPort {
  readonly capabilities: EmbeddedTextCapabilities = {
    available: false,
    modelName: null,
    contextWindow: null,
  };

  async generate(
    _prompt: string,
    _opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    throw new NotAvailableError('llama');
  }
}
