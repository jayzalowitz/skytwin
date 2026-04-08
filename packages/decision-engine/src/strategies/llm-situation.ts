import type { DecisionObject } from '@skytwin/shared-types';
import type { LlmClient } from '@skytwin/llm-client';
import { PromptBuilder, parseSituationResponse } from '@skytwin/llm-client';
import type { SituationStrategy } from './situation-strategy.js';

/**
 * LLM-powered situation interpretation.
 * Sends the raw event to the user's configured LLM provider chain.
 */
export class LlmSituationStrategy implements SituationStrategy {
  constructor(private readonly llmClient: LlmClient) {}

  async interpret(rawEvent: Record<string, unknown>): Promise<DecisionObject> {
    const prompt = PromptBuilder.buildSituationPrompt(rawEvent);

    const response = await this.llmClient.generate(prompt, {
      temperature: 0.2,
      maxTokens: 256,
      systemPrompt: 'You are a precise event classifier. Respond with only valid JSON.',
    });

    const parsed = parseSituationResponse(response.content, rawEvent);
    if (!parsed) {
      throw new Error('LLM returned unparseable situation response');
    }

    return parsed;
  }
}
