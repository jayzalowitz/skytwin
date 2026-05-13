/**
 * End-to-end loop test for #251 Phase 5.
 *
 * Exercises the full composition of Phase 1 (authoringTier-aware
 * retrieval), Phase 2 (relationshipTier composition), and Phase 4
 * (`DraftEmailCandidateGenerator`) through a single realistic scenario.
 *
 * The scenario: a user has accumulated a handful of `user_sent_*`
 * emails (authored corpus) and a bunch of received-newsletter noise.
 * An inbound `requiresResponse: true` email lands; the generator
 * should produce one `draft_email` candidate whose context comes
 * exclusively from the authored examples — NOT the newsletters.
 *
 * This isn't a deep eval; the per-piece evals live in their own files
 * (Phase 1 ablation, Phase 2 relationship-tier tests). This is the
 * "do the layers actually compose end-to-end" smoke test that the
 * marquee Phase 4 feature stays wired correctly.
 *
 * No real LLM and no real CRDB — both are doubled. The whole point
 * here is the dataflow, not the embedding quality.
 */

import { describe, it, expect } from 'vitest';
import {
  SituationType,
  type DecisionContext,
  type DecisionObject,
  type TwinProfile,
} from '@skytwin/shared-types';
import type { LlmClient } from '@skytwin/llm-client';
import {
  DraftEmailCandidateGenerator,
  type AuthoredExamplesPort,
} from '../strategies/draft-email-candidate.js';

/**
 * In-memory corpus item — what a brain_pages row carries that we care
 * about for the AuthoredExamplesPort adapter.
 */
interface CorpusPage {
  id: string;
  content: string;
  subject?: string;
  metadata: {
    authoringTier?: string;
    relationshipTier?: string;
    fromAddress?: string;
  };
}

/**
 * Phase 5 wiring example: an `AuthoredExamplesPort` adapter over a
 * simple in-memory corpus. Filters to `user_sent_*` tiers (Phase 1) so
 * draft examples only come from things the user has actually written;
 * orders by a naive token-overlap score so the test is deterministic.
 *
 * Real production wiring will sit on top of `MemoryPort.searchSemantic`
 * with an `authoringTier IN (...)` filter pushed down to the SQL layer.
 * This adapter shows the contract the generator depends on.
 */
class AuthoredCorpusAdapter implements AuthoredExamplesPort {
  constructor(private readonly corpus: CorpusPage[]) {}

