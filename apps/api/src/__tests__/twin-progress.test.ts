import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted runs before vi.mock factories execute.
// findByUser orders by created_at DESC (most-recent-first), so test
// fixtures here are written in DESC order to match the real repository.
// ---------------------------------------------------------------------------

const {
  mockUserRepository,
  mockFeedbackRepository,
} = vi.hoisted(() => ({
  mockUserRepository: { findById: vi.fn() },
  mockFeedbackRepository: { findByUser: vi.fn() },
}));

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  feedbackRepository: mockFeedbackRepository,
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
}));

vi.mock('@skytwin/twin-model', () => ({
  TwinService: vi.fn().mockImplementation(() => ({
    exportTwin: vi.fn(),
    formatAsMarkdown: vi.fn(),
  })),
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

import { createTwinRouter } from '../routes/twin.js';

const USER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/twin', createTwinRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

async function getJson(app: Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

describe('GET /api/twin/:userId/progress — consecutiveApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserRepository.findById.mockResolvedValue({ id: USER_ID, trust_tier: 'observer' });
  });

  it('returns 0 when the most recent event is a rejection — even with a long earlier streak', async () => {
    // DESC order: [rejection, ...8 approvals from before]. The streak ends
    // at the first thing the user did most recently (a reject), so the
    // engine would not promote — the progress field must reflect that.
    mockFeedbackRepository.findByUser.mockResolvedValue([
      { type: 'reject' },
      { type: 'approve' }, { type: 'approve' }, { type: 'approve' }, { type: 'approve' },
      { type: 'approve' }, { type: 'approve' }, { type: 'approve' }, { type: 'approve' },
    ]);

    const res = await getJson(buildApp(), `/api/twin/${USER_ID}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.consecutiveApprovals).toBe(0);
    expect(res.body.approvalCount).toBe(8);
  });

  it('counts the unbroken approval streak from the most-recent event', async () => {
    // DESC order: 5 fresh approvals, then a reject, then 3 older approvals.
    // Streak from the freshest end is 5.
    mockFeedbackRepository.findByUser.mockResolvedValue([
      { type: 'approve' }, { type: 'approve' }, { type: 'approve' },
      { type: 'approve' }, { type: 'approve' },
      { type: 'reject' },
      { type: 'approve' }, { type: 'approve' }, { type: 'approve' },
    ]);

    const res = await getJson(buildApp(), `/api/twin/${USER_ID}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.consecutiveApprovals).toBe(5);
    expect(res.body.approvalCount).toBe(8);
    expect(res.body.approvalRatio).toBeCloseTo(8 / 9, 3);
  });

  it('returns 0 when the user has no feedback yet', async () => {
    mockFeedbackRepository.findByUser.mockResolvedValue([]);
    const res = await getJson(buildApp(), `/api/twin/${USER_ID}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.consecutiveApprovals).toBe(0);
    expect(res.body.approvalCount).toBe(0);
    expect(res.body.approvalRatio).toBe(0);
  });

  it('counts the full history when every event is an approval', async () => {
    mockFeedbackRepository.findByUser.mockResolvedValue([
      { type: 'approve' }, { type: 'approve' }, { type: 'approve' },
    ]);
    const res = await getJson(buildApp(), `/api/twin/${USER_ID}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.consecutiveApprovals).toBe(3);
  });

  it('returns null nextTierThreshold for moderate_autonomy (explicit opt-in only)', async () => {
    mockUserRepository.findById.mockResolvedValue({ id: USER_ID, trust_tier: 'moderate_autonomy' });
    mockFeedbackRepository.findByUser.mockResolvedValue([{ type: 'approve' }]);
    const res = await getJson(buildApp(), `/api/twin/${USER_ID}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.nextTierThreshold).toBe(null);
    expect(res.body.nextTier).toBe(null);
    expect(res.body.threshold).toBe(null);
  });
});
