/**
 * Supported AI provider identifiers.
 */
export type AIProviderName = 'anthropic' | 'openai' | 'google' | 'ollama';

/**
 * A single provider configuration in the user's AI chain.
 */
export interface AIProviderConfig {
  provider: AIProviderName;
  apiKey: string;
  model: string;
  baseUrl?: string;
  priority: number;
  enabled: boolean;
}

/**
 * The user's ordered list of AI providers.
 * Tried in priority order; rule-based is the implicit final fallback.
 */
export type ProviderChain = AIProviderConfig[];

/**
 * Model options available per provider.
 */
export const PROVIDER_MODELS: Record<AIProviderName, { id: string; label: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-5-20250514', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  openai: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  ],
  google: [
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  ollama: [
    { id: 'gemma3', label: 'Gemma 3' },
    { id: 'llama3.1', label: 'Llama 3.1' },
    { id: 'mistral', label: 'Mistral' },
  ],
};

/**
 * Display metadata for each provider.
 */
export const PROVIDER_INFO: Record<AIProviderName, { label: string; description: string; requiresApiKey: boolean; requiresBaseUrl: boolean }> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    description: 'Best reasoning quality. Requires an API key from console.anthropic.com.',
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  openai: {
    label: 'OpenAI (GPT)',
    description: 'Widely used models. Requires an API key from platform.openai.com.',
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  google: {
    label: 'Google (Gemini)',
    description: 'Fast and capable. Requires an API key from aistudio.google.com.',
    requiresApiKey: true,
    requiresBaseUrl: false,
  },
  ollama: {
    label: 'Ollama (local)',
    description: 'Free, runs on your machine. Requires Ollama running locally.',
    requiresApiKey: false,
    requiresBaseUrl: true,
  },
};
