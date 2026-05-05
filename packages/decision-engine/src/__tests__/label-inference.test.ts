import { describe, it, expect, vi } from 'vitest';
import {
  DecisionMaker,
  type LabelInferencePort,
  type SenderLabelHint,
} from '../decision-maker.js';
import type {
  DecisionContext,
  DecisionObject,
  TwinProfile,
} from '@skytwin/shared-types';
import {
  ConfidenceLevel,
  SituationType,
  TrustTier,
} from '@skytwin/shared-types';

// ── Minimal mocks (mirrors the shape used in decision-maker.test.ts) ──

function createMockTwinService() {
  const profile: TwinProfile = {
    id: 'twin_test',
    userId: 'user_test',
    version: 1,
    preferences: [],
    inferences: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return {
    getOrCreateProfile: vi.fn().mockResolvedValue(profile),
    getRelevantPreferences: vi.fn().mockResolvedValue([]),
  };
}

function createMockPolicy() {
  return {
    evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: true, reason: 'ok' }),
    loadPolicies: vi.fn().mockResolvedValue([]),
  };
}

function createMockDecisionRepo() {
  return {
    saveOutcome: vi.fn().mockResolvedValue(undefined),
    saveRiskAssessment: vi.fn().mockResolvedValue(undefined),
    saveCandidates: vi.fn().mockResolvedValue(undefined),
  };
}

function createEmailDecision(overrides?: Partial<DecisionObject>): DecisionObject {
  return {
    id: 'dec_test_001',
    situationType: SituationType.EMAIL_TRIAGE,
    domain: 'email',
    urgency: 'low',
    summary: 'Email triage',
    rawData: {
      from: 'rangers@blackrockrangers.org',
      subject: 'Routine list update',
      emailId: 'msg_1',
    },
    interpretedAt: new Date(),
    ...overrides,
  };
}

function createContext(decision: DecisionObject, port?: LabelInferencePort): {
  context: DecisionContext;
  dm: DecisionMaker;
} {
  const dm = new DecisionMaker(
    createMockTwinService() as never,
    createMockPolicy() as never,
    createMockDecisionRepo() as never,
    undefined,
    port,
  );
  return {
    dm,
    context: {
      userId: 'user_test',
      decision,
      trustTier: TrustTier.MODERATE_AUTONOMY,
      relevantPreferences: [],
      timestamp: new Date(),
    },
  };
}

