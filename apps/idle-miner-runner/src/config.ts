/**
 * Config for the managed idle-miner process, parsed from the environment the
 * desktop `ServiceManager` sets when it spawns this process.
 *
 * Everything is FAIL-CLOSED. This process scans the user's real filesystem, so
 * it must never run on ambiguous defaults: a missing enable-flag, user id,
 * ingest URL, data dir, or home dir returns an error and the process refuses to
 * start. The `SKYTWIN_IDLE_MINER_ENABLED` gate is checked here too (not only at
 * the desktop that decides whether to spawn) as defense in depth — the miner
 * can't run unless the flag is explicitly `true`.
 */

export interface RunnerConfig {
  userId: string;
  ingestUrl: string;
  dataDir: string;
  homedir: string;
  /**
   * Loopback service credential for `/api/events/ingest`. Optional because a
   * dev API with the localhost auth bypass on accepts unauthenticated posts;
   * in a packaged build the desktop always sets `SKYTWIN_SERVICE_TOKEN` and
   * without it every mined signal 401s.
   */
  serviceToken?: string;
}

export type ParseResult =
  | { ok: true; config: RunnerConfig }
  | { ok: false; error: string };

function trimmed(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function parseRunnerConfig(env: Record<string, string | undefined>): ParseResult {
  // Feature flag, default off. Belt-and-suspenders with the desktop's
  // spawn-decision gate — this process itself won't mine unless explicitly on.
  if (env['SKYTWIN_IDLE_MINER_ENABLED'] !== 'true') {
    return { ok: false, error: 'SKYTWIN_IDLE_MINER_ENABLED is not "true" — idle mining is disabled (default off)' };
  }

  const userId = trimmed(env, 'SKYTWIN_IDLE_MINER_USER_ID');
  if (!userId) {
    return { ok: false, error: 'SKYTWIN_IDLE_MINER_USER_ID is required (fail-closed: no resolved user, no mining)' };
  }

  const ingestUrl = trimmed(env, 'SKYTWIN_IDLE_MINER_INGEST_URL');
  if (!ingestUrl) {
    return { ok: false, error: 'SKYTWIN_IDLE_MINER_INGEST_URL is required' };
  }
  try {
    // eslint-disable-next-line no-new
    new URL(ingestUrl);
  } catch {
    return { ok: false, error: `SKYTWIN_IDLE_MINER_INGEST_URL is not a valid URL: ${ingestUrl}` };
  }

  const dataDir = trimmed(env, 'SKYTWIN_IDLE_MINER_DATA_DIR');
  if (!dataDir) {
    return { ok: false, error: 'SKYTWIN_IDLE_MINER_DATA_DIR is required (device-local file-index location)' };
  }

  const homedir =
    trimmed(env, 'SKYTWIN_IDLE_MINER_HOME') ?? trimmed(env, 'HOME') ?? trimmed(env, 'USERPROFILE');
  if (!homedir) {
    return { ok: false, error: 'home directory could not be resolved (set SKYTWIN_IDLE_MINER_HOME or HOME/USERPROFILE)' };
  }

  // Not fail-closed: a missing token is a legitimate dev configuration (the
  // API's localhost bypass). Refusing to start would break `pnpm dev`, and the
  // failure mode with a bypass-less API is a loud 401 per signal, not silent
  // over-permission.
  const serviceToken = trimmed(env, 'SKYTWIN_SERVICE_TOKEN');

  return {
    ok: true,
    config: {
      userId,
      ingestUrl,
      dataDir,
      homedir,
      ...(serviceToken !== undefined ? { serviceToken } : {}),
    },
  };
}
