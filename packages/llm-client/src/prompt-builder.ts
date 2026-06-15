import type { DecisionContext, DecisionObject, Preference, BehavioralPattern, CrossDomainTrait, EpisodicMemory } from '@skytwin/shared-types';
import { SituationType, ConfidenceLevel } from '@skytwin/shared-types';
import { redactPromptPii } from './redact.js';

/**
 * Options shared by the prompt builders.
 *
 * `redactPii` (default `true`, #375) masks email addresses in the user-derived
 * parts of the prompt (the raw signal dump and episodic-memory summaries)
 * before they're sent to the provider chain, which may be a cloud LLM. Pass
 * `redactPii: false` only for a fully-local provider where third-party exposure
 * isn't a concern; masking never touches prose, so leaving it on costs the
 * decision path nothing (an action's recipient is resolved from the structured
 * signal record, not parsed from the prompt).
 */
export interface BuildPromptOptions {
  redactPii?: boolean;
}

/** Apply PII redaction to a prompt fragment unless explicitly disabled. */
function maybeRedact(text: string, opts?: BuildPromptOptions): string {
  return opts?.redactPii === false ? text : redactPromptPii(text);
}

/**
 * Builds structured prompts for the LLM to interpret situations
 * and generate candidate actions.
 */
export const PromptBuilder = {
  /**
   * Build a prompt for situation interpretation (event classification).
   */
  buildSituationPrompt(rawEvent: Record<string, unknown>, opts?: BuildPromptOptions): string {
    const situationTypes = Object.values(SituationType).join(', ');

    return `You are SkyTwin, a personal AI assistant that classifies incoming events.

Given the following raw event, classify it into a structured decision object.

## Raw Event
${maybeRedact(JSON.stringify(rawEvent, null, 2), opts)}

## Valid Situation Types
${situationTypes}

## Valid Urgency Levels
low, medium, high, critical

## Instructions
Respond with ONLY a JSON object (no markdown, no explanation) with these exact fields:
{
  "situationType": "<one of the valid situation types>",
  "domain": "<domain name like email, calendar, finance, etc.>",
  "urgency": "<low|medium|high|critical>",
  "summary": "<one-sentence human-readable summary of the situation>"
}`;
  },

  /**
   * Build a prompt for candidate action generation.
   */
  buildCandidatePrompt(decision: DecisionObject, context: DecisionContext, opts?: BuildPromptOptions): string {
    const sections: string[] = [];

    sections.push(`You are SkyTwin, a personal AI assistant generating possible actions for a user.`);

    // Situation. The raw data carries inbound email headers (sender/recipient
    // addresses) — redact PII before it reaches a cloud provider (#375).
    sections.push(`## Situation
Type: ${decision.situationType}
Domain: ${decision.domain}
Urgency: ${decision.urgency}
Summary: ${decision.summary}
Raw data: ${maybeRedact(JSON.stringify(decision.rawData, null, 2), opts)}`);

    // User preferences
    if (context.relevantPreferences.length > 0) {
      sections.push(`## User Preferences
${formatPreferences(context.relevantPreferences)}`);
    }

    // Behavioral patterns
    if (context.patterns && context.patterns.length > 0) {
      sections.push(`## Behavioral Patterns
${formatPatterns(context.patterns)}`);
    }

    // Cross-domain traits
    if (context.traits && context.traits.length > 0) {
      sections.push(`## User Traits
${formatTraits(context.traits)}`);
    }

    // Episodic memories (past similar decisions). These are user memory — the
    // summaries can quote email addresses from prior signals — so redact before
    // they reach a cloud provider (#375).
    if (context.episodicMemories && context.episodicMemories.length > 0) {
      sections.push(`## Past Similar Decisions
${maybeRedact(formatEpisodes(context.episodicMemories.slice(0, 5)), opts)}`);
    }

    // Confidence levels for reference
    const confidenceLevels = Object.values(ConfidenceLevel).join(', ');

    sections.push(`## Instructions
Generate 2-5 candidate actions for this situation. Consider the user's preferences, past behavior, and traits.

Each candidate must be a JSON object with these exact fields:
- actionType: string (e.g., "archive_email", "pay_bill", "create_task")
- description: string (human-readable description)
- domain: string (same as situation domain)
- parameters: object (action-specific parameters)
- confidence: one of [${confidenceLevels}]
- reasoning: string (why this action fits)

Cost and reversibility are determined by the policy engine, not by you.
Respond with ONLY a JSON array of candidates (no markdown, no explanation):
[{ ... }, { ... }]`);
    // Safety invariant: estimatedCostCents and reversible are deliberately
    // NOT listed above. The response-parser hardcodes both to safe defaults
    // (see packages/llm-client/src/response-parser.ts:109-114). Pre-#411
    // the prompt asked the LLM for those fields anyway, which (a) burned
    // tokens on output the parser threw away and (b) created a future
    // foot-gun: a maintainer who wired the LLM values through to "honor"
    // the prompt would silently re-open the spend-cap bypass closed by
    // #372. Keep the prompt and parser aligned — the LLM does not get to
    // declare cost or reversibility.

    return sections.join('\n\n');
  },
};

function formatPreferences(prefs: Preference[]): string {
  return prefs
    .map((p) => `- [${p.domain}] ${p.key}: ${JSON.stringify(p.value)} (confidence: ${p.confidence}, source: ${p.source})`)
    .join('\n');
}

function formatPatterns(patterns: BehavioralPattern[]): string {
  return patterns
    .map((p) => `- ${p.observedAction} in ${p.trigger.domain} (freq: ${p.frequency}, confidence: ${p.confidence})`)
    .join('\n');
}

function formatTraits(traits: CrossDomainTrait[]): string {
  return traits
    .map((t) => `- ${t.traitName} (confidence: ${t.confidence}, domains: ${t.supportingDomains.join(', ')})`)
    .join('\n');
}

function formatEpisodes(episodes: EpisodicMemory[]): string {
  return episodes
    .map((e) => {
      const feedback = e.feedbackType ? ` → user ${e.feedbackType}` : '';
      return `- ${e.situationSummary}: took "${e.actionTaken}"${feedback}`;
    })
    .join('\n');
}
