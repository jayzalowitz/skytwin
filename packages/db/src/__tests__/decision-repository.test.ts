import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { decisionRepository } = await import('../repositories/decision-repository.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeDecisionRow(overrides: Partial<{
  id: string;
  user_id: string;
  situation_type: string;
  raw_event: Record<string, unknown>;
  interpreted_situation: Record<string, unknown>;
  domain: string;
  urgency: string;
  metadata: Record<string, unknown>;
  signal_id: string | null;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'd-001',
    user_id: overrides.user_id ?? 'u-001',
    situation_type: overrides.situation_type ?? 'email_received',
    raw_event: overrides.raw_event ?? { from: 'boss@company.com' },
    interpreted_situation: overrides.interpreted_situation ?? { importance: 'high' },
    domain: overrides.domain ?? 'email',
    urgency: overrides.urgency ?? 'normal',
    metadata: overrides.metadata ?? {},
    signal_id: overrides.signal_id ?? null,
    created_at: overrides.created_at ?? new Date('2026-03-01'),
  };
}

function fakeCandidateActionRow(overrides: Partial<{
  id: string;
  decision_id: string;
  action_type: string;
  description: string;
  parameters: Record<string, unknown>;
  predicted_user_preference: string;
  risk_assessment: Record<string, unknown>;
  reversible: boolean;
  estimated_cost: number | null;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'ca-001',
    decision_id: overrides.decision_id ?? 'd-001',
    action_type: overrides.action_type ?? 'reply',
    description: overrides.description ?? 'Reply to email',
    parameters: overrides.parameters ?? {},
    predicted_user_preference: overrides.predicted_user_preference ?? 'likely_approve',
    risk_assessment: overrides.risk_assessment ?? { level: 'low' },
    reversible: overrides.reversible ?? true,
    estimated_cost: overrides.estimated_cost ?? null,
    created_at: overrides.created_at ?? new Date('2026-03-01'),
  };
}

function fakeOutcomeRow(overrides: Partial<{
  id: string;
  decision_id: string;
  selected_action_id: string | null;
  auto_executed: boolean;
  requires_approval: boolean;
  escalation_reason: string | null;
  explanation: string;
  confidence: number;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'do-001',
    decision_id: overrides.decision_id ?? 'd-001',
    selected_action_id: overrides.selected_action_id ?? 'ca-001',
    auto_executed: overrides.auto_executed ?? false,
    requires_approval: overrides.requires_approval ?? true,
    escalation_reason: overrides.escalation_reason ?? null,
    explanation: overrides.explanation ?? 'Action requires user review',
    confidence: overrides.confidence ?? 0.85,
    created_at: overrides.created_at ?? new Date('2026-03-01'),
  };
}

function fakeExplanationRow() {
  return {
    id: 'er-001',
    decision_id: 'd-001',
    what_happened: 'Email received from boss',
    evidence_used: [{ type: 'sender_analysis' }],
    preferences_invoked: ['respond_to_boss'],
    confidence_reasoning: 'High confidence based on past patterns',
    action_rationale: 'User always replies to boss within 1h',
    escalation_rationale: null,
    correction_guidance: 'Adjust response priority in settings',
    created_at: new Date('2026-03-01'),
  };
}

