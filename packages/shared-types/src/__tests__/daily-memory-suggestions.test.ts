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

  it('notes topic interest instead of drafting a reply to a newsletter', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'nl-1',
          content:
            'Breaking news: the House votes to end the conflict, in a bipartisan rebuke.',
          metadata: {
            authoringTier: 'inbox_newsletter',
            signalSource: 'gmail',
            fromAddress: 'breakingnews@nytimes.com',
          },
        }),
      ],
      older: [],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.actionPlan.actionType).toBe('create_note');
    expect(suggestions[0]!.actionPlan.actionType).not.toBe('draft_email');
    expect(suggestions[0]!.actionPlan.label).toMatch(/interest/i);
  });

  it.each(['inbox_newsletter', 'inbox_automated'])(
    'treats %s mail as topic-interest, never a reply draft',
    (tier) => {
      const suggestions = buildDailyMemorySuggestions({
        recent: [
          page({
            id: `bcast-${tier}`,
            content:
              'A roundup of platform changes and industry headlines worth being aware of this week.',
            metadata: {
              authoringTier: tier,
              signalSource: 'gmail',
              fromAddress: 'list@e.example.com',
            },
          }),
        ],
        older: [],
      });

      expect(suggestions[0]!.actionPlan.actionType).toBe('create_note');
    },
  );

  it('treats a no-reply sender as topic-interest even without an authoring tier', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'nr-1',
          content:
            'Your weekly product summary and the latest platform changes are ready to read.',
          metadata: { signalSource: 'gmail', fromAddress: 'no-reply@product.example' },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('create_note');
  });

  it("still offers a reply draft for a real person's inbound email", () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'person-1',
          content:
            'Maria asked whether the security review is still blocking procurement and wants a reply today.',
          metadata: {
            authoringTier: 'inbox_personal',
            signalSource: 'gmail',
            fromAddress: 'maria@acme.example',
          },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('draft_email');
  });

  it("drafts a reply for inbox_broadcast (a cc'd human thread), not a topic note", () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'bcast-human',
          content:
            'Priya looped in finance and asked you to send the revised Q3 figures to the thread by Friday.',
          metadata: {
            authoringTier: 'inbox_broadcast',
            signalSource: 'gmail',
            fromAddress: 'priya@acme.example',
          },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('draft_email');
  });

  it('does not mistake a real person whose local-part ends in a trigger word for bulk mail', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'person-trigger-word',
          content:
            'Mary asked whether the security review is still blocking procurement and wants a reply today.',
          metadata: { signalSource: 'gmail', fromAddress: 'mary.newsletter@acme.example' },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('draft_email');
  });

  it('files an idle-crawled document as a note, not a data-analysis action', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'file-report',
          content:
            'Q3 quarterly report: revenue metrics, churn analysis, and the full dataset of numbers.',
          source: 'file',
          metadata: { signalSource: 'file' },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('create_note');
    expect(suggestions[0]!.actionPlan.actionType).not.toBe('data_analysis');
  });

  it('never drafts a public social post from received / ambient content', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'ambient-social',
          content: 'A colleague mentioned you in a LinkedIn post about the product launch.',
          source: 'file',
          metadata: { signalSource: 'file' },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('create_note');
    expect(suggestions[0]!.actionPlan.actionType).not.toBe('draft_social_post');
  });

  it('still infers an active action for a user-authored voice note', () => {
    const suggestions = buildDailyMemorySuggestions({
      recent: [
        page({
          id: 'voice-social',
          content: 'I should post about the launch on LinkedIn this afternoon.',
          source: 'voice',
          metadata: { signalSource: 'voice' },
        }),
      ],
      older: [],
    });

    expect(suggestions[0]!.actionPlan.actionType).toBe('draft_social_post');
  });
});
