import { describe, it, expect, beforeEach } from 'vitest';
import { ConfidenceLevel, RiskTier } from '@skytwin/shared-types';
import { ExplanationGenerator } from '../explanation-generator.js';
import {
  InMemoryExplanationRepo,
  RejectingExplanationRepo,
  makeAction,
  makeContext,
  makeDecision,
  makeOutcome,
  makePreference,
} from './fixtures.js';

describe('ExplanationGenerator.generate', () => {
  it('builds a record for an auto-executed outcome with no escalation rationale', async () => {
    const repo = new InMemoryExplanationRepo();
    const gen = new ExplanationGenerator(repo);

    const decision = makeDecision();
    const outcome = makeOutcome({ autoExecute: true });
    const context = makeContext({ decision });

    const record = await gen.generate(decision, outcome, context);

    expect(record.summary).not.toEqual('');
    expect(record.actionRationale).not.toEqual('');
    expect(record.correctionGuidance).not.toEqual('');
    expect(record.escalationRationale).toBeUndefined();
    expect(record.decisionId).toBe(decision.id);
    expect(record.userId).toBe(context.userId);
  });

  it('sets escalationRationale to outcome.reasoning when approval is required', async () => {
    const repo = new InMemoryExplanationRepo();
    const gen = new ExplanationGenerator(repo);

    const decision = makeDecision();
    const outcome = makeOutcome({
      requiresApproval: true,
      autoExecute: false,
      reasoning: 'Risk too high to auto-execute.',
    });
    const context = makeContext({ decision });

    const record = await gen.generate(decision, outcome, context);

    expect(record.escalationRationale).toBe('Risk too high to auto-execute.');
  });

  it('flags no-action outcomes in summary and actionRationale', async () => {
    const repo = new InMemoryExplanationRepo();
    const gen = new ExplanationGenerator(repo);

    const decision = makeDecision();
    const outcome = makeOutcome({
      selectedAction: null,
      allCandidates: [],
      riskAssessment: null,
      reasoning: 'All candidates blocked by policy.',
    });
    const context = makeContext({ decision });

    const record = await gen.generate(decision, outcome, context);

    expect(record.summary.toLowerCase()).toContain('escalated');
    expect(record.actionRationale.startsWith('No action was selected')).toBe(true);
    expect(record.actionRationale).toContain('All candidates blocked by policy.');
  });

  it('persists the record exactly once and returns the saved object', async () => {
    const repo = new InMemoryExplanationRepo();
    const gen = new ExplanationGenerator(repo);

    const record = await gen.generate(makeDecision(), makeOutcome({ autoExecute: true }), makeContext());

    expect(repo.saved).toHaveLength(1);
    expect(repo.saved[0]).toBe(record);
  });

  it('propagates repository.save rejections', async () => {
    const repo = new RejectingExplanationRepo(new Error('db down'));
    const gen = new ExplanationGenerator(repo);

    await expect(
      gen.generate(makeDecision(), makeOutcome({ autoExecute: true }), makeContext()),
    ).rejects.toThrow('db down');
  });

  it('falls back to NEGLIGIBLE risk and SPECULATIVE confidence when outcome has neither', async () => {
    const repo = new InMemoryExplanationRepo();
    const gen = new ExplanationGenerator(repo);

    const outcome = makeOutcome({ selectedAction: null, riskAssessment: null });
    const record = await gen.generate(makeDecision(), outcome, makeContext());

    expect(record.riskTier).toBe(RiskTier.NEGLIGIBLE);
    expect(record.overallConfidence).toBe(ConfidenceLevel.SPECULATIVE);
  });
});

describe('ExplanationGenerator buildSummary branches', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('escalation summary when no action selected', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ selectedAction: null, allCandidates: [], riskAssessment: null }),
      makeContext(),
    );
    expect(record.summary).toContain('could not determine a safe action');
  });

  it('auto-executed summary when autoExecute is true', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext(),
    );
    expect(record.summary).toContain('automatically handled');
  });

  it('approval-needed summary when requiresApproval is true', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ requiresApproval: true }),
      makeContext(),
    );
    expect(record.summary).toContain('Your approval is needed');
  });

  it('default summary when action is selected but neither auto nor approval', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: false, requiresApproval: false }),
      makeContext(),
    );
    expect(record.summary).toContain('processed a');
    expect(record.summary).toContain('Selected action');
  });
});