function findLabelCandidate(outcome: { allCandidates: Array<{ actionType: string; parameters: Record<string, unknown>; confidence: ConfidenceLevel }> }) {
  return outcome.allCandidates.find((c) => c.actionType === 'label_email');
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('inferLabels (issue #122)', () => {
  it('uses learned sender labels when count meets the trust threshold', async () => {
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([
        { label: 'rangers', count: 18 },
        { label: 'community', count: 5 },
      ] satisfies SenderLabelHint[]),
      topLabelsForListId: vi.fn().mockResolvedValue([]),
    };

    const { dm, context } = createContext(createEmailDecision(), port);
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    expect(labelCandidate).toBeDefined();
    expect(labelCandidate!.parameters['labels']).toEqual(['rangers', 'community']);
    // Strong evidence (≥5 sightings of top label) → HIGH confidence.
    expect(labelCandidate!.confidence).toBe(ConfidenceLevel.HIGH);
    expect(port.topLabelsForSender).toHaveBeenCalledWith('user_test', 'rangers@blackrockrangers.org', 5);
  });

  it('falls back to subject keywords when sender has no history', async () => {
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([]),
      topLabelsForListId: vi.fn().mockResolvedValue([]),
    };

    const decision = createEmailDecision({
      rawData: {
        from: 'unknown@example.com',
        subject: 'Your invoice is ready',
        emailId: 'msg_2',
      },
    });
    const { dm, context } = createContext(decision, port);
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    expect(labelCandidate).toBeDefined();
    expect(labelCandidate!.parameters['labels']).toEqual(['finance']);
    // Pure keyword fallback → LOW confidence so policy gates it.
    expect(labelCandidate!.confidence).toBe(ConfidenceLevel.LOW);
  });

  it('filters Gmail system labels from suggestions', async () => {
    // INBOX, IMPORTANT, CATEGORY_PROMOTIONS are Gmail's own — meaningless to
    // suggest applying. Only the user-defined "receipts" should make it through.
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([
        { label: 'INBOX', count: 50 },
        { label: 'CATEGORY_PROMOTIONS', count: 30 },
        { label: 'receipts', count: 12 },
      ]),
      topLabelsForListId: vi.fn().mockResolvedValue([]),
    };

    const { dm, context } = createContext(
      createEmailDecision({ rawData: { from: 'no-reply@stripe.com', subject: 'Receipt #4421', emailId: 'm' } }),
      port,
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    expect(labelCandidate!.parameters['labels']).toEqual(['receipts']);
  });

  it('ignores hints with insufficient evidence (count < 2) and falls back', async () => {
    // One observation could be a misclick; we wait for two before trusting.
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([
        { label: 'rangers', count: 1 },
      ]),
      topLabelsForListId: vi.fn().mockResolvedValue([]),
    };

    const { dm, context } = createContext(
      createEmailDecision({
        rawData: { from: 'rare@example.com', subject: 'invite to meeting', emailId: 'm' },
      }),
      port,
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    // Falls back to keyword classifier → matches "meeting".
    expect(labelCandidate!.parameters['labels']).toContain('meetings');
  });

  it('consults List-Id as a secondary signal when sender has no history', async () => {
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([]),
      topLabelsForListId: vi.fn().mockResolvedValue([
        { label: 'rangers', count: 30 },
      ]),
    };

    const { dm, context } = createContext(
      createEmailDecision({
        rawData: {
          // Per-message sender varies (mailing-list relay), but List-Id is stable.
          from: 'jay+forward@blackrockrangers.org',
          listId: 'rangers.lists.example.org',
          subject: 'Routine list update',
          emailId: 'm',
        },
      }),
      port,
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    expect(labelCandidate!.parameters['labels']).toEqual(['rangers']);
    expect(port.topLabelsForListId).toHaveBeenCalledWith('user_test', 'rangers.lists.example.org', 5);
  });

  it('normalizes "Display Name <addr>" before querying the port', async () => {
    const topLabelsForSender = vi.fn().mockResolvedValue([]);
    const port: LabelInferencePort = {
      topLabelsForSender,
      topLabelsForListId: vi.fn().mockResolvedValue([]),
    };

    const { dm, context } = createContext(
      createEmailDecision({
        rawData: {
          from: 'Black Rock Rangers <rangers@BlackRockRangers.org>',
          subject: 'hi',
          emailId: 'm',
        },
      }),
      port,
    );
    await dm.evaluate(context);

    // Lookup must use the bare lowercase address — both write side (connector)
    // and read side (decision-maker) agree on this normalization.
    expect(topLabelsForSender).toHaveBeenCalledWith(
      'user_test',
      'rangers@blackrockrangers.org',
      5,
    );
  });

  it('degrades gracefully when the port throws (keyword fallback)', async () => {
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockRejectedValue(new Error('db is down')),
      topLabelsForListId: vi.fn().mockResolvedValue([]),
    };

    const { dm, context } = createContext(
      createEmailDecision({
        rawData: { from: 'sender@example.com', subject: 'urgent: please review', emailId: 'm' },
      }),
      port,
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    // Did not throw; fell back to keywords.
    expect(labelCandidate!.parameters['labels']).toEqual(['urgent']);
  });

  it('falls through to List-Id when sender hints are all sub-threshold (post-/review fix)', async () => {
    // Pre-fix bug: a single count=1 sender row would short-circuit the
    // List-Id fallback even though the listId had rich data. For mailing
    // lists where per-message From: rotates, this masked the strongest
    // signal we had.
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([
        { label: 'rangers', count: 1 }, // sub-threshold
      ]),
      topLabelsForListId: vi.fn().mockResolvedValue([
        { label: 'rangers', count: 30 }, // strong
      ]),
    };

    const { dm, context } = createContext(
      createEmailDecision({
        rawData: {
          from: 'jay+forward@blackrockrangers.org',
          listId: 'rangers.lists.example.org',
          subject: 'random',
          emailId: 'm',
        },
      }),
      port,
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    expect(port.topLabelsForListId).toHaveBeenCalled();
    expect(labelCandidate!.parameters['labels']).toEqual(['rangers']);
    expect(labelCandidate!.confidence).toBe(ConfidenceLevel.HIGH);
  });

  it('keeps sender hints when List-Id also has only sub-threshold evidence', async () => {
    // Both sources weak — return sender hints so the keyword fallback in
    // inferLabels() takes over (sender hints filtered out by min-count there).
    const port: LabelInferencePort = {
      topLabelsForSender: vi.fn().mockResolvedValue([{ label: 'maybe', count: 1 }]),
      topLabelsForListId: vi.fn().mockResolvedValue([{ label: 'other', count: 1 }]),
    };

    const { dm, context } = createContext(
      createEmailDecision({
        rawData: {
          from: 'a@b.com',
          listId: 'list.example.org',
          subject: 'invoice',
          emailId: 'm',
        },
      }),
      port,
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);
    // Both sub-threshold → keyword fallback in inferLabels picks 'finance'.
    expect(labelCandidate!.parameters['labels']).toEqual(['finance']);
  });

  it('runs without a port configured (early bring-up / unit tests)', async () => {
    const { dm, context } = createContext(
      createEmailDecision({
        rawData: { from: 'someone@example.com', subject: 'newsletter weekly', emailId: 'm' },
      }),
    );
    const outcome = await dm.evaluate(context);
    const labelCandidate = findLabelCandidate(outcome as never);

    expect(labelCandidate!.parameters['labels']).toEqual(['newsletters']);
  });
});
