/**
 * Opt-in crash reporting for the desktop app (#399, parent #357 P3.1).
 *
 * Field crashes are invisible today. This module builds a small,
 * PII-scrubbed JSON crash payload (exception name, message, stack, app
 * version, OS/arch) and POSTs it to a configurable endpoint — but ONLY
 * when the user has explicitly opted in via the "Send anonymous crash
 * reports" setting (default OFF; see `desktop-preferences.ts`).
 *
 * Design constraints from the issue + repo conventions:
 *  - Default OFF. Honors the privacy promise — nothing is sent unless the
 *    user flips the toggle.
 *  - No user data. We never include the message/stack verbatim without
 *    first running it through `redactPii`, and we never include cwd,
 *    env, userData paths, signal content, or any twin profile data.
 *  - Typed result objects for the upload (expected-failure mode), not
 *    thrown exceptions — a crash uploader that throws on a flaky network
 *    is worse than the crash it's reporting.
 *  - Injectable transport (mirrors the `UpdateBackend` seam in
 *    `auto-update.ts`) so the pure payload-building + redaction logic is
 *    unit-testable without a real network or a real Electron process.
 *
 * Nothing here imports `electron` at module load, so it is safe to unit
 * test in a plain Node environment.
 */

/** Where crash reports are sent. Overridable via env for self-hosting. */
export const DEFAULT_CRASH_ENDPOINT =
  'https://crash.skytwin.dev/api/desktop/report';

/**
 * The JSON body uploaded for a single crash. Intentionally minimal — only
 * what a maintainer needs to triage a field crash, and nothing that could
 * identify the user or leak their data.
 */
export interface CrashReportPayload {
  /** Schema version, so the receiver can evolve the shape. */
  schema: 1;
  /** Constructor name of the thrown value, e.g. "TypeError". */
  name: string;
  /** Redacted error message. */
  message: string;
  /** Redacted stack trace, or null if the thrown value had none. */
  stack: string | null;
  /** App version (from app.getVersion()). */
  appVersion: string;
  /** Node process platform, e.g. "darwin". */
  platform: string;
  /** Process arch, e.g. "arm64". */
  arch: string;
  /** Where the crash was caught. */
  kind: 'uncaughtException' | 'unhandledRejection';
  /** ISO-8601 timestamp the report was built. */
  occurredAt: string;
}

/** Context the payload builder needs that isn't on the error itself. */
export interface CrashContext {
  appVersion: string;
  platform: string;
  arch: string;
  kind: CrashReportPayload['kind'];
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: () => Date;
}

/** Result of an upload attempt. Typed-result, never throws on expected failures. */
export type CrashUploadResult =
  | { success: true }
  | { success: false; error: string };

/**
 * Transport seam. The default impl uses `fetch`; tests inject a stub.
 * Returns a typed result rather than throwing.
 */
export interface CrashTransport {
  send(endpoint: string, payload: CrashReportPayload): Promise<CrashUploadResult>;
}

/**
 * Redacts personally-identifying / sensitive substrings from a string
 * before it leaves the machine. Conservative by design: it would rather
 * over-redact a stack frame than leak a home-directory path or an email.
 *
 * Covered:
 *  - Absolute filesystem paths (POSIX `/Users/...`, `/home/...`, and
 *    Windows `C:\Users\...`) → the user segment is replaced so the rest
 *    of the path (which is useful for triage) survives.
 *  - `file://` URLs (V8 stack frames use these under ESM).
 *  - Email addresses.
 *  - Bearer / API-key-shaped tokens.
 *
 * Returns the redacted string. An empty/blank input returns ''.
 */
export function redactPii(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  let out = input;

  // Email addresses → <redacted-email>
  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    '<redacted-email>',
  );

  // Bearer tokens and "key=<long-token>" shapes. Match before generic
  // path redaction so the token body is gone regardless of context.
  // `authorization` is deliberately NOT in the key=value list — the
  // Bearer rule above already covers the common `Authorization: Bearer …`
  // header, and listing it here would clobber the recognizable
  // `Bearer <redacted-token>` form with a generic `<redacted>`.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer <redacted-token>');
  out = out.replace(
    /\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi,
    '$1<redacted>',
  );

  // file:// URLs — strip the user-home portion, keep the tail.
  out = out.replace(
    /file:\/\/\/(?:Users|home)\/[^/\\\s)]+/gi,
    'file:///<redacted-home>',
  );

  // POSIX home dirs: /Users/<name>/... and /home/<name>/...
  out = out.replace(/\/(Users|home)\/[^/\\\s)]+/gi, '/$1/<redacted-user>');

  // Windows home dirs: C:\Users\<name>\...
  out = out.replace(
    /([A-Za-z]:\\Users\\)[^\\\s)]+/gi,
    '$1<redacted-user>',
  );

  return out;
}

/**
 * Builds the JSON payload for a thrown value. Pure — no I/O. The thrown
 * value may be anything (JS lets you `throw 42`), so we normalize.
 * Both `message` and `stack` are run through `redactPii`.
 */
export function buildCrashPayload(
  thrown: unknown,
  ctx: CrashContext,
): CrashReportPayload {
  const now = ctx.now ?? (() => new Date());
  let name = 'Error';
  let message = '';
  let stack: string | null = null;

  if (thrown instanceof Error) {
    name = thrown.name || 'Error';
    message = thrown.message ?? '';
    stack = typeof thrown.stack === 'string' ? thrown.stack : null;
  } else if (typeof thrown === 'string') {
    message = thrown;
  } else {
    // Non-Error throw (number, object, null, …). Stringify defensively.
    try {
      message = String(thrown);
    } catch {
      message = '<unstringifiable thrown value>';
    }
  }

  return {
    schema: 1,
    name,
    message: redactPii(message),
    stack: stack === null ? null : redactPii(stack),
    appVersion: ctx.appVersion,
    platform: ctx.platform,
    arch: ctx.arch,
    kind: ctx.kind,
    occurredAt: now().toISOString(),
  };
}

/** Default transport built on the global `fetch`. */
export class FetchCrashTransport implements CrashTransport {
  async send(
    endpoint: string,
    payload: CrashReportPayload,
  ): Promise<CrashUploadResult> {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` };
      }
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network error';
      return { success: false, error: msg };
    }
  }
}

/**
 * Sends a crash report — but only if `enabled` is true. The gate lives
 * here (not just at the call site) so there is one obvious place the
 * opt-in is enforced: a caller that forgets to check the preference
 * still can't leak a report.
 *
 * Returns a typed result. `{ success: false, error: 'reporting disabled' }`
 * when the user has not opted in — distinguishable from an upload failure.
 */
export async function reportCrash(args: {
  enabled: boolean;
  thrown: unknown;
  context: CrashContext;
  endpoint?: string;
  transport?: CrashTransport;
}): Promise<CrashUploadResult> {
  if (args.enabled !== true) {
    return { success: false, error: 'reporting disabled' };
  }
  const endpoint = args.endpoint ?? DEFAULT_CRASH_ENDPOINT;
  const transport = args.transport ?? new FetchCrashTransport();
  const payload = buildCrashPayload(args.thrown, args.context);
  return transport.send(endpoint, payload);
}
