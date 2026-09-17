import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import { request as httpRequest } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  oauthPkcePendingRepository,
  oauthPendingSigninRepository,
  oauthRepository,
  serviceCredentialRepository,
} from '@skytwin/db';
import {
  _authorizeDesktopBootstrapForTests,
  _resetDesktopBootstrapNoncesForTests,
  createOAuthRouter,
} from '../routes/oauth.js';

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
  const priorDesktopMode = process.env['DESKTOP_MODE'];
  const priorInstanceCapability = process.env['SKYTWIN_API_INSTANCE_CAPABILITY'];
  const priorBootstrapSecret = process.env['SKYTWIN_DESKTOP_BOOTSTRAP_SECRET'];
  const priorPackagedGoogleOnly = process.env['SKYTWIN_PACKAGED_GOOGLE_ONLY'];

  beforeEach(() => {
    process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = 'disabled';
    _resetDesktopBootstrapNoncesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (priorMode === undefined) delete process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'];
    else process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = priorMode;
    if (priorDesktopMode === undefined) delete process.env['DESKTOP_MODE'];
    else process.env['DESKTOP_MODE'] = priorDesktopMode;
    if (priorInstanceCapability === undefined) delete process.env['SKYTWIN_API_INSTANCE_CAPABILITY'];
    else process.env['SKYTWIN_API_INSTANCE_CAPABILITY'] = priorInstanceCapability;
    if (priorBootstrapSecret === undefined) delete process.env['SKYTWIN_DESKTOP_BOOTSTRAP_SECRET'];
    else process.env['SKYTWIN_DESKTOP_BOOTSTRAP_SECRET'] = priorBootstrapSecret;
    if (priorPackagedGoogleOnly === undefined) delete process.env['SKYTWIN_PACKAGED_GOOGLE_ONLY'];
    else process.env['SKYTWIN_PACKAGED_GOOGLE_ONLY'] = priorPackagedGoogleOnly;
  });

  it('rejects a browser credential bootstrap before any credential or user write', async () => {
    process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = 'experimental';
    process.env['DESKTOP_MODE'] = 'true';
    process.env['SKYTWIN_API_INSTANCE_CAPABILITY'] = 'a'.repeat(64);
    const credentialRead = vi.spyOn(serviceCredentialRepository, 'getAsMap');
    const credentialWrite = vi.spyOn(serviceCredentialRepository, 'upsert');
    const authorizationWrite = vi.spyOn(oauthRepository, 'issueNewUserAuthorization');

    const response = await request(buildApp(), 'POST', '/api/oauth/google/desktop-bootstrap');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Desktop first-use authority required.' });
    expect(credentialRead).not.toHaveBeenCalled();
    expect(credentialWrite).not.toHaveBeenCalled();
    expect(authorizationWrite).not.toHaveBeenCalled();
  });

  it('binds desktop authority to the body and rejects nonce replay', () => {
    const secret = 'b'.repeat(64);
    process.env['DESKTOP_MODE'] = 'true';
    process.env['SKYTWIN_DESKTOP_BOOTSTRAP_SECRET'] = secret;
    const body = {
      clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'secret-value',
      pendingKey: randomUUID(),
    };
    const expires = String(Date.now() + 10_000);
    const nonce = randomUUID();
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const signature = createHmac('sha256', secret)
      .update(`POST\n/api/oauth/google/desktop-bootstrap\n${hash}\n${expires}\n${nonce}`)
      .digest('hex');
    const headers = {
      'x-skytwin-bootstrap-expires': expires,
      'x-skytwin-bootstrap-nonce': nonce,
      'x-skytwin-bootstrap-signature': signature,
    };

    expect(_authorizeDesktopBootstrapForTests(body, headers)).toEqual({ ok: true });
    expect(_authorizeDesktopBootstrapForTests(body, headers)).toEqual({ ok: false, reason: 'replayed' });
    expect(_authorizeDesktopBootstrapForTests({ ...body, clientSecret: 'changed' }, {
      ...headers,
      'x-skytwin-bootstrap-nonce': randomUUID(),
    })).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('does not expose the packaged new-user authorize path without Electron bootstrap', async () => {
    process.env['SKYTWIN_GOOGLE_CONNECTION_MODE'] = 'experimental';
    process.env['SKYTWIN_PACKAGED_GOOGLE_ONLY'] = 'true';
    const credentialRead = vi.spyOn(serviceCredentialRepository, 'getAsMap');
    const authorizationWrite = vi.spyOn(oauthRepository, 'issueNewUserAuthorization');

    const response = await request(buildApp(), 'GET', '/api/oauth/google/authorize?newUser=true');

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'DESKTOP_BOOTSTRAP_REQUIRED' });
    expect(credentialRead).not.toHaveBeenCalled();
    expect(authorizationWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/oauth/google/authorize?newUser=true&include=gmail', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/google/callback?code=plausible-code&state=plausible-state', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/google/pending/550e8400-e29b-41d4-a716-446655440000', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/google/status?userId=owner-1', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/google/accounts/owner-1', 'GOOGLE_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/google/owner-1/user%40example.com', 'GOOGLE_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/google/disconnect', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/%67oogle/status?userId=owner-1', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/%67oogle/accounts/owner-1', 'GOOGLE_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/%67oogle/owner-1/user%40example.com', 'GOOGLE_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/%67oogle/disconnect', 'GOOGLE_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/microsoft/authorize?userId=owner-1', 'MICROSOFT_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/microsoft/callback?code=plausible-code&state=plausible-state', 'MICROSOFT_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/microsoft/status?userId=owner-1', 'MICROSOFT_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/microsoft/accounts/owner-1', 'MICROSOFT_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/microsoft/owner-1/user%40example.com', 'MICROSOFT_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/microsoft/disconnect', 'MICROSOFT_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/%6dicrosoft/status?userId=owner-1', 'MICROSOFT_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/%6dicrosoft/accounts/owner-1', 'MICROSOFT_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/%6dicrosoft/owner-1/user%40example.com', 'MICROSOFT_CONNECTION_DISABLED'],
    ['DELETE', '/api/oauth/%6dicrosoft/disconnect', 'MICROSOFT_CONNECTION_DISABLED'],
    ['GET', '/api/oauth/outlook/status?userId=owner-1', 'MICROSOFT_CONNECTION_DISABLED'],
  ])('rejects %s %s before token, config, or network effects', async (method, path, expectedCode) => {
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
      code: expectedCode,
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
