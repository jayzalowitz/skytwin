import { describe, it, expect, vi } from 'vitest';
import {
  redactPii,
  buildCrashPayload,
  reportCrash,
  FetchCrashTransport,
  DEFAULT_CRASH_ENDPOINT,
  type CrashContext,
  type CrashTransport,
  type CrashReportPayload,
  type CrashUploadResult,
} from '../crash-reporter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<CrashContext> = {}): CrashContext {
  return {
    appVersion: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    kind: 'uncaughtException',
    now: () => new Date('2026-06-15T00:00:00.000Z'),
    ...overrides,
  };
}

/** Records what it was asked to send and returns a configurable result. */
class StubTransport implements CrashTransport {
  public calls: { endpoint: string; payload: CrashReportPayload }[] = [];
  public nextResult: CrashUploadResult = { success: true };

  async send(endpoint: string, payload: CrashReportPayload): Promise<CrashUploadResult> {
    this.calls.push({ endpoint, payload });
    return this.nextResult;
  }
}

// ---------------------------------------------------------------------------
// redactPii
// ---------------------------------------------------------------------------

describe('redactPii', () => {

  // Bare vendor-prefixed keys (codex review on the privacy-policy PR). The
  // Bearer and `token=` rules only fire on LABELLED secrets; an SDK that
  // throws with the key inlined arrives unlabelled, and the published privacy
  // policy promises these are scrubbed.
  //
  // Every fixture is assembled from a prefix + body at runtime. A literal
  // secret-shaped string in source trips the repo's pre-commit secret
  // scanner, even for well-known dummy values.
  it.each([
    ['sk-', 'abcdefghijklmnopqrstuvwx', 'OpenAI'],
    ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123', 'GitHub PAT'],
    ['github_pat_', 'abcdefghijklmnopqrstuv_wxyz', 'GitHub fine-grained PAT'],
    ['xoxb-', '1234567890-abcdefghij', 'Slack bot'],
    ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv', 'Google API key'],
    ['AKIA', 'IOSFODNN7EXAMPLE', 'AWS access key id'],
  ])('redacts a bare %s… key (%s)', (prefix, body) => {
    const secret = `${prefix}${body}`;
    const out = redactPii(`request failed with ${secret} at line 1`);
    expect(out).not.toContain(secret);
    expect(out).toContain('<redacted-token>');
  });

  it('leaves ordinary stack-trace identifiers alone', () => {
    const stack = 'at Object.handleRequest (/app/dist/server.js:42:11) skipTest';
    expect(redactPii(stack)).toContain('handleRequest');
    expect(redactPii(stack)).toContain('skipTest');
  });
  it('redacts email addresses', () => {
    expect(redactPii('failed for jay@example.com on send')).toBe(
      'failed for <redacted-email> on send',
    );
  });

  it('redacts POSIX home directory paths but keeps the tail', () => {
    const out = redactPii('at /Users/jay/skytwin/apps/desktop/main.js:42');
    expect(out).toBe('at /Users/<redacted-user>/skytwin/apps/desktop/main.js:42');
    expect(out).not.toContain('/jay/');
  });

  it('redacts Linux home directory paths', () => {
    expect(redactPii('/home/alice/app/x.js')).toBe('/home/<redacted-user>/app/x.js');
  });

  it('redacts Windows home directory paths', () => {
    const out = redactPii('C:\\Users\\Bob\\AppData\\skytwin\\main.js');
    expect(out).toContain('C:\\Users\\<redacted-user>\\');
    expect(out).not.toContain('Bob');
  });

  it('redacts file:// stack-frame URLs', () => {
    const out = redactPii('at file:///Users/jay/app/dist/main.js:1:1');
    expect(out).toContain('file:///<redacted-home>');
    expect(out).not.toContain('/jay/');
  });

  it('redacts bearer tokens and key=value secrets', () => {
    expect(redactPii('Authorization: Bearer abc.def.ghi')).toContain('Bearer <redacted-token>');
    expect(redactPii('api_key=sk-12345secret')).toBe('api_key=<redacted>');
  });

  it('returns empty string for empty / non-string input', () => {
    expect(redactPii('')).toBe('');
    // @ts-expect-error exercising the runtime guard against non-strings
    expect(redactPii(undefined)).toBe('');
  });

  it('leaves a clean message untouched', () => {
    expect(redactPii('Cannot read property foo of undefined')).toBe(
      'Cannot read property foo of undefined',
    );
  });
});

// ---------------------------------------------------------------------------
// buildCrashPayload
// ---------------------------------------------------------------------------

