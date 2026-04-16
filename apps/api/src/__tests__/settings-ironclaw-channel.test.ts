import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

// ---------------------------------------------------------------------------
// Mock modules -- vi.hoisted ensures these are available when vi.mock
// factories execute (vi.mock calls are hoisted above all other code).
// ---------------------------------------------------------------------------

const {
  mockUserRepository,
  mockDomainAutonomyRepository,
  mockEscalationTriggerRepository,
  mockAiProviderRepository,
} = vi.hoisted(() => ({
  mockUserRepository: {
    findById: vi.fn(),
    updateIronClawChannel: vi.fn(),
    updateAutonomySettings: vi.fn(),
  },
  mockDomainAutonomyRepository: {
    getForUser: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  mockEscalationTriggerRepository: {
    getForUser: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockAiProviderRepository: {
    getForUser: vi.fn(),
    replaceAll: vi.fn(),
  },
}));

vi.mock('@skytwin/db', () => ({
  userRepository: mockUserRepository,
  domainAutonomyRepository: mockDomainAutonomyRepository,
  escalationTriggerRepository: mockEscalationTriggerRepository,
  aiProviderRepository: mockAiProviderRepository,
}));

vi.mock('@skytwin/shared-types', async () => {
  const actual = await vi.importActual('@skytwin/shared-types');
  return actual;
});

vi.mock('@skytwin/llm-client', () => ({
  LlmClient: { testProvider: vi.fn() },
  validateBaseUrlWithDns: vi.fn(),
}));

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are wired
// ---------------------------------------------------------------------------

import { createSettingsRouter } from '../routes/settings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter());
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

/**
 * Lightweight test helper that makes HTTP requests to an Express app
 * without needing supertest. Uses the native Node fetch API against
 * a locally started server.
 */
async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const options: RequestInit = { method, headers };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      fetch(url, options)
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PUT /api/settings/:userId/ironclaw-channel', () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('updates channel successfully', async () => {
    mockUserRepository.updateIronClawChannel.mockResolvedValue({
      id: 'user-1',
      ironclaw_channel: 'telegram',
    });

    const res = await request(app, 'PUT', '/api/settings/user-1/ironclaw-channel', {
      ironclawChannel: 'telegram',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: 'user-1',
      ironclawChannel: 'telegram',
    });
    expect(mockUserRepository.updateIronClawChannel).toHaveBeenCalledWith('user-1', 'telegram');
  });

  it('returns 400 for empty ironclawChannel', async () => {
    const res = await request(app, 'PUT', '/api/settings/user-1/ironclaw-channel', {
      ironclawChannel: '',
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid IronClaw channel/);
    expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
  });

  it('returns 400 for missing ironclawChannel', async () => {
    const res = await request(app, 'PUT', '/api/settings/user-1/ironclaw-channel', {});

    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid IronClaw channel/);
    expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
  });

  it('returns 400 for channel with invalid chars', async () => {
    const invalidChannels = ['has spaces', '<script>alert(1)</script>', 'slashes/bad', 'hash#no'];

    for (const channel of invalidChannels) {
      vi.clearAllMocks();

      const res = await request(app, 'PUT', '/api/settings/user-1/ironclaw-channel', {
        ironclawChannel: channel,
      });

      expect(res.status).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toMatch(/Invalid IronClaw channel/);
      expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
    }
  });

  it('returns 400 for channel over 64 chars', async () => {
    const longChannel = 'a'.repeat(65);

    const res = await request(app, 'PUT', '/api/settings/user-1/ironclaw-channel', {
      ironclawChannel: longChannel,
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Invalid IronClaw channel/);
    expect(mockUserRepository.updateIronClawChannel).not.toHaveBeenCalled();
  });

  it('returns 404 when user not found', async () => {
    mockUserRepository.updateIronClawChannel.mockResolvedValue(null);

    const res = await request(app, 'PUT', '/api/settings/nonexistent-user/ironclaw-channel', {
      ironclawChannel: 'telegram',
    });

    expect(res.status).toBe(404);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/User not found/);
  });

  it('accepts valid channels with allowed characters', async () => {
    const validChannels = ['skytwin', 'telegram', 'my.channel_v2', 'discord:general'];

    for (const channel of validChannels) {
      vi.clearAllMocks();

      mockUserRepository.updateIronClawChannel.mockResolvedValue({
        id: 'user-1',
        ironclaw_channel: channel,
      });

      const res = await request(app, 'PUT', '/api/settings/user-1/ironclaw-channel', {
        ironclawChannel: channel,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        userId: 'user-1',
        ironclawChannel: channel,
      });
      expect(mockUserRepository.updateIronClawChannel).toHaveBeenCalledWith('user-1', channel);
    }
  });
});
