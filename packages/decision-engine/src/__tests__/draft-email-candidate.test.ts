import { describe, it, expect, vi } from 'vitest';
import {
  ConfidenceLevel,
  SituationType,
  type DecisionContext,
  type DecisionObject,
  type TwinProfile,
} from '@skytwin/shared-types';
import type { LlmClient } from '@skytwin/llm-client';
import {
  DraftEmailCandidateGenerator,
  buildDraftPrompt,
  DEFAULT_AUTHORED_EXAMPLE_COUNT,
  MAX_EXAMPLE_CHARS,
  type AuthoredExamplesPort,
} from '../strategies/draft-email-candidate.js';

/**
 * Minimal LlmClient double — only `.generate()` is touched. Cast to
 * `LlmClient` keeps the public class private to the package.
 */
function makeFakeLlm(
  responseContent: string,
  opts: { throwOnGenerate?: boolean } = {},
): { client: LlmClient; calls: Array<{ prompt: unknown; options: unknown }> } {
  const calls: Array<{ prompt: unknown; options: unknown }> = [];
  const client = {
    generate: async (prompt: unknown, options: unknown) => {
      calls.push({ prompt, options });
      if (opts.throwOnGenerate) throw new Error('llm-down');
      return {
        content: responseContent,
        provider: 'anthropic',
        model: 'fake',
        latencyMs: 1,
      };
    },
  } as unknown as LlmClient;
  return { client, calls };
}

function makeFakeExamples(
  examples: Array<{ content: string; subject?: string }>,
  opts: { throwOnSearch?: boolean } = {},
): { port: AuthoredExamplesPort; calls: Array<{ query: string; k: number }> } {
  const calls: Array<{ query: string; k: number }> = [];
  const port: AuthoredExamplesPort = {
    searchAuthoredExamples: async (query: string, k: number) => {
      calls.push({ query, k });
      if (opts.throwOnSearch) throw new Error('memory-down');
      return examples;
    },
  };
  return { port, calls };
}

const PROFILE: TwinProfile = {
  id: 'p',
  userId: 'u',
  version: 1,
  preferences: [],
  inferences: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const CONTEXT: DecisionContext = {
  userId: 'u',
  decision: {} as DecisionObject,
  trustTier: 'moderate_autonomy' as DecisionContext['trustTier'],
  relevantPreferences: [],
  timestamp: new Date(),
  patterns: [],
  traits: [],
  temporalProfile: {
    userId: 'u',
    activeHours: { start: 8, end: 18 },
    peakResponseTimes: {},
    weekdayPatterns: {},
    urgencyThresholds: {},
  },
};

function makeEmailDecision(args: {
  requiresResponse?: boolean;
  domain?: string;
  subject?: string;
  body?: string;
  from?: string;
  emailId?: string;
}): DecisionObject {
  return {
    id: 'd-' + Math.random().toString(36).slice(2, 8),
    situationType: SituationType.EMAIL_TRIAGE,
    domain: args.domain ?? 'email',
    urgency: 'medium',
    summary: args.subject ?? '',
    rawData: {
      emailId: args.emailId ?? 'msg-1',
      from: args.from ?? 'partner@example.com',
      subject: args.subject ?? '',
      body: args.body ?? '',
      requiresResponse: args.requiresResponse ?? true,
    },
    interpretedAt: new Date(),
  };
}

describe('DraftEmailCandidateGenerator — domain gating', () => {
  it('returns no candidates for non-email decisions', async () => {
    const { client } = makeFakeLlm('reply body');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision = makeEmailDecision({ domain: 'calendar' });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out).toHaveLength(0);
  });

  it('returns no candidates when requiresResponse is false', async () => {
    const { client } = makeFakeLlm('reply body');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision = makeEmailDecision({ requiresResponse: false });
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out).toHaveLength(0);
  });

  it('returns no candidates when requiresResponse is missing', async () => {
    const { client } = makeFakeLlm('reply body');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision: DecisionObject = {
      id: 'd-no-flag',
      situationType: SituationType.EMAIL_TRIAGE,
      domain: 'email',
      urgency: 'low',
      summary: '',
      rawData: { emailId: 'x', from: 'a@b.c', subject: 's' },
      interpretedAt: new Date(),
    };
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out).toHaveLength(0);
  });
});