  async searchAuthoredExamples(query: string, k: number) {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const authored = this.corpus.filter((p) => {
      const t = p.metadata.authoringTier ?? '';
      return t === 'user_sent_originated' || t === 'user_sent_reply';
    });
    const scored = authored.map((p) => {
      const text = `${p.subject ?? ''} ${p.content}`.toLowerCase();
      const overlap = tokens.reduce(
        (n, t) => n + (text.includes(t) ? 1 : 0),
        0,
      );
      // Phase 2 spirit: nudge `core` contacts higher when overlap ties.
      const relBoost = p.metadata.relationshipTier === 'core' ? 0.1 : 0;
      return { p, score: overlap + relBoost };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, k)
      .map(({ p }) => ({ content: p.content, subject: p.subject }));
  }
}

/**
 * Fake LLM that produces a draft body the test can inspect. Records
 * the prompt so we can assert it contained the authored examples.
 */
function makeLlm() {
  const calls: Array<{ prompt: string; system: string | undefined }> = [];
  const client = {
    generate: async (
      prompt: string,
      options: { systemPrompt?: string },
    ): Promise<{
      content: string;
      provider: string;
      model: string;
      latencyMs: number;
    }> => {
      calls.push({ prompt, system: options.systemPrompt });
      return {
        content:
          'Thanks for the note — Tuesday works on my end. ' +
          'Sending a calendar hold now, will flag if anything shifts.',
        provider: 'fake',
        model: 'fake-1',
        latencyMs: 1,
      };
    },
  } as unknown as LlmClient;
  return { client, calls };
}

const PROFILE: TwinProfile = {
  id: 'p-loop',
  userId: 'u-loop',
  version: 1,
  preferences: [],
  inferences: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CONTEXT: DecisionContext = {
  userId: 'u-loop',
  decision: {} as DecisionObject,
  trustTier: 'moderate_autonomy' as DecisionContext['trustTier'],
  relevantPreferences: [],
  timestamp: new Date(),
  patterns: [],
  traits: [],
  temporalProfile: {
    userId: 'u-loop',
    activeHours: { start: 8, end: 18 },
    peakResponseTimes: {},
    weekdayPatterns: {},
    urgencyThresholds: {},
  },
};

/**
 * The user's corpus: 4 authored emails (Phase 1 tier = user_sent_*),
 * 3 received newsletters (Phase 1 tier = inbox_newsletter). The
 * authored set is what the generator should pull from; the newsletter
 * set is noise the adapter must filter out.
 */
function buildCorpus(): CorpusPage[] {
  return [
    // Authored — should be eligible for few-shot.
    {
      id: 'p-a1',
      content:
        'Sounds good on Tuesday. Sending a hold now and will flag if anything shifts on my end.',
      subject: 'Re: sync',
      metadata: {
        authoringTier: 'user_sent_reply',
        relationshipTier: 'core',
        fromAddress: 'user@example.com',
      },
    },
    {
      id: 'p-a2',
      content:
        'Let me check my calendar and circle back later today. Probably best to find a 30-min slot.',
      subject: 'Re: timing on the review',
      metadata: {
        authoringTier: 'user_sent_reply',
        relationshipTier: 'frequent',
        fromAddress: 'user@example.com',
      },
    },
    {
      id: 'p-a3',
      content:
        'Thanks for the heads-up — picking this up first thing in the morning.',
      subject: 'Re: timeline question',
      metadata: {
        authoringTier: 'user_sent_reply',
        relationshipTier: 'frequent',
        fromAddress: 'user@example.com',
      },
    },
    {
      id: 'p-a4',
      content:
        'Wanted to flag something on the Q2 plan — happy to walk through it whenever you have 15 min.',
      subject: 'Quick thought on Q2',
      metadata: {
        authoringTier: 'user_sent_originated',
        relationshipTier: 'core',
        fromAddress: 'user@example.com',
      },
    },
    // Received noise — must NOT appear in the prompt.
    {
      id: 'p-n1',
      content:
        'Top stories this week: database releases, AI infra, and the latest VC moves.',
      subject: 'Weekly tech roundup',
      metadata: {
        authoringTier: 'inbox_newsletter',
        fromAddress: 'newsletter@bigtech.example',
      },
    },
    {
      id: 'p-n2',
      content: 'Your order has shipped. Estimated delivery Wednesday.',
      subject: 'Your order has shipped',
      metadata: {
        authoringTier: 'inbox_automated',
        fromAddress: 'orders@retailer.example',
      },
    },
    {
      id: 'p-n3',
      content: 'Special offer: 20% off everything this week only.',
      subject: 'Limited time offer',
      metadata: {
        authoringTier: 'inbox_newsletter',
        fromAddress: 'promos@retailer.example',
      },
    },
  ];
}

function makeInboundDecision(): DecisionObject {
  return {
    id: 'd-inbound-1',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'medium',
    summary: 'Reply needed',
    rawData: {
      emailId: 'msg-inbound-001',
      from: 'colleague@example.com',
      subject: 'Quick sync Tuesday?',
      body:
        'Can we grab 30 minutes Tuesday to talk through the review feedback? ' +
        'Mornings work better for me but happy to flex.',
      requiresResponse: true,
    },
    interpretedAt: new Date(),
  };
}

describe('#251 Phase 5 — end-to-end Phase 1+2+4 loop', () => {
  it('drafts a reply using only the user\'s authored corpus', async () => {
    const corpus = buildCorpus();
    const adapter = new AuthoredCorpusAdapter(corpus);
    const { client, calls } = makeLlm();

    const generator = new DraftEmailCandidateGenerator(client, adapter);
    const candidates = await generator.generate(
      makeInboundDecision(),
      PROFILE,
      CONTEXT,
    );

    // One draft_email candidate produced.
    expect(candidates).toHaveLength(1);
    const draft = candidates[0]!;
    expect(draft.actionType).toBe('draft_email');
    expect(draft.reversible).toBe(true);

    // Body matches the LLM stub (= the generator did call it and used
    // the response without rewriting it).
    expect(draft.parameters['draftBody']).toContain('Tuesday works');

    // Phase 1 axis: ALL examples in the prompt must come from the
    // authored corpus. No newsletter / automated bodies leaked in.
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('Sounds good on Tuesday'); // authored
    expect(prompt).toContain('Thanks for the heads-up'); // authored
    expect(prompt).not.toContain('Weekly tech roundup'); // newsletter
    expect(prompt).not.toContain('Your order has shipped'); // automated
    expect(prompt).not.toContain('Special offer'); // promo newsletter

    // Phase 4: prompt is the canonical voice-grounding prompt
    expect(calls[0]!.system).toMatch(/voice/i);
    expect(prompt).toContain('Draft the reply body');

    // examplesUsed reflects the authored count (4)
    expect(draft.parameters['examplesUsed']).toBe(4);
  });

  it('falls back to LOW-confidence draft when authored corpus is empty', async () => {
    // Only newsletter / automated noise in the corpus — adapter filters
    // these out, so the generator sees zero examples. The Phase 4
    // contract says "still draft, but mark LOW and flag voice-match
    // weakness in reasoning."
    const corpus = buildCorpus().filter(
      (p) =>
        p.metadata.authoringTier !== 'user_sent_originated' &&
        p.metadata.authoringTier !== 'user_sent_reply',
    );
    const adapter = new AuthoredCorpusAdapter(corpus);
    const { client, calls } = makeLlm();
    const generator = new DraftEmailCandidateGenerator(client, adapter);

    const candidates = await generator.generate(
      makeInboundDecision(),
      PROFILE,
      CONTEXT,
    );
    expect(candidates).toHaveLength(1);
    const draft = candidates[0]!;
    expect(draft.parameters['examplesUsed']).toBe(0);
    expect(draft.reasoning).toMatch(/without authored-context grounding/);

    // Prompt still has the inbound; just no examples block.
    expect(calls[0]!.prompt).toContain('Quick sync Tuesday');
    expect(calls[0]!.prompt).toContain('No prior authored examples available');
  });

  it('skips drafting when the inbound does not need a reply', async () => {
    const corpus = buildCorpus();
    const adapter = new AuthoredCorpusAdapter(corpus);
    const { client, calls } = makeLlm();
    const generator = new DraftEmailCandidateGenerator(client, adapter);

    const decision = makeInboundDecision();
    (decision.rawData as Record<string, unknown>)['requiresResponse'] = false;

    const candidates = await generator.generate(decision, PROFILE, CONTEXT);
    expect(candidates).toHaveLength(0);
    // LLM was never invoked — important for cost gating.
    expect(calls).toHaveLength(0);
  });

  it('Phase 2 in spirit: core-relationship authored examples surface first', async () => {
    // Both authored emails have the same topical overlap ("Tuesday"),
    // but one is from a `core` contact and one isn't. With the
    // adapter's small core-relBoost (mirroring Phase 2's bonus), the
    // core-tagged example should come first.
    const corpus: CorpusPage[] = [
      {
        id: 'p-core',
        content:
          'Tuesday at 10 works perfectly — happy to lock that in. Sending a hold.',
        subject: 'Re: Tuesday meeting',
        metadata: {
          authoringTier: 'user_sent_reply',
          relationshipTier: 'core',
        },
      },
      {
        id: 'p-occasional',
        content:
          'Tuesday afternoon might work. Let me confirm and get back to you.',
        subject: 'Re: Tuesday timing',
        metadata: {
          authoringTier: 'user_sent_reply',
          relationshipTier: 'occasional',
        },
      },
    ];
    const adapter = new AuthoredCorpusAdapter(corpus);
    const { client, calls } = makeLlm();
    const generator = new DraftEmailCandidateGenerator(client, adapter, 2);

    await generator.generate(makeInboundDecision(), PROFILE, CONTEXT);
    const prompt = calls[0]!.prompt;

    // Both examples appear in the prompt.
    expect(prompt).toContain('Tuesday at 10 works perfectly');
    expect(prompt).toContain('Tuesday afternoon might work');
    // Core-tagged example renders as Example 1 (earlier in the prompt).
    const coreIdx = prompt.indexOf('Tuesday at 10 works perfectly');
    const occasionalIdx = prompt.indexOf('Tuesday afternoon might work');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(occasionalIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(occasionalIdx);
  });
});
