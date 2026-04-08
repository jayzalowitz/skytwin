import type { DecisionObject, DecisionContext, CandidateAction, TwinProfile } from '@skytwin/shared-types';
import type { LlmClient } from '@skytwin/llm-client';
import { PromptBuilder, parseCandidateResponse } from '@skytwin/llm-client';
import type { CandidateGenerator } from './candidate-strategy.js';

/**
 * LLM-powered candidate action generation.
 * Sends the full decision context to the user's configured LLM provider chain.
 */
export class LlmCandidateGenerator implements CandidateGenerator {
  constructor(private readonly llmClient: LlmClient) {}

  async generate(
    decision: DecisionObject,
    _profile: TwinProfile,
    context: DecisionContext,
  ): Promise<CandidateAction[]> {
    const prompt = PromptBuilder.buildCandidatePrompt(decision, context);

    const response = await this.llmClient.generate(prompt, {
      temperature: 0.3,
      maxTokens: 1024,
      systemPrompt: 'You are a personal assistant generating candidate actions. Respond with only a valid JSON array.',
    });

    const candidates = parseCandidateResponse(response.content, decision.id);
    if (candidates.length === 0) {
      throw new Error('LLM returned no valid candidates');
    }

    return candidates;
  }
}
