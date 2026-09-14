import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildExecutableActionPlan } from '@skytwin/shared-types';

const SYNTHETIC_AWS_ACCESS_KEY = ['AK', 'IAIOSFODNN7EXAMPLE'].join('');
const SYNTHETIC_GITHUB_TOKEN = ['gh', 'p_abcdefghijklmnopqrstuvwxyz1234567890'].join('');

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { memoryActionOpportunityRepository } = await import(
  '../repositories/memory-action-opportunity-repository.js'
);

const ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  fingerprint: 'memory-action-abc123',
  suggestion_id: 'memory-link-a-b',
  title: 'Memory link',
  reason: 'Connects two project notes',
  suggested_action: 'Try drafting the reply.',
  action_type: 'draft_email',
  action_label: 'draft a reply',
  action_plan: buildExecutableActionPlan('draft_email', 'draft a reply'),
  source_refs: ['sig-a'],
  memory_refs: ['page-a', 'page-b'],
  source_types: ['gmail'],
  novelty: 'connection',
  confidence: 0.77,
  provenance: 'user_originated',
  status: 'suggested',
  attempt_count: 0,
  last_suggested_at: new Date('2026-06-25T12:00:00Z'),
  last_attempted_at: null,
  last_report: null,
  decision_id: null,
  approval_request_id: null,
  execution_plan_id: null,
  adapter_name: null,
  policy_reason: null,
  route_reason: null,
  next_step: null,
  created_at: new Date('2026-06-25T12:00:00Z'),
  updated_at: new Date('2026-06-25T12:00:00Z'),
};