describe('DraftEmailCandidateGenerator — happy path', () => {
  it('returns a draft_email candidate with the LLM body', async () => {
    const { client, calls } = makeFakeLlm('Thanks for the note — let me check and get back to you.');
    const { port, calls: searchCalls } = makeFakeExamples([
      { content: 'Sounds good — Tuesday works.', subject: 'Re: sync' },
      { content: 'Let me check my calendar.', subject: 'Re: timing' },
      { content: 'Thanks for the heads-up.' },
    ]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision = makeEmailDecision({
      subject: 'Quick question',
      body: 'Are you free Tuesday?\nLet me know.',
      from: 'colleague@example.com',
      emailId: 'msg-42',
    });
    const out = await gen.generate(decision, PROFILE, CONTEXT);

    expect(out).toHaveLength(1);
    const c = out[0]!;
    expect(c.actionType).toBe('draft_email');
    expect(c.domain).toBe('email');
    expect(c.reversible).toBe(true);
    expect(c.estimatedCostCents).toBe(0);
    expect(c.parameters['emailId']).toBe('msg-42');
    expect(c.parameters['replyToFrom']).toBe('colleague@example.com');
    expect(c.parameters['replyToSubject']).toBe('Quick question');
    expect(c.parameters['draftBody']).toBe(
      'Thanks for the note — let me check and get back to you.',
    );
    expect(c.parameters['examplesUsed']).toBe(3);
    // 3 examples → MEDIUM confidence
    expect(c.confidence).toBe(ConfidenceLevel.MODERATE);
    expect(c.reasoning).toMatch(/3 similar emails/);

    // Memory port was queried with the right shape
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]!.k).toBe(DEFAULT_AUTHORED_EXAMPLE_COUNT);
    expect(searchCalls[0]!.query).toContain('Quick question');
    expect(searchCalls[0]!.query).toContain('Are you free Tuesday?');
    expect(searchCalls[0]!.query).toContain('colleague@example.com');

    // LLM was invoked with a system prompt and temperature ≈ 0.5
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]!.prompt).toBe('string');
    const opts = calls[0]!.options as { temperature?: number; systemPrompt?: string };
    expect(opts.temperature).toBe(0.5);
    expect(opts.systemPrompt).toMatch(/voice/i);
  });

  it('honors a custom exampleCount', async () => {
    const { client } = makeFakeLlm('draft');
    const { port, calls } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port, 2);
    await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(calls[0]!.k).toBe(2);
  });

  it('trims whitespace from the LLM response body', async () => {
    const { client } = makeFakeLlm('   \n  Final draft body.   \n\n');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out[0]!.parameters['draftBody']).toBe('Final draft body.');
  });
});

describe('DraftEmailCandidateGenerator — confidence', () => {
  it('LOW confidence with fewer than 3 examples', async () => {
    const { client } = makeFakeLlm('body');
    const { port } = makeFakeExamples([
      { content: 'one' },
      { content: 'two' },
    ]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out[0]!.confidence).toBe(ConfidenceLevel.LOW);
  });

  it('MEDIUM confidence with 3 or more examples', async () => {
    const { client } = makeFakeLlm('body');
    const { port } = makeFakeExamples([
      { content: 'one' },
      { content: 'two' },
      { content: 'three' },
    ]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out[0]!.confidence).toBe(ConfidenceLevel.MODERATE);
  });

  it('LOW confidence with zero examples and the right reasoning copy', async () => {
    const { client } = makeFakeLlm('body');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out[0]!.confidence).toBe(ConfidenceLevel.LOW);
    expect(out[0]!.reasoning).toMatch(/without authored-context grounding/);
  });
});

describe('DraftEmailCandidateGenerator — failure modes', () => {
  it('fails open on memory port error — still drafts with no examples', async () => {
    const { client, calls: llmCalls } = makeFakeLlm('Best, X');
    const { port } = makeFakeExamples([], { throwOnSearch: true });
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out).toHaveLength(1);
    expect(out[0]!.parameters['examplesUsed']).toBe(0);
    expect(out[0]!.confidence).toBe(ConfidenceLevel.LOW);
    // LLM still got called
    expect(llmCalls).toHaveLength(1);
  });

  it('returns no candidate when the LLM call fails', async () => {
    const { client } = makeFakeLlm('', { throwOnGenerate: true });
    const { port } = makeFakeExamples([{ content: 'one' }]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out).toHaveLength(0);
  });

  it('returns no candidate when the LLM produces an empty body', async () => {
    const { client } = makeFakeLlm('   \n\n   ');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const out = await gen.generate(makeEmailDecision({ subject: 's' }), PROFILE, CONTEXT);
    expect(out).toHaveLength(0);
  });
});