function fakeFeedbackRow(overrides: Partial<{
  id: string;
  decision_id: string;
}> = {}) {
  return {
    id: overrides.id ?? 'fb-001',
    user_id: 'u-001',
    decision_id: overrides.decision_id ?? 'd-001',
    type: 'approval',
    data: { rating: 5 },
    created_at: new Date('2026-03-01'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decisionRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('inserts decision without explicit id (DB generates UUID)', async () => {
      const row = fakeDecisionRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await decisionRepository.create({
        userId: 'u-001',
        situationType: 'email_received',
        rawEvent: { from: 'boss@company.com' },
        interpretedSituation: { importance: 'high' },
        domain: 'email',
      });

      expect(result).toEqual({ row, created: true });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO decisions');
      // No-id path takes 8 params (the 8th is signal_id, null when absent).
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'u-001',
        'email_received',
        JSON.stringify({ from: 'boss@company.com' }),
        JSON.stringify({ importance: 'high' }),
        'email',
        'normal',    // default urgency
        '{}',        // default metadata
        null,        // signal_id — only set when rawEvent.signalId is present
      ]);
    });

    it('inserts decision with explicit id', async () => {
      const row = fakeDecisionRow({ id: 'custom-uuid' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await decisionRepository.create({
        id: 'custom-uuid',
        userId: 'u-001',
        situationType: 'calendar_conflict',
        rawEvent: {},
        interpretedSituation: {},
        domain: 'calendar',
        urgency: 'high',
        metadata: { source: 'webhook' },
      });

      expect(result).toEqual({ row, created: true });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO decisions');
      // The explicit-id path takes 9 params (signal_id at the end).
      expect(params).toEqual([
        'custom-uuid',
        'u-001',
        'calendar_conflict',
        '{}',
        '{}',
        'calendar',
        'high',
        JSON.stringify({ source: 'webhook' }),
        null,
      ]);
    });

    it('extracts signal_id from rawEvent when present', async () => {
      // No existing decision → pre-check returns 0 rows, then insert proceeds.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      mockQuery.mockResolvedValueOnce({
        rows: [fakeDecisionRow({ signal_id: 'sig_gmail_abc' })],
        rowCount: 1,
      });

      await decisionRepository.create({
        userId: 'u-001',
        situationType: 'email_received',
        rawEvent: { signalId: 'sig_gmail_abc', from: 'a@b.com' },
        interpretedSituation: {},
        domain: 'email',
      });

      // First call: SELECT ... WHERE user_id = $1 AND signal_id = $2
      const [preCheckSql, preCheckParams] = mockQuery.mock.calls[0]!;
      expect(preCheckSql).toContain('SELECT * FROM decisions');
      expect(preCheckParams).toEqual(['u-001', 'sig_gmail_abc']);

      // Second call: INSERT with signal_id as final param.
      const insertParams = mockQuery.mock.calls[1]![1] as unknown[];
      expect(insertParams[insertParams.length - 1]).toBe('sig_gmail_abc');
    });

    it('returns the existing decision when (user_id, signal_id) already exists', async () => {
      const existing = fakeDecisionRow({
        id: 'existing-uuid',
        signal_id: 'sig_gmail_dup',
      });
      mockQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

      const result = await decisionRepository.create({
        userId: 'u-001',
        situationType: 'email_received',
        rawEvent: { signalId: 'sig_gmail_dup' },
        interpretedSituation: {},
        domain: 'email',
      });

      expect(result).toEqual({ row: existing, created: false });
      // Pre-check only — no INSERT call followed it.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('recovers from a concurrent-insert race (23505) by returning the row the winner wrote', async () => {
      // The SELECT pre-check and the INSERT aren't in one transaction, so
      // two concurrent ingestions of the same `(user_id, signal_id)` can
      // both pass the pre-check ("no existing row") and both attempt
      // INSERT. The partial unique index from migration 023 fires 23505
      // on the loser. Without recovery the loser surfaces a 500 to its
      // caller; with recovery the loser re-fetches the winner's row and
      // returns `created: false` so the caller treats it as a
      // re-ingestion — same outcome as the SELECT-pre-check path.
      const winner = fakeDecisionRow({ id: 'winner-id', signal_id: 'sig_race' });
      mockQuery
        // 1. Pre-check SELECT — empty (loser misses on the race window)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // 2. INSERT — fails with 23505 (partial unique index won)
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
        // 3. Recovery SELECT — winner's row is now visible
        .mockResolvedValueOnce({ rows: [winner], rowCount: 1 });

      const result = await decisionRepository.create({
        userId: 'u-001',
        situationType: 'email_received',
        rawEvent: { signalId: 'sig_race' },
        interpretedSituation: {},
        domain: 'email',
      });

      expect(result).toEqual({ row: winner, created: false });
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('does not swallow 23505 when signalId is absent (no unique constraint to lose to)', async () => {
      // Without a signalId the partial unique index from migration 023
      // doesn't apply, so a 23505 from the INSERT path is a real
      // failure (some other constraint was violated) and must surface
      // rather than be silently absorbed by the race-recovery path.
      mockQuery.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      await expect(
        decisionRepository.create({
          userId: 'u-001',
          situationType: 'email_received',
          rawEvent: {},
          interpretedSituation: {},
          domain: 'email',
        }),
      ).rejects.toThrow(/duplicate key/);
    });

    it('does not swallow non-23505 errors on the INSERT path', async () => {
      // A driver/CRDB error other than 23505 (network, syntax, deadlock,
      // etc.) must surface — the recovery path is only safe for the
      // specific "another request beat us" case.
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // pre-check
        .mockRejectedValueOnce(
          Object.assign(new Error('connection reset'), { code: '08006' }),
        );

      await expect(
        decisionRepository.create({
          userId: 'u-001',
          situationType: 'email_received',
          rawEvent: { signalId: 'sig_x' },
          interpretedSituation: {},
          domain: 'email',
        }),
      ).rejects.toThrow(/connection reset/);
    });

    it('defaults urgency to "normal" when not specified', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeDecisionRow()], rowCount: 1 });

      await decisionRepository.create({
        userId: 'u-001',
        situationType: 'test',
        rawEvent: {},
        interpretedSituation: {},
        domain: 'test',
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![5]).toBe('normal');
    });
  });

  // -----------------------------------------------------------------------
  // findById
  // -----------------------------------------------------------------------

  describe('findById', () => {
    it('returns decision row when found', async () => {
      const row = fakeDecisionRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await decisionRepository.findById('d-001');

      expect(result).toEqual(row);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM decisions WHERE id = $1',
        ['d-001'],
      );
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await decisionRepository.findById('ghost');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // findByUser
  // -----------------------------------------------------------------------

  describe('findByUser', () => {
    it('queries with userId and default limit/offset', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await decisionRepository.findByUser('u-001');

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(sql).toContain('LIMIT $2');
      expect(sql).toContain('OFFSET $3');
      expect(params).toEqual(['u-001', 50, 0]);
    });

    it('applies domain filter when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await decisionRepository.findByUser('u-001', { domain: 'email' });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('domain = $2');
      expect(sql).toContain('LIMIT $3');
      expect(sql).toContain('OFFSET $4');
      expect(params).toEqual(['u-001', 'email', 50, 0]);
    });

    it('applies date range filters when provided', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-03-31');
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await decisionRepository.findByUser('u-001', { from, to });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('created_at >= $2');
      expect(sql).toContain('created_at <= $3');
      expect(params).toEqual(['u-001', from, to, 50, 0]);
    });

    it('applies all filters together with correct param indexing', async () => {
      const from = new Date('2026-01-01');
      const to = new Date('2026-03-31');
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await decisionRepository.findByUser('u-001', {
        domain: 'calendar',
        from,
        to,
        limit: 10,
        offset: 20,
      });

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('user_id = $1');
      expect(sql).toContain('domain = $2');
      expect(sql).toContain('created_at >= $3');
      expect(sql).toContain('created_at <= $4');
      expect(sql).toContain('LIMIT $5');
      expect(sql).toContain('OFFSET $6');
      expect(params).toEqual(['u-001', 'calendar', from, to, 10, 20]);
    });

    it('uses custom limit and offset', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await decisionRepository.findByUser('u-001', { limit: 5, offset: 10 });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual(['u-001', 5, 10]);
    });
  });

  // -----------------------------------------------------------------------
  // addCandidateAction
  // -----------------------------------------------------------------------

  describe('addCandidateAction', () => {
    it('inserts candidate action without explicit id', async () => {
      const row = fakeCandidateActionRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await decisionRepository.addCandidateAction({
        decisionId: 'd-001',
        actionType: 'reply',
        description: 'Reply to email',
        predictedUserPreference: 'likely_approve',
        riskAssessment: { level: 'low' },
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO candidate_actions');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'd-001',
        'reply',
        'Reply to email',
        '{}',              // default parameters
        'likely_approve',
        JSON.stringify({ level: 'low' }),
        true,              // default reversible
        null,              // default estimated cost
      ]);
    });

    it('inserts candidate action with explicit id', async () => {
      const row = fakeCandidateActionRow({ id: 'ca-custom' });
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      await decisionRepository.addCandidateAction({
        id: 'ca-custom',
        decisionId: 'd-001',
        actionType: 'forward',
        description: 'Forward to team',
        predictedUserPreference: 'uncertain',
        riskAssessment: { level: 'medium' },
        reversible: false,
        estimatedCost: 0,
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params![0]).toBe('ca-custom');
      expect(params![7]).toBe(false); // reversible
      expect(params![8]).toBe(0);     // estimatedCost
    });

    it('defaults reversible to true and estimatedCost to null', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeCandidateActionRow()], rowCount: 1 });

      await decisionRepository.addCandidateAction({
        decisionId: 'd-001',
        actionType: 'archive',
        description: 'Archive email',
        predictedUserPreference: 'likely_approve',
        riskAssessment: {},
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      // Last two params should be defaults
      expect(params![params!.length - 2]).toBe(true);  // reversible
      expect(params![params!.length - 1]).toBeNull();   // estimatedCost
    });
  });

  // -----------------------------------------------------------------------
  // getCandidateActions
  // -----------------------------------------------------------------------

  describe('getCandidateActions', () => {
    it('returns actions ordered by created_at', async () => {
      const rows = [
        fakeCandidateActionRow({ id: 'ca-001' }),
        fakeCandidateActionRow({ id: 'ca-002' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await decisionRepository.getCandidateActions('d-001');

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('FROM candidate_actions');
      expect(sql).toContain('WHERE decision_id = $1');
      expect(sql).toContain('ORDER BY created_at');
      expect(params).toEqual(['d-001']);
    });
  });

  // -----------------------------------------------------------------------
  // recordOutcome
  // -----------------------------------------------------------------------

  describe('recordOutcome', () => {
    it('inserts outcome with all fields', async () => {
      const row = fakeOutcomeRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await decisionRepository.recordOutcome({
        decisionId: 'd-001',
        selectedActionId: 'ca-001',
        autoExecuted: false,
        requiresApproval: true,
        escalationReason: 'High cost',
        explanation: 'Action requires user review',
        confidence: 0.85,
      });

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO decision_outcomes');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'd-001',
        'ca-001',
        false,
        true,
        'High cost',
        'Action requires user review',
        0.85,
      ]);
    });

    it('defaults optional fields correctly', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeOutcomeRow()], rowCount: 1 });

      await decisionRepository.recordOutcome({
        decisionId: 'd-001',
        explanation: 'Auto decision',
        confidence: 0.95,
      });

      const [_sql, params] = mockQuery.mock.calls[0]!;
      expect(params).toEqual([
        'd-001',
        null,           // selectedActionId
        false,          // autoExecuted
        false,          // requiresApproval
        null,           // escalationReason
        'Auto decision',
        0.95,
      ]);
    });

    it('upserts on decision_id (re-ingest replaces the prior outcome)', async () => {
      mockQuery.mockResolvedValue({ rows: [fakeOutcomeRow()], rowCount: 1 });

      await decisionRepository.recordOutcome({
        decisionId: 'd-001',
        explanation: 'Re-evaluated outcome',
        confidence: 0.9,
      });

      const [sql] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('ON CONFLICT (decision_id) DO UPDATE');
      // Every column except decision_id and the immutable id/created_at
      // should appear in the SET clause so re-ingest fully overwrites.
      expect(sql).toContain('selected_action_id = EXCLUDED.selected_action_id');
      expect(sql).toContain('explanation = EXCLUDED.explanation');
      expect(sql).toContain('confidence = EXCLUDED.confidence');
    });
  });

  // -----------------------------------------------------------------------
  // getOutcome
  // -----------------------------------------------------------------------

  describe('getOutcome', () => {
    it('returns outcome when found', async () => {
      const row = fakeOutcomeRow();
      mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });

      const result = await decisionRepository.getOutcome('d-001');
      expect(result).toEqual(row);
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await decisionRepository.getOutcome('ghost');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getDecisionWithContext
  // -----------------------------------------------------------------------

  describe('getDecisionWithContext', () => {
    it('returns null when decision does not exist', async () => {
      // findById call returns no rows
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const result = await decisionRepository.getDecisionWithContext('ghost');
      expect(result).toBeNull();
    });

    it('fetches decision with all related records', async () => {
      const decision = fakeDecisionRow();
      const candidateActions = [fakeCandidateActionRow()];
      const outcome = fakeOutcomeRow();
      const explanation = fakeExplanationRow();
      const feedback = [fakeFeedbackRow()];

      // First call: findById
      mockQuery.mockResolvedValueOnce({ rows: [decision], rowCount: 1 });
      // Then 4 parallel calls via Promise.all:
      // candidate_actions, decision_outcomes, explanation_records, feedback_events
      mockQuery.mockResolvedValueOnce({ rows: candidateActions, rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [outcome], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [explanation], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: feedback, rowCount: 1 });

      const result = await decisionRepository.getDecisionWithContext('d-001');

      expect(result).not.toBeNull();
      expect(result!.decision).toEqual(decision);
      expect(result!.candidateActions).toEqual(candidateActions);
      expect(result!.outcome).toEqual(outcome);
      expect(result!.explanation).toEqual(explanation);
      expect(result!.feedback).toEqual(feedback);

      // Verify the queries made
      expect(mockQuery).toHaveBeenCalledTimes(5);

      // First call is findById
      expect(mockQuery.mock.calls[0]![0]).toContain('SELECT * FROM decisions WHERE id = $1');
    });

    it('returns null outcome and explanation when not present', async () => {
      const decision = fakeDecisionRow();

      mockQuery.mockResolvedValueOnce({ rows: [decision], rowCount: 1 });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no candidate actions
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no outcome
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no explanation
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no feedback

      const result = await decisionRepository.getDecisionWithContext('d-001');

      expect(result).not.toBeNull();
      expect(result!.candidateActions).toEqual([]);
      expect(result!.outcome).toBeNull();
      expect(result!.explanation).toBeNull();
      expect(result!.feedback).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // findByIds (batch)
  // -----------------------------------------------------------------------

  describe('findByIds', () => {
    it('returns empty array for empty ids list', async () => {
      const result = await decisionRepository.findByIds([]);
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('batch-fetches decisions using ANY($1)', async () => {
      const rows = [
        fakeDecisionRow({ id: 'd-001' }),
        fakeDecisionRow({ id: 'd-002' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await decisionRepository.findByIds(['d-001', 'd-002']);

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE id = ANY($1)');
      expect(params).toEqual([['d-001', 'd-002']]);
    });
  });

  // -----------------------------------------------------------------------
  // getCandidateActionsForDecisions (batch)
  // -----------------------------------------------------------------------

  describe('getCandidateActionsForDecisions', () => {
    it('returns empty array for empty ids list', async () => {
      const result = await decisionRepository.getCandidateActionsForDecisions([]);
      expect(result).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('batch-fetches candidate actions using ANY($1)', async () => {
      const rows = [
        fakeCandidateActionRow({ id: 'ca-001', decision_id: 'd-001' }),
        fakeCandidateActionRow({ id: 'ca-002', decision_id: 'd-002' }),
      ];
      mockQuery.mockResolvedValue({ rows, rowCount: 2 });

      const result = await decisionRepository.getCandidateActionsForDecisions(['d-001', 'd-002']);

      expect(result).toEqual(rows);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('WHERE decision_id = ANY($1)');
      expect(sql).toContain('ORDER BY created_at');
      expect(params).toEqual([['d-001', 'd-002']]);
    });
  });
});