describe('ExplanationGenerator buildConfidenceReasoning branches', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('notes when no preferences are available', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext({ relevantPreferences: [] }),
    );
    expect(record.confidenceReasoning).toContain('No relevant preferences');
  });

  it('counts high-confidence and low-confidence preferences separately', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext({
        relevantPreferences: [
          makePreference({ id: 'p1', confidence: ConfidenceLevel.HIGH }),
          makePreference({ id: 'p2', confidence: ConfidenceLevel.CONFIRMED }),
          makePreference({ id: 'p3', confidence: ConfidenceLevel.SPECULATIVE }),
        ],
      }),
    );
    expect(record.confidenceReasoning).toContain('2 high-confidence');
    expect(record.confidenceReasoning).toContain('1 low-confidence');
  });

  it('mentions multi-candidate evaluation when more than one candidate exists', async () => {
    const action1 = makeAction({ id: 'a1' });
    const action2 = makeAction({ id: 'a2', description: 'Mark as read instead' });
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ selectedAction: action1, allCandidates: [action1, action2], autoExecute: true }),
      makeContext(),
    );
    expect(record.confidenceReasoning).toContain('2 candidate actions');
  });
});

describe('ExplanationGenerator buildActionRationale branches', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('starts with "No action was selected" when no action chosen', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ selectedAction: null, allCandidates: [], riskAssessment: null, reasoning: 'Why.' }),
      makeContext(),
    );
    expect(record.actionRationale.startsWith('No action was selected. ')).toBe(true);
    expect(record.actionRationale).toContain('Why.');
  });

  it('appends auto-execution suffix when autoExecute is true', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext(),
    );
    expect(record.actionRationale).toContain('auto-executed based on your trust tier');
  });

  it('omits auto-execution suffix when autoExecute is false', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: false, requiresApproval: true }),
      makeContext(),
    );
    expect(record.actionRationale).not.toContain('auto-executed based on');
  });
});

describe('ExplanationGenerator buildCorrectionGuidance branches', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('offers undo for auto-executed reversible actions', async () => {
    const action = makeAction({ reversible: true });
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ selectedAction: action, autoExecute: true }),
      makeContext(),
    );
    expect(record.correctionGuidance).toContain('Undo this action');
    expect(record.correctionGuidance).toContain('1.');
    expect(record.correctionGuidance).toContain('2.');
    expect(record.correctionGuidance).toContain('3.');
  });

  it('omits undo and renumbers when auto-executed action is not reversible', async () => {
    const action = makeAction({ reversible: false });
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ selectedAction: action, autoExecute: true }),
      makeContext(),
    );
    expect(record.correctionGuidance).not.toContain('Undo this action');
    expect(record.correctionGuidance).toContain('1. Provide feedback');
    expect(record.correctionGuidance).toContain('2. Adjust your autonomy');
  });

  it('offers approval-flow guidance when approval is required', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ requiresApproval: true, autoExecute: false }),
      makeContext(),
    );
    expect(record.correctionGuidance).toContain('Approve the recommended action');
    expect(record.correctionGuidance).toContain('Choose a different action');
    expect(record.correctionGuidance).toContain('Dismiss this decision');
  });
});

