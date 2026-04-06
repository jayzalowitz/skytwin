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

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO decisions');
      expect(sql).not.toContain('$8'); // No 8th param -- no explicit id path uses 7
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual([
        'u-001',
        'email_received',
        JSON.stringify({ from: 'boss@company.com' }),
        JSON.stringify({ importance: 'high' }),
        'email',
        'normal',    // default urgency
        '{}',        // default metadata
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

      expect(result).toEqual(row);

      const [sql, params] = mockQuery.mock.calls[0]!;
      expect(sql).toContain('INSERT INTO decisions');
      // The explicit-id path uses 8 params
      expect(params).toEqual([
        'custom-uuid',
        'u-001',
        'calendar_conflict',
        '{}',
        '{}',
        'calendar',
        'high',
        JSON.stringify({ source: 'webhook' }),
      ]);
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
});
