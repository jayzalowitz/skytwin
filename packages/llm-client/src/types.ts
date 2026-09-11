import type {
  AIProviderName,
  InferenceFallbackV1,
  InferenceReceiptStatus,
  InferenceReasoningMode,
  ProviderExecutionMetadata,
  ReasoningMode,
  ReceiptSignatureV1,
} from '@skytwin/shared-types';

export interface TrustedConfidentialVerification {
  outcome: 'verified';
  inferenceId?: string;
  attestationPolicyVersion: string;
  verifierVersion: string;
  evidence: Uint8Array;
  measurementIdentity: string;
  responseSignature: ReceiptSignatureV1;
  verifiedAt: string;
  freshUntil: string;
}

export interface RejectedConfidentialVerification {
  outcome: 'verification_failed' | 'verification_unavailable' | 'verification_stale';
  verifierVersion: string;
  reason: string;
}

export type ConfidentialVerificationResult =
  | TrustedConfidentialVerification
  | RejectedConfidentialVerification;

export interface ConfidentialInferenceVerifier {
  verify(input: {
    provider: AIProviderName;
    model: string;
    endpointIdentity: string;
    request: Uint8Array;
    response: Uint8Array;
  }): Promise<ConfidentialVerificationResult>;
}

/** Canonical logical input/output bytes and provider facts captured by one client instance. */
export interface InferenceTrace {
  id: string;
  reasoningMode: InferenceReasoningMode;
  status: InferenceReceiptStatus;
  provider: AIProviderName;
  model: string;
  endpointIdentity: string;
  request: Uint8Array;
  response: Uint8Array;
  cost: { basis: 'exact'; currency: string; amountMinor: number } | { basis: 'unknown' };
  createdAt: string;
  verifierVersion: string;
  fallback?: InferenceFallbackV1;
  verification?: TrustedConfidentialVerification;
  verificationFailureReason?: string;
}

/**
 * Configuration for a single provider in the chain.
 */
export interface ProviderEntry {
  name: AIProviderName;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Defaults to on-device for embedded/Ollama and conventional cloud otherwise. */
  reasoningMode?: InferenceReasoningMode;
  /** Required for verified-confidential entries. Unverified responses are never returned. */
  confidentialVerifier?: ConfidentialInferenceVerifier;
}

export interface LlmClientOptions {
  onInferenceTrace?: (trace: InferenceTrace) => void;
  now?: () => Date;
}

/**
 * Options for a generate call.
 */
export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  timeoutMs?: number;
  /** User-present calls may use explicitly selected providers with unknown price. */
  invocationKind?: 'interactive' | 'unattended';
}

/**
 * Normalized response from any LLM provider.
 */
export interface LlmResponse {
  content: string;
  provider: AIProviderName;
  model: string;
  latencyMs: number;
  /** Additive provenance for routing, spend and future receipt persistence. */
  execution: ProviderExecutionMetadata;
}

/**
 * One turn in a multi-turn conversation. Issue #149 — phase 3.
 *
 * Mirrors the OpenAI / Anthropic / generic chat-completion message shape.
 * `system` is supported as a turn role for parity with the array form,
 * even though most callers prefer to pass system content via
 * `GenerateOptions.systemPrompt` (which providers translate to their
 * native top-level `system` field). When both are present, the array
 * system messages take precedence — the assistant injects context as a
 * system turn at the head of the array.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Provider-level generate function signature.
 *
 * `prompt` accepts either a single string (treated as one user message —
 * preserves the pre-#149 caller contract) OR a `ChatMessage[]` for
 * multi-turn conversations. Each provider translates the array to its
 * native chat-completion shape (OpenAI's `messages`, Anthropic's
 * `messages`, Gemini's `contents`, Ollama's `/api/chat` `messages`).
 */
export type ProviderGenerateFn = (
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string; reasoningMode?: ReasoningMode },
) => Promise<string>;

/**
 * One streaming event yielded by `LlmClient.generateStream`.
 *
 * `chunk` events carry partial text as it arrives from the provider.
 * `done` is yielded exactly once at the end with the assembled full
 * content + the same metadata the sync `generate` would have returned.
 *
 * Issue #146 — phase 2a SSE streaming for the assistant.
 */
export type LlmStreamEvent =
  | { type: 'chunk'; content: string }
  | {
    type: 'done';
    content: string;
    provider: AIProviderName;
    model: string;
    latencyMs: number;
    execution: ProviderExecutionMetadata;
  };

/**
 * Provider-level streaming function signature. Returns an async iterable
 * of text chunks (no metadata wrapping) — `LlmClient.generateStream`
 * adds the `done` event with provider/model/latency around the iterable.
 *
 * Providers that don't support native streaming (Google, Ollama in this
 * codebase) can be wrapped by the universal fallback in `llm-client.ts`,
 * which awaits the full sync `generate` response and yields it as a
 * single chunk. Same shape, same caller contract — only the UX differs.
 */
export type ProviderStreamFn = (
  apiKey: string,
  model: string,
  prompt: string | ChatMessage[],
  options: GenerateOptions & { baseUrl?: string; reasoningMode?: ReasoningMode },
) => AsyncIterable<string>;