describe('ExplanationGenerator gatherEvidenceReferences', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('includes a raw-data reference when decision.rawData.source is present', async () => {
    const decision = makeDecision({ rawData: { source: 'gmail', subject: 'X' } });
    const record = await gen.generate(decision, makeOutcome({ autoExecute: true }), makeContext({ decision }));
    const rawRef = record.evidenceUsed.find((e) => e.evidenceId === `raw_${decision.id}`);
    expect(rawRef).toBeDefined();
    expect(rawRef?.source).toBe('gmail');
  });

  it('omits the raw-data reference when decision.rawData.source is missing', async () => {
    const decision = makeDecision({ rawData: { subject: 'X' } });
    const record = await gen.generate(decision, makeOutcome({ autoExecute: true }), makeContext({ decision }));
    const rawRef = record.evidenceUsed.find((e) => e.evidenceId === `raw_${decision.id}`);
    expect(rawRef).toBeUndefined();
  });

  it('caps preference evidence references at 3 per preference', async () => {
    const pref = makePreference({
      id: 'pref_many',
      evidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5'],
    });
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext({ relevantPreferences: [pref] }),
    );
    const fromPref = record.evidenceUsed.filter((e) => ['e1', 'e2', 'e3', 'e4', 'e5'].includes(e.evidenceId));
    expect(fromPref).toHaveLength(3);
    expect(fromPref.map((e) => e.evidenceId)).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('ExplanationGenerator gatherPreferenceReferences', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('returns an empty array when no preferences are present', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext({ relevantPreferences: [] }),
    );
    expect(record.preferencesInvoked).toEqual([]);
  });

  it('maps each preference 1:1 with howUsed describing its value', async () => {
    const prefs = [
      makePreference({ id: 'p1', key: 'a', value: 'hello' }),
      makePreference({ id: 'p2', key: 'b', value: 42 }),
    ];
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext({ relevantPreferences: prefs }),
    );
    expect(record.preferencesInvoked).toHaveLength(2);
    const [first, second] = record.preferencesInvoked;
    expect(first?.preferenceId).toBe('p1');
    expect(first?.howUsed).toContain('hello');
    expect(second?.howUsed).toContain('42');
  });
});

describe('ExplanationGenerator.formatForUser', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('contains all required sections in order for an approval outcome', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ requiresApproval: true, autoExecute: false, reasoning: 'Approval gate.' }),
      makeContext({ relevantPreferences: [makePreference()] }),
    );
    const out = gen.formatForUser(record);

    const idxHeader = out.indexOf('--- Decision Explanation ---');
    const idxWhat = out.indexOf('What happened:');
    const idxConfidence = out.indexOf('Confidence:');
    const idxRisk = out.indexOf('Risk level:');
    const idxApproval = out.indexOf('Why approval was needed:');
    const idxEvidence = out.indexOf('Evidence used:');
    const idxPreferences = out.indexOf('Your preferences applied:');
    const idxCorrection = out.indexOf('How to correct this:');

    expect(idxHeader).toBeGreaterThanOrEqual(0);
    expect(idxWhat).toBeGreaterThan(idxHeader);
    expect(idxConfidence).toBeGreaterThan(idxWhat);
    expect(idxRisk).toBeGreaterThan(idxConfidence);
    expect(idxApproval).toBeGreaterThan(idxRisk);
    expect(idxEvidence).toBeGreaterThan(idxApproval);
    expect(idxPreferences).toBeGreaterThan(idxEvidence);
    expect(idxCorrection).toBeGreaterThan(idxPreferences);
  });

  it('omits the "Why approval was needed" section when escalationRationale is undefined', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext(),
    );
    const out = gen.formatForUser(record);
    expect(out).not.toContain('Why approval was needed:');
  });
});

describe('ExplanationGenerator.formatForAudit', () => {
  let repo: InMemoryExplanationRepo;
  let gen: ExplanationGenerator;

  beforeEach(() => {
    repo = new InMemoryExplanationRepo();
    gen = new ExplanationGenerator(repo);
  });

  it('reports autoExecuted=false when escalationRationale is set', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ requiresApproval: true, autoExecute: false }),
      makeContext(),
    );
    const audit = gen.formatForAudit(record);
    expect(audit.autoExecuted).toBe(false);
  });

  it('reports autoExecuted=true when escalationRationale is undefined', async () => {
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext(),
    );
    const audit = gen.formatForAudit(record);
    expect(audit.autoExecuted).toBe(true);
  });

  it('exposes evidenceCount and preferencesCount matching record arrays', async () => {
    const prefs = [makePreference({ id: 'p1' }), makePreference({ id: 'p2' })];
    const record = await gen.generate(
      makeDecision(),
      makeOutcome({ autoExecute: true }),
      makeContext({ relevantPreferences: prefs }),
    );
    const audit = gen.formatForAudit(record);
    expect(audit.evidenceCount).toBe(record.evidenceUsed.length);
    expect(audit.preferencesCount).toBe(record.preferencesInvoked.length);
    expect(audit.preferencesCount).toBe(2);
  });

  it('preserves the full explanation as fullExplanation', async () => {
    const record = await gen.generate(makeDecision(), makeOutcome({ autoExecute: true }), makeContext());
    const audit = gen.formatForAudit(record);
    expect(audit.fullExplanation).toBe(record);
  });
});