describe('buildCrashPayload', () => {
  it('extracts name / message / stack from an Error and redacts them', () => {
    const err = new TypeError('boom for jay@example.com');
    err.stack = 'TypeError: boom\n    at /Users/jay/app/main.js:1:1';
    const payload = buildCrashPayload(err, makeContext());

    expect(payload.schema).toBe(1);
    expect(payload.name).toBe('TypeError');
    expect(payload.message).toBe('boom for <redacted-email>');
    expect(payload.stack).toContain('/Users/<redacted-user>/app/main.js');
    expect(payload.stack).not.toContain('/jay/');
    expect(payload.appVersion).toBe('1.2.3');
    expect(payload.platform).toBe('darwin');
    expect(payload.arch).toBe('arm64');
    expect(payload.kind).toBe('uncaughtException');
    expect(payload.occurredAt).toBe('2026-06-15T00:00:00.000Z');
  });

  it('handles a string throw (no Error object, no stack)', () => {
    const payload = buildCrashPayload('something broke', makeContext());
    expect(payload.name).toBe('Error');
    expect(payload.message).toBe('something broke');
    expect(payload.stack).toBeNull();
  });

  it('handles a non-Error, non-string throw without crashing', () => {
    const payload = buildCrashPayload({ weird: true }, makeContext({ kind: 'unhandledRejection' }));
    expect(payload.kind).toBe('unhandledRejection');
    expect(typeof payload.message).toBe('string');
    expect(payload.stack).toBeNull();
  });

  it('never includes user data beyond the declared fields', () => {
    const err = new Error('x');
    const payload = buildCrashPayload(err, makeContext());
    expect(Object.keys(payload).sort()).toEqual(
      ['appVersion', 'arch', 'kind', 'message', 'name', 'occurredAt', 'platform', 'schema', 'stack'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// reportCrash — the opt-in gate
// ---------------------------------------------------------------------------

describe('reportCrash', () => {
  it('does NOT send when disabled (opt-in default)', async () => {
    const transport = new StubTransport();
    const result = await reportCrash({
      enabled: false,
      thrown: new Error('boom'),
      context: makeContext(),
      transport,
    });
    expect(result).toEqual({ success: false, error: 'reporting disabled' });
    expect(transport.calls).toHaveLength(0);
  });

  it('does NOT send when enabled is anything other than literal true', async () => {
    const transport = new StubTransport();
    // @ts-expect-error simulating a truthy-but-not-boolean value crossing IPC
    await reportCrash({ enabled: 'yes', thrown: new Error('x'), context: makeContext(), transport });
    expect(transport.calls).toHaveLength(0);
  });

  it('sends a redacted payload to the default endpoint when enabled', async () => {
    const transport = new StubTransport();
    const err = new Error('fail for jay@example.com');
    const result = await reportCrash({
      enabled: true,
      thrown: err,
      context: makeContext(),
      transport,
    });
    expect(result).toEqual({ success: true });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].endpoint).toBe(DEFAULT_CRASH_ENDPOINT);
    expect(transport.calls[0].payload.message).toBe('fail for <redacted-email>');
  });

  it('honors a custom endpoint override', async () => {
    const transport = new StubTransport();
    await reportCrash({
      enabled: true,
      thrown: new Error('x'),
      context: makeContext(),
      endpoint: 'https://self-hosted.example/report',
      transport,
    });
    expect(transport.calls[0].endpoint).toBe('https://self-hosted.example/report');
  });

  it('surfaces an upload failure as a typed result rather than throwing', async () => {
    const transport = new StubTransport();
    transport.nextResult = { success: false, error: 'HTTP 503' };
    const result = await reportCrash({
      enabled: true,
      thrown: new Error('x'),
      context: makeContext(),
      transport,
    });
    expect(result).toEqual({ success: false, error: 'HTTP 503' });
  });
});

// ---------------------------------------------------------------------------
// FetchCrashTransport
// ---------------------------------------------------------------------------

describe('FetchCrashTransport', () => {
  const payload: CrashReportPayload = {
    schema: 1,
    name: 'Error',
    message: 'x',
    stack: null,
    appVersion: '1.0.0',
    platform: 'linux',
    arch: 'x64',
    kind: 'uncaughtException',
    occurredAt: '2026-06-15T00:00:00.000Z',
  };

  it('returns success on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new FetchCrashTransport().send('https://x/report', payload);
    expect(result).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x/report',
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
  });

  it('returns a typed failure on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await new FetchCrashTransport().send('https://x/report', payload);
    expect(result).toEqual({ success: false, error: 'HTTP 500' });
    vi.unstubAllGlobals();
  });

  it('returns a typed failure (does not throw) on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await new FetchCrashTransport().send('https://x/report', payload);
    expect(result).toEqual({ success: false, error: 'ECONNREFUSED' });
    vi.unstubAllGlobals();
  });
});
