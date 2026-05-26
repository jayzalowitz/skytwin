/**
 * Prompt-builder contract tests (#411).
 *
 * The candidate prompt MUST NOT ask the LLM for `estimatedCostCents`
 * or `reversible`. The response-parser hardcodes both to safe defaults
 * (Safety Invariant #4 — see response-parser.ts:109-114). Pre-fix the
 * prompt asked for them anyway, which (a) burned tokens on output the
 * parser threw away and (b) created a foot-gun: a maintainer who
 * "wired the LLM values through" to honor the prompt would silently
 * re-open the spend-cap bypass closed by #372. These tests lock the
 * prompt + parser into alignment.
 */

import { describe, it, expect } from 'vitest';
import { PromptBuilder } from '../prompt-builder.js';
import type { DecisionObject, DecisionContext } from '@skytwin/shared-types';
import { SituationType } from '@skytwin/shared-types';

function makeDecision(): DecisionObject {
  return {
    id: 'decision-1',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'medium',
    summary: 'A test situation',
    rawData: {},
    interpretedAt: new Date(),
  };
}

function makeContext(): DecisionContext {
  return {
    userId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001',
    decision: makeDecision(),
    trustTier: 'observer' as never,
    relevantPreferences: [],
    timestamp: new Date(),
  };
}

describe('PromptBuilder.buildCandidatePrompt (#411)', () => {
  it('does NOT instruct the LLM to provide estimatedCostCents', () => {
    const prompt = PromptBuilder.buildCandidatePrompt(makeDecision(), makeContext());
    // Match a structural "field list" mention only — the safety-invariant
    // comment in the prompt may legitimately reference the field name.
    // The instruction line starts with "- " and ends with the field
    // description; that's what we're banning.
    expect(prompt).not.toMatch(/^-\s*estimatedCostCents:/m);
  });

  it('does NOT instruct the LLM to provide reversible', () => {
    const prompt = PromptBuilder.buildCandidatePrompt(makeDecision(), makeContext());
    expect(prompt).not.toMatch(/^-\s*reversible:/m);
  });

  it('explicitly notes cost and reversibility are policy-engine decisions', () => {
    const prompt = PromptBuilder.buildCandidatePrompt(makeDecision(), makeContext());
    expect(prompt).toMatch(/cost and reversibility are determined by the policy engine/i);
  });

  it('still asks for the fields the parser actually consumes', () => {
    const prompt = PromptBuilder.buildCandidatePrompt(makeDecision(), makeContext());
    // Sanity check — the parser still needs actionType, description,
    // domain, parameters, confidence, reasoning. The prompt should
    // still list these.
    for (const field of ['actionType', 'description', 'domain', 'parameters', 'confidence', 'reasoning']) {
      expect(prompt).toMatch(new RegExp(`^-\\s*${field}:`, 'm'));
    }
  });
});
