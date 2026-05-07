import { createHash } from 'node:crypto';
import type { RunPromptOptions, RunResult } from './types.js';
import { loadPrompt } from './prompt-loader.js';

interface AjvValidator {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}

interface AjvLike {
  compile(schema: object): AjvValidator;
}

// Lazily loaded to avoid paying module-parse cost on every import.
let _ajv: AjvLike | undefined;

async function getValidator(schema: object): Promise<AjvValidator> {
  if (!_ajv) {
    // Dynamic import keeps ajv out of the synchronous module graph.
    // any: ajv v8 ships CJS with no stable ESM type declaration for dynamic import
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('ajv') as any;
    const Ctor: new (opts: object) => AjvLike = mod.default?.default ?? mod.default ?? mod;
    _ajv = new Ctor({ allErrors: true });
  }
  return _ajv.compile(schema);
}

function computeCacheKey(
  promptName: string,
  version: number,
  inputs: Record<string, unknown>,
  modelId: string,
): string {
  const payload = JSON.stringify({ promptName, version, inputs, modelId });
  return createHash('sha256').update(payload).digest('hex');
}

function renderTemplate(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = inputs[key];
    if (val === undefined) return `{{${key}}}`;
    if (typeof val === 'string') return val;
    return JSON.stringify(val);
  });
}

function applyDeterministicFallback(
  strategy: string | undefined,
  inputs: Record<string, unknown>,
): unknown {
  switch (strategy) {
    case 'empty-list':
      return [];
    case 'empty-object':
      return {};
    case 'pass-through':
      return inputs;
    case 'null':
      return null;
    default:
      if (strategy !== undefined && strategy !== '') {
        try {
          return JSON.parse(strategy) as unknown;
        } catch {
          return strategy;
        }
      }
      return null;
  }
}

function parseJsonOutput(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]?.trim() ?? '') as unknown;
    } catch {
      // fall through
    }
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export async function runPrompt<T = unknown>(opts: RunPromptOptions): Promise<RunResult<T>> {
  const start = Date.now();
  const { promptName, inputs, user, llmClient, cache, budgetTracker } = opts;

  const loaded = loadPrompt(promptName, opts.version);
  const version = loaded.meta.version;

  const modelId = llmClient.hasProviders ? 'provider-chain' : 'none';
  const cacheKey = computeCacheKey(promptName, version, inputs, modelId);

  if (cache) {
    const cached = await cache.get(cacheKey);
    if (cached !== undefined) {
      return {
        output: cached as T,
        cached: true,
        latencyMs: Date.now() - start,
        fellBackToDeterministic: false,
      };
    }
  }

  const estimatedTokens = Math.ceil(loaded.templateBody.length / 4) + 512;
  if (budgetTracker) {
    const hasBudget = await budgetTracker.hasBudget(user.userId, promptName, estimatedTokens);
    if (!hasBudget) {
      const fallback = applyDeterministicFallback(loaded.meta.deterministic_fallback, inputs);
      return {
        output: fallback as T,
        cached: false,
        latencyMs: Date.now() - start,
        fellBackToDeterministic: true,
      };
    }
  }

  const rendered = renderTemplate(loaded.templateBody, { ...inputs, ...user });

  async function attempt(
    prompt: string,
  ): Promise<{ raw: string; provider: string; model: string; latencyMs: number }> {
    const response = await llmClient.generate(prompt, {
      temperature: loaded.meta.temperature ?? 0.2,
    });
    return {
      raw: response.content,
      provider: response.provider,
      model: response.model,
      latencyMs: response.latencyMs,
    };
  }

  let result: { raw: string; provider: string; model: string; latencyMs: number } | undefined;
  let parsed: unknown;
  let schemaValid = true;

  try {
    result = await attempt(rendered);
    parsed = parseJsonOutput(result.raw);

    if (loaded.schema) {
      const validate = await getValidator(loaded.schema as object);
      schemaValid = validate(parsed) as boolean;
      if (!schemaValid) {
        const errors = (validate.errors ?? [])
          .map((e) => `${e.instancePath ?? ''} ${e.message ?? ''}`.trim())
          .join('; ');
        const retryPrompt =
          rendered +
          `\n\n# Validation feedback\nYour previous response failed JSON Schema validation: ${errors}\nPlease fix and return valid JSON only.`;
        result = await attempt(retryPrompt);
        parsed = parseJsonOutput(result.raw);
        const validate2 = await getValidator(loaded.schema as object);
        schemaValid = validate2(parsed) as boolean;
      }
    }
  } catch {
    const fallback = applyDeterministicFallback(loaded.meta.deterministic_fallback, inputs);
    return {
      output: fallback as T,
      cached: false,
      latencyMs: Date.now() - start,
      fellBackToDeterministic: true,
    };
  }

  if (!schemaValid) {
    const fallback = applyDeterministicFallback(loaded.meta.deterministic_fallback, inputs);
    return {
      output: fallback as T,
      cached: false,
      latencyMs: Date.now() - start,
      fellBackToDeterministic: true,
    };
  }

  const ttlMs = (loaded.meta.expected_latency_ms ?? 800) > 2000 ? 300_000 : 3_600_000;
  if (cache) {
    await cache.set(cacheKey, parsed, ttlMs);
  }

  if (budgetTracker && result) {
    const actualTokens = Math.ceil(result.raw.length / 4);
    await budgetTracker.recordUsage(user.userId, promptName, actualTokens);
  }

  return {
    output: parsed as T,
    cached: false,
    latencyMs: Date.now() - start,
    modelUsed: result?.model,
    fellBackToDeterministic: false,
  };
}
