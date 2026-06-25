import { describe, expect, it } from 'vitest';
import {
  buildDailyMemorySuggestions,
  type DailyMemorySuggestionPage,
} from '../daily-memory-suggestions.js';

function page(over: Partial<DailyMemorySuggestionPage> & Pick<DailyMemorySuggestionPage, 'id' | 'content'>): DailyMemorySuggestionPage {
  return {
    title: null,
    source: 'signal',
    sourceRef: over.id,
    metadata: {},
    createdAt: new Date('2026-06-25T12:00:00Z'),
    ...over,
  };
}

describe('buildDailyMemorySuggestions', () => {
  it('prefers a novel connection between today and older memory', () => {
    const suggestions = buildDailyMemorySuggestions({
      now: new Date('2026-06-25T12:00:00Z'),
      recent: [
        page({
          id: 'recent-1',
          content: 'Acme renewal thread: Maria asked whether the security review is still blocking procurement.',
          metadata: { signalSource: 'gmail', fromAddress: 'maria@acme.example' },
        }),
      ],
      older: [
        page({
          id: 'older-1',
          content: 'Acme security review was blocked on the vendor SOC2 packet and procurement wanted a one-page exception memo.',
          createdAt: new Date('2026-05-10T12:00:00Z'),
          metadata: { signalSource: 'gmail', fromAddress: 'maria@acme.example' },
        }),
      ],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      novelty: 'connection',
      memoryRefs: ['recent-1', 'older-1'],
      actionPlan: {
        actionType: 'draft_email',
        primaryAdapter: 'ironclaw',
        readiness: 'known_action_type',
        runtimeVersion: {
          runtime: 'ironclaw',
          stableVersion: '0.29.1',
        },
      },
    });
    expect(suggestions[0]!.reason).toMatch(/older memory|week-old|month-old/i);
    expect(suggestions[0]!.suggestedAction).toMatch(/IronClaw|draft_email/i);
  });

  it('falls back to resurfacing recent memory when there is no older match', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'recent-1',
          content: 'I will send the revised Madrid launch checklist to the team tomorrow morning.',
          metadata: { authoringTier: 'user_sent_originated', signalSource: 'voice' },
        }),
      ],
      older: [
        page({
          id: 'older-1',
          content: 'Completely unrelated grocery receipt from last month.',
          createdAt: new Date('2026-05-10T12:00:00Z'),
        }),
      ],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      novelty: 'resurface',
      memoryRefs: ['recent-1'],
      actionPlan: {
        primaryAdapter: 'ironclaw',
        readiness: 'known_action_type',
      },
    });
    expect(suggestions[0]!.suggestedAction).toMatch(/IronClaw|set_reminder|create_task/i);
  });

  it('does not suggest hidden or tiny memory pages', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'hidden',
          content: 'This hidden page has enough text but should never appear in the report.',
          metadata: { userOverride: 'hidden' },
        }),
        page({ id: 'tiny', content: 'too short' }),
      ],
      older: [],
    });

    expect(suggestions).toEqual([]);
  });

  it('does not treat a null hidden_at marker as hidden', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'visible-null-hidden-at',
          content: 'I will send the revised Madrid launch checklist to the team tomorrow morning.',
          metadata: { hidden_at: null, authoringTier: 'user_sent_originated' },
        }),
        page({
          id: 'hidden-timestamp',
          content: 'This page has a hidden timestamp and should not appear in suggestions.',
          metadata: { hidden_at: '2026-06-25T10:00:00Z' },
        }),
      ],
      older: [],
      maxSuggestions: 3,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.memoryRefs).toEqual(['visible-null-hidden-at']);
  });

  it('sorts recent memory by creation time before resurfacing', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'older-recent',
          content: 'I will send the Madrid launch checklist to the team tomorrow morning.',
          createdAt: new Date('2026-06-25T08:00:00Z'),
        }),
        page({
          id: 'newer-recent',
          content: 'I will send the revised Madrid budget checklist to finance tomorrow morning.',
          createdAt: new Date('2026-06-25T14:00:00Z'),
        }),
      ],
      older: [],
      maxSuggestions: 1,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.memoryRefs).toEqual(['newer-recent']);
  });
});
