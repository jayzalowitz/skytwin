import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { request as httpRequest } from 'node:http';
import {
  oauthPkcePendingRepository,
  oauthPendingSigninRepository,
  oauthRepository,
  serviceCredentialRepository,
} from '@skytwin/db';
import { createOAuthRouter } from '../routes/oauth.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth', createOAuthRouter());
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return app;
}

async function request(app: Express, method: string, path: string): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine test server port'));
        return;
      }
      const request = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          server.close();
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      request.on('error', (error) => {
        server.close();
        reject(error);
      });
      request.end();
    });
  });
}

describe('disabled Google OAuth boundary', () => {
  const priorMode = process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'];

  beforeEach(() => {
    process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = 'disabled';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (priorMode === undefined) delete process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'];
    else process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = priorMode;
  });

  it.each([
    ['GET', '/api/oauth/google/authorize?newUser=true&include=gmail'],
    ['GET', '/api/oauth/google/callback?code=plausible-code&state=plausible-state'],
    ['GET', '/api/oauth/google/pending/550e8400-e29b-41d4-a716-446655440000'],
    ['GET', '/api/oauth/google/status?userId=owner-1'],
    ['GET', '/api/oauth/google/accounts/owner-1'],
    ['DELETE', '/api/oauth/google/owner-1/user%40example.com'],
    ['DELETE', '/api/oauth/google/disconnect'],
  ])('rejects %s %s before token, config, or network effects', async (method, path) => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const configRead = vi.spyOn(serviceCredentialRepository, 'getAsMap');
    const tokenRead = vi.spyOn(oauthRepository, 'getToken');
    const accountRead = vi.spyOn(oauthRepository, 'listAccountsForUser');
    const disconnect = vi.spyOn(oauthRepository, 'beginDisconnect');
    const consumePkce = vi.spyOn(oauthPkcePendingRepository, 'consume');
    const pendingConsume = vi.spyOn(oauthPendingSigninRepository, 'consume');

    const response = await request(buildApp(), method, path);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: 'GOOGLE_CONNECTION_DISABLED',
      available: false,
      mode: 'disabled',
    });
    expect(configRead).not.toHaveBeenCalled();
    expect(tokenRead).not.toHaveBeenCalled();
    expect(accountRead).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(consumePkce).not.toHaveBeenCalled();
    expect(pendingConsume).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