describe('DraftEmailCandidateGenerator — rawData fallbacks', () => {
  it('falls back to snippet when body is missing', async () => {
    const { client } = makeFakeLlm('reply');
    const { port, calls } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision: DecisionObject = {
      id: 'd1',
      situationType: SituationType.EMAIL_TRIAGE,
      domain: 'email',
      urgency: 'medium',
      summary: '',
      rawData: {
        emailId: 'm1',
        from: 'sender@example.com',
        subject: 'Hi',
        snippet: 'First line from snippet\nrest is truncated',
        requiresResponse: true,
      },
      interpretedAt: new Date(),
    };
    await gen.generate(decision, PROFILE, CONTEXT);
    expect(calls[0]!.query).toContain('First line from snippet');
  });

  it('uses messageId when emailId is absent', async () => {
    const { client } = makeFakeLlm('reply');
    const { port } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision: DecisionObject = {
      id: 'd2',
      situationType: SituationType.EMAIL_TRIAGE,
      domain: 'email',
      urgency: 'medium',
      summary: '',
      rawData: {
        messageId: 'mid-7',
        from: 'a@b.c',
        subject: 's',
        body: 'b',
        requiresResponse: true,
      },
      interpretedAt: new Date(),
    };
    const out = await gen.generate(decision, PROFILE, CONTEXT);
    expect(out[0]!.parameters['emailId']).toBe('mid-7');
  });
});

describe('buildDraftPrompt', () => {
  it('emits authored examples block when examples present', () => {
    const prompt = buildDraftPrompt({
      inboundFrom: 'sender@example.com',
      inboundSubject: 'Hello',
      inboundBody: 'Body.',
      examples: [
        { content: 'Voice sample 1', subject: 'Re: foo' },
        { content: 'Voice sample 2' },
      ],
    });
    expect(prompt).toContain('Match their voice');
    expect(prompt).toContain('Example 1');
    expect(prompt).toContain('(subject: "Re: foo")');
    expect(prompt).toContain('Voice sample 1');
    expect(prompt).toContain('Example 2');
    expect(prompt).toContain('Voice sample 2');
    expect(prompt).toContain('From: sender@example.com');
    expect(prompt).toContain('Subject: Hello');
    expect(prompt).toContain('Body.');
    expect(prompt).toContain('Draft the reply body');
  });

  it('emits no-examples warning copy when examples is empty', () => {
    const prompt = buildDraftPrompt({
      inboundFrom: 'sender@example.com',
      inboundSubject: 'Hi',
      inboundBody: 'B',
      examples: [],
    });
    expect(prompt).toContain('No prior authored examples available');
    expect(prompt).not.toContain('Example 1');
  });

  it('truncates examples longer than MAX_EXAMPLE_CHARS', () => {
    const huge = 'A'.repeat(MAX_EXAMPLE_CHARS + 500);
    const prompt = buildDraftPrompt({
      inboundFrom: 'x',
      inboundSubject: 'y',
      inboundBody: 'z',
      examples: [{ content: huge }],
    });
    // The truncated block should contain a run of exactly MAX_EXAMPLE_CHARS
    // 'A's — and NOT any longer run (we cut at the cap).
    expect(prompt).toContain('A'.repeat(MAX_EXAMPLE_CHARS));
    expect(prompt).not.toContain('A'.repeat(MAX_EXAMPLE_CHARS + 1));
  });

  it('uses placeholder text when inbound fields are empty', () => {
    const prompt = buildDraftPrompt({
      inboundFrom: '',
      inboundSubject: '',
      inboundBody: '',
      examples: [],
    });
    expect(prompt).toContain('From: (unknown sender)');
    expect(prompt).toContain('Subject: (no subject)');
    expect(prompt).toContain('(empty body)');
  });
});

describe('DraftEmailCandidateGenerator — query construction', () => {
  it('caps the query at 500 chars', async () => {
    const { client } = makeFakeLlm('reply');
    const { port, calls } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const longSubject = 'S'.repeat(600);
    await gen.generate(
      makeEmailDecision({ subject: longSubject, body: 'b' }),
      PROFILE,
      CONTEXT,
    );
    expect(calls[0]!.query.length).toBeLessThanOrEqual(500);
  });

  it('drops empty fields from the query', async () => {
    const { client } = makeFakeLlm('reply');
    const { port, calls } = makeFakeExamples([]);
    const gen = new DraftEmailCandidateGenerator(client, port);
    const decision: DecisionObject = {
      id: 'd3',
      situationType: SituationType.EMAIL_TRIAGE,
      domain: 'email',
      urgency: 'medium',
      summary: '',
      rawData: {
        emailId: 'mx',
        from: '',
        subject: 'Only subject here',
        body: '',
        requiresResponse: true,
      },
      interpretedAt: new Date(),
    };
    await gen.generate(decision, PROFILE, CONTEXT);
    // No double spaces from empty join fields
    expect(calls[0]!.query).toBe('Only subject here');
  });
});

// Quiet a vitest warning about unused imports if a refactor drops these.
void vi;
