import { describe, it, expect, afterEach } from 'vitest';
import { buildIngestHeaders } from '../ingest-headers.js';

/**
 * The worker used to POST `/api/events/ingest` with `Content-Type` only. That
 * works in dev (localhost auth bypass) and 401s in every packaged build, where
 * the desktop pins NODE_ENV=production and SKYTWIN_DEV_AUTH_BYPASS=false.
 */
describe('buildIngestHeaders', () => {
  const saved = process.env['SKYTWIN_SERVICE_TOKEN'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SKYTWIN_SERVICE_TOKEN'];
    else process.env['SKYTWIN_SERVICE_TOKEN'] = saved;
  });

  it('sends the service credential in the dedicated header when configured', () => {
    // Deliberately NOT `Authorization`: apps/web proxies dashboard traffic to
    // the API and forwards `Authorization` verbatim over a fresh localhost
    // connection, so a credential on that header could be laundered through
    // the proxy by a remote caller and arrive looking like loopback.
    expect(buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: 'tok-123' })).toEqual({
      'Content-Type': 'application/json',
      'X-SkyTwin-Service-Token': 'tok-123',
    });
  });

  it('never sends the service credential on the Authorization header', () => {
    expect(
      buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: 'tok-123' })['Authorization'],
    ).toBeUndefined();
  });

  it('trims surrounding whitespace so a stray newline in the secret file cannot corrupt the header', () => {
    expect(buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: '  tok-123\n' })['X-SkyTwin-Service-Token']).toBe(
      'tok-123',
    );
  });

  it('omits the header when no token is configured (dev bypass path)', () => {
    expect(buildIngestHeaders({})).toEqual({ 'Content-Type': 'application/json' });
  });

  it('omits the header for a blank token rather than sending an empty one', () => {
    expect(buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: '   ' })).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('reads process.env by default and picks up rotation between calls', () => {
    delete process.env['SKYTWIN_SERVICE_TOKEN'];
    expect(buildIngestHeaders()['X-SkyTwin-Service-Token']).toBeUndefined();

    process.env['SKYTWIN_SERVICE_TOKEN'] = 'rotated';
    expect(buildIngestHeaders()['X-SkyTwin-Service-Token']).toBe('rotated');
  });
});
