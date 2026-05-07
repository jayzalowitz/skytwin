import { createHash } from 'node:crypto';
import type { LlmClient } from '@skytwin/llm-client';
import type { PromptCache, UserProfile } from './types.js';
import { runPrompt } from './runner.js';

function humanizeCacheKey(text: string, language: string | undefined, riskHash: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ text, language, riskHash }))
    .digest('hex');
}

function hashRiskProfile(riskProfileText: string | undefined): string {
  if (!riskProfileText) return 'none';
  return createHash('sha256').update(riskProfileText).digest('hex').slice(0, 16);
}

export function humanize(
  text: string,
  user: UserProfile,
  llmClient: LlmClient,
  cache?: PromptCache,
): Promise<string> {
  const riskHash = hashRiskProfile(user.riskProfileText);
  const cacheKey = `humanize:${humanizeCacheKey(text, user.language, riskHash)}`;

  if (cache) {
    const cacheCheckPromise = cache.get(cacheKey).then((cached) => {
      if (typeof cached === 'string') return cached;

      // Fire-and-forget background refresh
      void runPrompt<string>({
        promptName: 'humanize-copy',
        inputs: {
          text,
          language: user.language ?? 'en',
          risk_profile: user.riskProfileText ?? '',
        },
        user,
        llmClient,
        cache,
      }).then((result) => {
        if (typeof result.output === 'string' && cache) {
          return cache.set(cacheKey, result.output, 300_000);
        }
      }).catch(() => {
        // background refresh failures are silently dropped
      });

      // Return original synchronously — cache miss path
      return text;
    });

    return cacheCheckPromise;
  }

  // No cache configured: return original text immediately
  return Promise.resolve(text);
}