describe('memoryActionOpportunityRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('upserts suggestions by user fingerprint and serializes action_plan once', async () => {
    mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    const result = await memoryActionOpportunityRepository.upsertFromSuggestion({
      userId: ROW.user_id,
      fingerprint: ROW.fingerprint,
      provenance: 'user_originated',
      suggestion: {
        id: ROW.suggestion_id,
        title: ROW.title,
        reason: ROW.reason,
        suggestedAction: ROW.suggested_action,
        sourceRefs: ROW.source_refs,
        memoryRefs: ROW.memory_refs,
        sourceTypes: ROW.source_types,
        novelty: 'connection',
        confidence: ROW.confidence,
        actionPlan: ROW.action_plan,
      },
    });

    expect(result.id).toBe(ROW.id);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('INSERT INTO memory_action_opportunities');
    expect(sql).toContain('ON CONFLICT (user_id, fingerprint)');
    expect(params[8]).toBe(JSON.stringify(ROW.action_plan));
    expect(params[14]).toBe('user_originated');
  });

  it('bounds direct suggestion columns and rebuilds a typed canonical action plan', async () => {
    const huge = 'x'.repeat(100_000);
    mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    await memoryActionOpportunityRepository.upsertFromSuggestion({
      userId: ROW.user_id,
      fingerprint: ROW.fingerprint,
      provenance: 'untrusted_external',
      suggestion: {
        id: ROW.suggestion_id,
        title: `Bearer opaque-secret ${huge}`,
        reason: 'https://example.test/path?access_token=opaque-secret',
        suggestedAction: huge,
        sourceRefs: ['valid-ref', 'ya29.source-secret', 'sk-proj-abc123xyz', huge, 'bad ref'],
        memoryRefs: ['page-a', 'ya29.memory-secret', SYNTHETIC_GITHUB_TOKEN],
        sourceTypes: ['gmail', 'eyJheader.payload.signature', SYNTHETIC_AWS_ACCESS_KEY],
        novelty: 'connection',
        confidence: 20,
        actionPlan: {
          ...ROW.action_plan,
          label: huge,
          adapterRationale: 'Bearer should-not-survive',
          runtimeVersion: {
            ...ROW.action_plan.runtimeVersion,
            stableUrl: 'https://attacker.test/?refresh_token=should-not-survive',
          },
        },
      },
    });

    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(String(params[3]).startsWith('Bearer [redacted:credential] ')).toBe(true);
    expect(String(params[3])).toHaveLength(1_000);
    expect(params[4]).toBe('[redacted:url]');
    expect(String(params[5])).toHaveLength(1_000);
    expect(params[9]).toEqual([
      'valid-ref', '[redacted:credential]', '[redacted:credential]',
    ]);
    expect(params[10]).toEqual([
      'page-a', '[redacted:credential]', '[redacted:credential]',
    ]);
    expect(params[11]).toEqual([
      'gmail', '[redacted:credential]', '[redacted:credential]',
    ]);
    expect(params[13]).toBe(1);
    expect(JSON.parse(String(params[8]))).toEqual(buildExecutableActionPlan('draft_email', 'x'.repeat(1_000)));
    expect(JSON.stringify(params)).not.toContain('opaque-secret');
    expect(JSON.stringify(params)).not.toContain('should-not-survive');
    expect(JSON.stringify(params)).not.toContain('source-secret');
    expect(JSON.stringify(params)).not.toContain('refresh-secret');
    expect(JSON.stringify(params)).not.toContain('eyJheader');
  });

  it('refuses a credential-shaped opportunity identity before persistence', async () => {
    await expect(memoryActionOpportunityRepository.upsertFromSuggestion({
      userId: ROW.user_id,
      fingerprint: 'sk-proj-abc123xyz',
      provenance: 'untrusted_external',
      suggestion: {
        id: ROW.suggestion_id,
        title: ROW.title,
        reason: ROW.reason,
        suggestedAction: ROW.suggested_action,
        sourceRefs: [], memoryRefs: [], sourceTypes: [],
        novelty: 'connection', confidence: 0.5,
        actionPlan: ROW.action_plan,
      },
    })).rejects.toThrow(/identity is malformed/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('redacts credential-shaped references read from legacy rows', async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        ...ROW,
        action_type: SYNTHETIC_AWS_ACCESS_KEY,
        decision_id: 'sk-proj-abc123xyz',
        approval_request_id: SYNTHETIC_GITHUB_TOKEN,
        execution_plan_id: 'ya29.plan-secret',
        source_refs: ['sk-proj-legacysecret'],
        memory_refs: ['safe-page', SYNTHETIC_GITHUB_TOKEN],
        source_types: [SYNTHETIC_AWS_ACCESS_KEY],
      }],
      rowCount: 1,
    });

    const rows = await memoryActionOpportunityRepository.claimDueForUser(ROW.user_id);
    expect(rows[0]?.sourceRefs).toEqual(['[redacted:credential]']);
    expect(rows[0]?.memoryRefs).toEqual(['safe-page', '[redacted:credential]']);
    expect(rows[0]?.sourceTypes).toEqual(['[redacted:credential]']);
    expect(rows[0]?.actionType).toBe('unknown');
    expect(rows[0]?.decisionId).toBeNull();
    expect(rows[0]?.approvalRequestId).toBeNull();
    expect(rows[0]?.executionPlanId).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('legacy-secret');
    expect(JSON.stringify(rows)).not.toContain('ghp_');
    expect(JSON.stringify(rows)).not.toContain('AKIA');
  });

  it('claims only retryable due rows with a bounded limit', async () => {
    mockQuery.mockResolvedValue({ rows: [ROW], rowCount: 1 });
    const rows = await memoryActionOpportunityRepository.claimDueForUser(ROW.user_id, {
      limit: 100,
      retryAfterHours: 12,
    });
    expect(rows).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('UPDATE memory_action_opportunities');
    expect(sql).toContain('attempt_count = attempt_count + 1');
    expect(sql).toContain('status = ANY($2)');
    expect(sql).toContain("INTERVAL '1 hour'");
    expect(sql).toContain('RETURNING *');
    expect(params[2]).toBe(12);
    expect(params[3]).toBe(25);
  });

  it('lists users with retryable due opportunities so old skill gaps resume', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ user_id: ROW.user_id }],
      rowCount: 1,
    });

    const users = await memoryActionOpportunityRepository.listUsersWithDue({
      limit: 9999,
      retryAfterHours: 6,
    });

    expect(users).toEqual([ROW.user_id]);
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('SELECT DISTINCT user_id');
    expect(sql).toContain('status = ANY($1)');
    expect(params[1]).toBe(6);
    expect(params[2]).toBe(5000);
  });

  it('marks a status transition with report and linkage ids', async () => {
    const report = {
      opportunityId: ROW.id,
      status: 'queued_approval' as const,
      title: ROW.title,
      actionType: ROW.action_type,
      actionLabel: ROW.action_label,
      summary: 'queued',
      nextStep: 'review',
      attemptedAt: '2026-06-25T12:05:00.000Z',
      decisionId: '33333333-3333-3333-3333-333333333333',
    };
    mockQuery.mockResolvedValue({
      rows: [{
        ...ROW,
        status: 'queued_approval',
        last_report: report,
        decision_id: report.decisionId,
      }],
      rowCount: 1,
    });

    const row = await memoryActionOpportunityRepository.markStatus({
      id: ROW.id,
      status: 'queued_approval',
      report,
      decisionId: report.decisionId,
      nextStep: report.nextStep,
    });
    expect(row?.status).toBe('queued_approval');
    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('last_report = $3');
    expect(JSON.parse(String(params[2]))).toEqual(report);
    expect(params[3]).toBe(report.decisionId);
  });

  it('returns stored recent reports newest first', async () => {
    const report = {
      opportunityId: ROW.id,
      status: 'learning_needed' as const,
      title: ROW.title,
      actionType: ROW.action_type,
      actionLabel: ROW.action_label,
      summary: 'needs skill',
      nextStep: 'connect',
      attemptedAt: '2026-06-25T12:05:00.000Z',
    };
    mockQuery.mockResolvedValue({ rows: [{ ...ROW, last_report: report }], rowCount: 1 });
    const reports = await memoryActionOpportunityRepository.listRecentReportsForUser(
      ROW.user_id,
      new Date('2026-06-25T00:00:00Z'),
    );
    expect(reports).toEqual([report]);
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain('last_report IS NOT NULL');
    expect(sql).toContain('ORDER BY last_attempted_at DESC NULLS LAST');
  });

  it('bounds and normalizes every direct memory scalar column before SQL', async () => {
    const huge = 'x'.repeat(100_000);
    const report = {
      opportunityId: ROW.id,
      status: 'execution_ambiguous' as const,
      title: ROW.title,
      actionType: ROW.action_type,
      actionLabel: ROW.action_label,
      summary: 'ambiguous',
      nextStep: huge,
      attemptedAt: '2026-06-25T12:05:00.000Z',
    };
    await memoryActionOpportunityRepository.markStatus({
      id: ROW.id,
      status: 'execution_ambiguous',
      report,
      adapterName: 'invalid adapter with spaces',
      policyReason: 'Bearer opaque-secret',
      routeReason: 'See https://example.test/failure?access_token=opaque-secret',
      nextStep: huge,
    });
    const params = mockQuery.mock.calls[0]![1] as unknown[];
    expect(params[6]).toBeNull();
    expect(params[7]).toBe('Bearer [redacted:credential]');
    expect(params[8]).toBe('See [redacted:url]');
    expect(params[9]).toBe('x'.repeat(1_000));
    expect(JSON.stringify(params)).not.toContain('opaque-secret');
    expect(JSON.stringify(params).length).toBeLessThan(3_000);
  });

  it('treats noted_awareness as terminal — excluded from the retryable claim set', async () => {
    // Guards the re-FYI loop: a disposed awareness item must never be re-claimed.
    await memoryActionOpportunityRepository.claimDueForUser(ROW.user_id, { limit: 5 });
    const [, params] = mockQuery.mock.calls[0]!;
    const retryable = params[1] as string[];
    expect(retryable).toContain('suggested');
    expect(retryable).not.toContain('noted_awareness');
    expect(retryable).not.toContain('auto_executed');
    expect(retryable).not.toContain('execution_failed');
  });

  it('round-trips the terminal noted_awareness status (parseStatus does not coerce it to suggested)', async () => {
    const report = {
      opportunityId: ROW.id,
      status: 'noted_awareness' as const,
      title: ROW.title,
      actionType: ROW.action_type,
      actionLabel: ROW.action_label,
      summary: 'noted as awareness',
      nextStep: 'nothing required',
      attemptedAt: '2026-06-25T12:05:00.000Z',
    };
    mockQuery.mockResolvedValue({ rows: [{ ...ROW, status: 'noted_awareness', last_report: report }], rowCount: 1 });
    const row = await memoryActionOpportunityRepository.markStatus({
      id: ROW.id,
      status: 'noted_awareness',
      report,
    });
    expect(row?.status).toBe('noted_awareness');
  });
});
