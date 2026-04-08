import type { DecisionContext, DecisionObject, Preference, BehavioralPattern, CrossDomainTrait, EpisodicMemory } from '@skytwin/shared-types';
import { SituationType, ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Builds structured prompts for the LLM to interpret situations
 * and generate candidate actions.
 */
export const PromptBuilder = {
  /**
   * Build a prompt for situation interpretation (event classification).
   */
  buildSituationPrompt(rawEvent: Record<string, unknown>): string {
    const situationTypes = Object.values(SituationType).join(', ');

    return `You are SkyTwin, a personal AI assistant that classifies incoming events.

Given the following raw event, classify it into a structured decision object.

## Raw Event
${JSON.stringify(rawEvent, null, 2)}

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
  buildCandidatePrompt(decision: DecisionObject, context: DecisionContext): string {
    const sections: string[] = [];

    sections.push(`You are SkyTwin, a personal AI assistant generating possible actions for a user.`);

    // Situation
    sections.push(`## Situation
Type: ${decision.situationType}
Domain: ${decision.domain}
Urgency: ${decision.urgency}
Summary: ${decision.summary}
Raw data: ${JSON.stringify(decision.rawData, null, 2)}`);

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

    // Episodic memories (past similar decisions)
    if (context.episodicMemories && context.episodicMemories.length > 0) {
      sections.push(`## Past Similar Decisions
${formatEpisodes(context.episodicMemories.slice(0, 5))}`);
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
- estimatedCostCents: number (0 if free)
- reversible: boolean (can this action be undone?)
- confidence: one of [${confidenceLevels}]
- reasoning: string (why this action fits)

Respond with ONLY a JSON array of candidates (no markdown, no explanation):
[{ ... }, { ... }]`);

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
