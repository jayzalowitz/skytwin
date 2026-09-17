import { NotAvailableError } from './errors.js';

/**
 * Read-only capabilities advertised by an embedded text-generation runtime.
 */
export interface EmbeddedTextCapabilities {
  readonly available: boolean;
  readonly modelName: string | null;
  readonly contextWindow: number | null;
  /** Digest verified again at the runtime launch boundary. */
  readonly artifactSha256?: string | null;
  /** Exact runtime build observed when the port was constructed. */
  readonly runtimeVersion?: string | null;
  /** Managed model gate status for immutable workflow authoring. */
  readonly workflowAuthoringQualified?: boolean;
  readonly unavailableReason?: EmbeddedTextUnavailableReason;
}

/** Machine-readable reason an embedded text port could not be constructed. */
export type EmbeddedTextUnavailableReason =
  | 'artifact_missing'
  | 'artifact_invalid'
  | 'runtime_binary_missing'
  | 'runtime_incompatible';

/**
 * Port interface for embedded text generation (llama.cpp).
 *
 * Real implementations back this with the non-interactive llama-completion binary. The Null
 * implementation is the current default — it allows the rest of the codebase
 * to import and reference the port without requiring the binary to be present.
 */
export interface EmbeddedTextPort {
  readonly capabilities: EmbeddedTextCapabilities;
  generate(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      jsonSchema?: string;
      disableReasoning?: boolean;
    },
  ): Promise<string>;
}

/**
 * No-op fallback used when the llama.cpp binary is absent.
 * Every method call throws a typed NotAvailableError.
 */
export class NullEmbeddedTextPort implements EmbeddedTextPort {
  readonly capabilities: EmbeddedTextCapabilities;

  constructor(reason?: EmbeddedTextUnavailableReason) {
    this.capabilities = {
      available: false,
      modelName: null,
      contextWindow: null,
      artifactSha256: null,
      runtimeVersion: null,
      workflowAuthoringQualified: false,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
    };
  }

  async generate(
    _prompt: string,
    _opts?: {
      maxTokens?: number;
      temperature?: number;
      jsonSchema?: string;
      disableReasoning?: boolean;
    },
  ): Promise<string> {
    throw new NotAvailableError('llama');
  }
}
