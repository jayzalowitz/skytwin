/**
 * Tests for the demo-fixture briefing wiring (#482).
 *
 * The fixture must force a daily briefing for the demo user after ingest so
 * `/api/twin-briefings/latest` is populated immediately (AC#1 / impl detail
 * #7) — invoking the worker job as `{ cadence: 'daily', userIds: [DEMO_USER_ID] }`.
 * The trigger is best-effort: a failed/unavailable worker degrades to a typed
 * result, never an exception that aborts an already-ingested fixture.
 *
 * `runBriefing` is injectable so we can assert the exact wiring without a DB
 * or a running worker.
 */
import { describe, it, expect, vi } from 'vitest';
import { triggerDemoBriefing } from '../seeds/demo-briefing.js';
import { DEMO_USER_ID } from '../seeds/demo-guard.js';

describe('triggerDemoBriefing — forces a daily demo briefing (#482)', () => {
  it('invokes the briefing runner with cadence=daily and the demo user only', async () => {
    const runBriefing = vi.fn().mockResolvedValue(undefined);

    const result = await triggerDemoBriefing({ userId: DEMO_USER_ID, runBriefing });

    expect(result).toEqual({ ok: true });
    expect(runBriefing).toHaveBeenCalledTimes(1);
    expect(runBriefing).toHaveBeenCalledWith({
      cadence: 'daily',
      userIds: [DEMO_USER_ID],
    });
  });

  it('scopes the briefing to exactly the passed userId (never a broad fan-out)', async () => {
    const runBriefing = vi.fn().mockResolvedValue(undefined);

    await triggerDemoBriefing({ userId: 'demo-123', runBriefing });

    const arg = runBriefing.mock.calls[0]![0] as { userIds: string[] };
    expect(arg.userIds).toEqual(['demo-123']);
    expect(arg.userIds).toHaveLength(1);
  });

  it('degrades to a typed ok:false (does not throw) when the runner fails', async () => {
    const runBriefing = vi.fn().mockRejectedValue(new Error('worker unavailable'));

    const result = await triggerDemoBriefing({ userId: DEMO_USER_ID, runBriefing });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/worker unavailable/);
  });

  it('stringifies non-Error throwables into the failure reason', async () => {
    const runBriefing = vi.fn().mockRejectedValue('boom');

    const result = await triggerDemoBriefing({ userId: DEMO_USER_ID, runBriefing });

    expect(result).toEqual({ ok: false, reason: 'boom' });
  });
});
