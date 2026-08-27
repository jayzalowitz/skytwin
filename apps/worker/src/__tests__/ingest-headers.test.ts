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

  it('sends the service credential as a bearer token when configured', () => {
    expect(buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: 'tok-123' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok-123',
    });
  });

  it('trims surrounding whitespace so a stray newline in the secret file cannot corrupt the header', () => {
    expect(buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: '  tok-123\n' })['Authorization']).toBe(
      'Bearer tok-123',
    );
  });

  it('omits the header when no token is configured (dev bypass path)', () => {
    expect(buildIngestHeaders({})).toEqual({ 'Content-Type': 'application/json' });
  });

  it('omits the header for a blank token rather than sending "Bearer "', () => {
    expect(buildIngestHeaders({ SKYTWIN_SERVICE_TOKEN: '   ' })).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('reads process.env by default and picks up rotation between calls', () => {
    delete process.env['SKYTWIN_SERVICE_TOKEN'];
    expect(buildIngestHeaders()['Authorization']).toBeUndefined();

    process.env['SKYTWIN_SERVICE_TOKEN'] = 'rotated';
    expect(buildIngestHeaders()['Authorization']).toBe('Bearer rotated');
  });
});
