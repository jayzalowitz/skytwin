import express from 'express';
import type { Express } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockGetLatestBriefing } = vi.hoisted(() => ({
  mockConfig: { googleConnectionMode: 'disabled' },
  mockGetLatestBriefing: vi.fn(),
}));

vi.mock('@skytwin/config', () => ({ loadConfig: () => mockConfig }));
vi.mock('@skytwin/db', () => ({
  proactiveScanRepository: { getLatestBriefing: mockGetLatestBriefing },
  userRepository: {
    findById: vi.fn(),
    updateAutonomySettings: vi.fn(),
  },
}));

import { DEMO_USER_ID } from '../auth/demo-session.js';
import { createBriefingsRouter } from '../routes/briefings.js';

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/briefings', createBriefingsRouter());
  return app;
}

async function getBriefing(userId: string): Promise<{
  status: number;
  body: { briefing: { id: string; userId: string; items: unknown[] } };
}> {
  return new Promise((resolve, reject) => {
    const server = buildApp().listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}/api/v1/briefings/${userId}`)
        .then(async (response) => {
          const body = await response.json() as {
            briefing: { id: string; userId: string; items: unknown[] };
          };
          server.close();
          resolve({ status: response.status, body });
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

function retainedRow(userId: string) {
  return {
    id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    user_id: userId,
    scan_id: null,
    items: [{ title: 'Retained account-derived item' }],
    email_sent: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('proactive briefing account-free boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.googleConnectionMode = 'disabled';
  });

  it('returns an empty envelope for a non-sample user before reading retained rows', async () => {
    mockGetLatestBriefing.mockResolvedValue(retainedRow(USER_ID));

    const response = await getBriefing(USER_ID);

    expect(response.status).toBe(200);
    expect(response.body.briefing).toMatchObject({
      id: `briefing_empty_${USER_ID}`,
      userId: USER_ID,
      items: [],
    });
    expect(mockGetLatestBriefing).not.toHaveBeenCalled();
  });

  it('preserves the fictional sample briefing while disabled', async () => {
    mockGetLatestBriefing.mockResolvedValue(retainedRow(DEMO_USER_ID));

    const response = await getBriefing(DEMO_USER_ID);

    expect(response.status).toBe(200);
    expect(response.body.briefing.items).toHaveLength(1);
    expect(mockGetLatestBriefing).toHaveBeenCalledWith(DEMO_USER_ID);
  });

  it('preserves non-sample source-development access only in exact experimental mode', async () => {
    mockConfig.googleConnectionMode = 'experimental';
    mockGetLatestBriefing.mockResolvedValue(retainedRow(USER_ID));

    const response = await getBriefing(USER_ID);

    expect(response.status).toBe(200);
    expect(response.body.briefing.items).toHaveLength(1);
    expect(mockGetLatestBriefing).toHaveBeenCalledWith(USER_ID);
  });
});
