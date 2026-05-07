import type { LlmClient } from '@skytwin/llm-client';

export interface PromptFrontmatter {
  name: string;
  version: number;
  model_hints?: {
    preferred?: string;
    acceptable?: string[];
    fallback?: 'deterministic' | string;
  };
  temperature?: number;
  expected_latency_ms?: number;
  daily_token_budget_per_user?: number;
  output_schema_ref?: string;
  deterministic_fallback?: string;
  description?: string;
}

export interface LoadedPrompt {
  meta: PromptFrontmatter;
  templateBody: string;
  schema?: unknown;
  fixtures: PromptFixture[];
}

export interface PromptFixture {
  name: string;
  inputs: Record<string, unknown>;
  expected: unknown;
  notes?: string;
}

export interface UserProfile {
  userId: string;
  language?: string;
  riskProfileText?: string;
}

export interface RunPromptOptions {
  promptName: string;
  version?: number;
  inputs: Record<string, unknown>;
  user: UserProfile;
  llmClient: LlmClient;
  cache?: PromptCache;
  budgetTracker?: BudgetTracker;
}

export interface RunResult<T = unknown> {
  output: T;
  cached: boolean;
  latencyMs: number;
  tokenUsage?: { input: number; output: number };
  modelUsed?: string;
  fellBackToDeterministic: boolean;
}

export interface PromptCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
}

export interface BudgetTracker {
  hasBudget(userId: string, promptName: string, estimatedTokens: number): Promise<boolean>;
  recordUsage(userId: string, promptName: string, tokens: number): Promise<void>;
}

export type DeterministicFallbackStrategy =
  | 'empty-list'
  | 'empty-object'
  | 'pass-through'
  | 'null';
