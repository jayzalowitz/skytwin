import type { LlmClient } from '@skytwin/llm-client';
import type { PromptCache, BudgetTracker } from './types.js';
import { listPromptNames, loadPrompt } from './prompt-loader.js';
import { runPrompt } from './runner.js';

export interface EvalResult {
  promptName: string;
  fixtureName: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  error?: string;
}

export interface EvalOptions {
  llmClient: LlmClient;
  cache?: PromptCache;
  budgetTracker?: BudgetTracker;
  promptNames?: string[];
}

export async function evalAllPrompts(opts: EvalOptions): Promise<EvalResult[]> {
  const names = opts.promptNames ?? listPromptNames();
  const results: EvalResult[] = [];

  for (const promptName of names) {
    let loaded;
    try {
      loaded = loadPrompt(promptName);
    } catch (err) {
      results.push({
        promptName,
        fixtureName: '__load__',
        passed: false,
        expected: null,
        actual: null,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (loaded.fixtures.length === 0) {
      continue;
    }

    for (const fixture of loaded.fixtures) {
      try {
        const result = await runPrompt({
          promptName,
          inputs: fixture.inputs,
          user: { userId: 'eval-user' },
          llmClient: opts.llmClient,
          cache: opts.cache,
          budgetTracker: opts.budgetTracker,
        });

        const passed = shallowStructureMatch(result.output, fixture.expected);
        results.push({
          promptName,
          fixtureName: fixture.name,
          passed,
          expected: fixture.expected,
          actual: result.output,
        });
      } catch (err) {
        results.push({
          promptName,
          fixtureName: fixture.name,
          passed: false,
          expected: fixture.expected,
          actual: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return results;
}

function shallowStructureMatch(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (expected === null || expected === undefined) return true;
  if (Array.isArray(expected) && Array.isArray(actual)) return true;
  if (typeof expected === 'object' && typeof actual === 'object') return true;
  if (typeof expected === 'string' && typeof actual === 'string') return true;
  if (typeof expected === 'number' && typeof actual === 'number') return true;
  if (typeof expected === 'boolean' && typeof actual === 'boolean') return true;
  return false;
}
