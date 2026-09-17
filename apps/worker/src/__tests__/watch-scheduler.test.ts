import { describe, it, expect, vi } from 'vitest';
import type { ClaimedWatchSlot, SignalRow } from '@skytwin/db';
import type { Watch } from '@skytwin/shared-types';
import {
  shouldRunWatchScheduler,
  toMatchable,
  evaluateWatch,
  embeddedRuntimeIdentityMatches,
  parseWatchSynthesis,
  runWatchSchedulerJob,
  WATCH_SCHEDULER_INTERVAL_MS,
} from '../jobs/watch-scheduler.js';

function watch(over: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    userId: 'u1',
    name: 'Client mail',
    sourceText: 'flag mail from finance@acme.com',
    cadence: 'daily',
    hourOfDay: 8,
    filter: { sources: ['gmail'], fromContains: ['finance@acme.com'] },
    action: 'digest',
    status: 'active',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    lastRunAt: null,
    nextRunAt: new Date('2026-07-05T08:00:00Z'),
    workflowId: null,
    workflowVersionId: null,
    workflowProviderKey: null,
    workflowProviderSchemaVersion: null,
    contentHash: null,
    projectionVersion: null,
    ...over,
  };
}

function signal(over: Partial<SignalRow> = {}): SignalRow {
  return {
    id: 's1',
    user_id: 'u1',
    source: 'gmail',
    type: 'message',
    domain: 'general',
    data: { from: 'finance@acme.com', subject: 'Q3 budget' },
    timestamp: new Date('2026-07-05T07:00:00Z'),
    retention_until: new Date('2026-08-05T00:00:00Z'),
    created_at: new Date('2026-07-05T07:00:00Z'),
    source_signal_id: null,
    connector_account_id: null,
    resource_ref_id: null,
    ...over,
  };
}

describe('shouldRunWatchScheduler', () => {
  it('is false when disabled', () => {
    expect(shouldRunWatchScheduler({ enabled: false, nowMs: 1e9, lastRunAt: 0 })).toBe(false);
  });
  it('is false before the interval elapses', () => {
    expect(shouldRunWatchScheduler({ enabled: true, nowMs: 1000, lastRunAt: 999, intervalMs: 60_000 })).toBe(false);
  });
  it('is true once the interval elapses', () => {
    expect(shouldRunWatchScheduler({ enabled: true, nowMs: 61_000, lastRunAt: 0, intervalMs: 60_000 })).toBe(true);
  });
});

describe('toMatchable', () => {
  it('extracts source, sender, and searchable text', () => {
    const m = toMatchable(signal({ data: { organizer: 'boss@x.com', title: 'Sync', description: 'agenda' } }));
    expect(m.source).toBe('gmail');
    expect(m.from).toBe('boss@x.com'); // falls back to organizer
    expect(m.text).toContain('Sync');
    expect(m.text).toContain('agenda');
  });
});

describe('evaluateWatch', () => {
  const windowStart = new Date('2026-07-05T00:00:00Z');
  const windowEnd = new Date('2026-07-05T12:00:00Z');

  it('matches signals inside the window that satisfy the filter', () => {
    const signals = [
      signal({ id: 'a' }), // matches (gmail, from finance@acme.com)
      signal({ id: 'b', data: { from: 'stranger@x.com', subject: 'hi' } }), // wrong sender
      signal({ id: 'c', source: 'voice' }), // wrong source
    ];
    const r = evaluateWatch(watch(), signals, windowStart, windowEnd);
    expect(r.matchedCount).toBe(1);
    expect(r.matchedRefs).toEqual(['a']);
    expect(r.summary).toMatch(/1 update: Q3 budget/);
  });

  it('excludes signals at or before the window start', () => {
    const old = signal({ id: 'old', timestamp: new Date('2026-07-04T00:00:00Z') });
    expect(evaluateWatch(watch(), [old], windowStart, windowEnd).matchedCount).toBe(0);
  });

  it('excludes signals after the window end (claimed later, counted next run)', () => {
    const future = signal({ id: 'future', timestamp: new Date('2026-07-05T13:00:00Z') });
    expect(evaluateWatch(watch(), [future], windowStart, windowEnd).matchedCount).toBe(0);
  });

  it('includes a signal exactly at the window end (boundary counted once)', () => {
    const boundary = signal({ id: 'edge', timestamp: windowEnd });
    expect(evaluateWatch(watch(), [boundary], windowStart, windowEnd).matchedCount).toBe(1);
  });

  it('caps stored refs at MAX_STORED_REFS while matchedCount stays the true total', () => {
    const many = Array.from({ length: 250 }, (_, i) => signal({ id: `m${i}` }));
    const r = evaluateWatch(watch(), many, windowStart, windowEnd);
    expect(r.matchedCount).toBe(250);
    expect(r.matchedRefs).toHaveLength(200);
  });

  it('a notify watch summarizes tersely', () => {
    const r = evaluateWatch(watch({ action: 'notify' }), [signal({ id: 'a' })], windowStart, windowEnd);
    expect(r.summary).toMatch(/New match: Q3 budget/);
  });

  it('no matches → count 0, empty summary', () => {
    const r = evaluateWatch(watch(), [signal({ data: { from: 'nobody@x.com' } })], windowStart, windowEnd);
    expect(r.matchedCount).toBe(0);
    expect(r.summary).toBe('');
  });
});

describe('parseWatchSynthesis', () => {
  it('accepts only bounded JSON prose citing evidence from the admitted set', () => {
    expect(parseWatchSynthesis('{"summary":"Invoice due [signal-1]."}', new Set(['signal-1'])))
      .toBe('Invoice due [signal-1].');
    expect(parseWatchSynthesis('{"summary":"Invoice due."}', new Set(['signal-1']))).toBeNull();
    expect(parseWatchSynthesis('{"summary":"Invoice due [invented]."}', new Set(['signal-1'])))
      .toBeNull();
  });
});

describe('embeddedRuntimeIdentityMatches', () => {
  const pinned = {
    runtimeVersion: 'llama.cpp-b5000',
    modelArtifactSha256: 'a'.repeat(64),
  };

  it('requires the exact managed artifact digest and llama.cpp build', () => {
    expect(embeddedRuntimeIdentityMatches(pinned, {
      state: 'ready',
      modelName: 'managed.gguf',
      artifactSha256: 'a'.repeat(64),
      runtimeVersion: 'llama.cpp-b5000',
    })).toBe(true);
    expect(embeddedRuntimeIdentityMatches(pinned, {
      state: 'ready',
      modelName: 'managed.gguf',
      artifactSha256: 'b'.repeat(64),
      runtimeVersion: 'llama.cpp-b5000',
    })).toBe(false);
    expect(embeddedRuntimeIdentityMatches(pinned, {
      state: 'ready',
      modelName: 'managed.gguf',
      artifactSha256: 'a'.repeat(64),
      runtimeVersion: 'llama.cpp-b5001',
    })).toBe(false);
    expect(embeddedRuntimeIdentityMatches(pinned, {
      state: 'runtime_unavailable',
      reason: 'runtime_binary_missing',
    })).toBe(false);
  });
});

describe('runWatchSchedulerJob', () => {
  const NOW = new Date('2026-07-05T09:00:00Z');
  const WINDOW_START = new Date('2026-07-05T07:00:00Z');

  function claimedSlot(over: Partial<ClaimedWatchSlot> = {}): ClaimedWatchSlot {
    const source = watch();
    return {
      id: 'slot-1',
      watchId: source.id,
      userId: source.userId,
      spec: {
        name: source.name,
        cadence: source.cadence,
        hourOfDay: source.hourOfDay,
        filter: source.filter,
        action: source.action,
      },
      scheduledFor: new Date('2026-07-05T08:00:00Z'),
      windowStart: WINDOW_START,
      windowEnd: NOW,
      leaseToken: 'lease-1',
      attemptCount: 1,
      workflowId: null,
      workflowVersionId: null,
      workflowProviderKey: null,
      workflowProviderSchemaVersion: null,
      contentHash: null,
      projectionVersion: null,
      workflowPayloadSnapshot: null,
      workflowInferenceSnapshot: null,
      summaryInstruction: null,
      ...over,
    };
  }

  function runRepoWith(slots: Array<ClaimedWatchSlot | null>) {
    return {
      claimNextDueSlot: vi.fn()
        .mockImplementationOnce(async () => slots.shift() ?? null)
        .mockImplementation(async () => slots.shift() ?? null),
      completeSlot: vi.fn().mockResolvedValue(true),
      failSlot: vi.fn().mockResolvedValue('retry_scheduled' as const),
      pruneZeroMatchSlots: vi.fn().mockResolvedValue(0),
    };
  }

  function signalRepoWith(responses: Array<SignalRow[] | Error>) {
    const visitInWindowPages = vi.fn(async (
      _userId: string,
      _windowStart: Date,
      _windowEnd: Date,
      _pageSize: number,
      visit: (records: readonly SignalRow[]) => void | Promise<void>,
    ) => {
      const response = responses.shift() ?? [];
      if (response instanceof Error) throw response;
      await visit(response);
    });
    return { visitInWindowPages };
  }

  it('claims and completes a durable slot when its persisted window matches', async () => {
    const slot = claimedSlot();
    const runRepo = runRepoWith([slot, null]);
    const signalRepo = signalRepoWith([[
      signal({ id: 'a', timestamp: new Date('2026-07-05T08:00:00Z') }),
    ]]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo,
    });
    expect(signalRepo.visitInWindowPages).toHaveBeenCalledWith(
      slot.userId,
      WINDOW_START,
      NOW,
      500,
      expect.any(Function),
    );
    expect(runRepo.completeSlot).toHaveBeenCalledWith({
      id: slot.id,
      leaseToken: slot.leaseToken,
      matchedCount: 1,
      summary: expect.stringContaining('Q3 budget'),
      matchedRefs: ['a'],
      evidenceSnapshot: [expect.objectContaining({ signalId: 'a', title: 'Q3 budget' })],
      synthesisMetadata: null,
    });
    expect(runRepo.pruneZeroMatchSlots).toHaveBeenCalledWith(30, 100);
  });

  it('counts every paged match while retaining only a bounded evidence snapshot', async () => {
    const slot = claimedSlot();
    const runRepo = runRepoWith([slot, null]);
    const firstPage = Array.from({ length: 150 }, (_, index) => signal({
      id: `first-${String(index).padStart(3, '0')}`,
      timestamp: new Date(NOW.getTime() - index),
    }));
    const secondPage = Array.from({ length: 100 }, (_, index) => signal({
      id: `second-${String(index).padStart(3, '0')}`,
      timestamp: new Date(NOW.getTime() - 1_000 - index),
    }));
    const visitInWindowPages = vi.fn(async (
      _userId: string,
      _windowStart: Date,
      _windowEnd: Date,
      _pageSize: number,
      visit: (records: readonly SignalRow[]) => void | Promise<void>,
    ) => {
      await visit(firstPage);
      await visit(secondPage);
    });

    await runWatchSchedulerJob({ runRepo, signalRepo: { visitInWindowPages } });

    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      matchedCount: 250,
      matchedRefs: expect.any(Array),
      evidenceSnapshot: expect.any(Array),
      summary: expect.stringMatching(/^250 updates:/),
    }));
    const completion = runRepo.completeSlot.mock.calls[0]![0];
    expect(completion.matchedRefs).toHaveLength(200);
    expect(completion.evidenceSnapshot).toHaveLength(200);
    expect(completion.matchedRefs).toEqual(
      completion.evidenceSnapshot.map((item) => item.signalId),
    );
  });

  it('labels deterministic adaptive output when unattended AI synthesis is unavailable', async () => {
    const slot = claimedSlot({
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      workflowProviderKey: 'signal_digest.v1',
      workflowProviderSchemaVersion: '1',
      contentHash: 'a'.repeat(64),
      projectionVersion: 1,
      workflowPayloadSnapshot: {},
      summaryInstruction: 'Summarize matches.',
    });
    const runRepo = runRepoWith([slot, null]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: signalRepoWith([[
        signal({ id: 'a', timestamp: new Date('2026-07-05T08:00:00Z') }),
      ]]),
      synthesize: vi.fn().mockResolvedValue({
        text: null,
        metadata: {
          state: 'unavailable', reason: 'provider_failed',
          summaryInstructionSha256: 'b'.repeat(64),
        },
      }),
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringMatching(/^AI summary unavailable — .*Q3 budget/),
      matchedRefs: ['a'],
      synthesisMetadata: expect.objectContaining({ state: 'unavailable', reason: 'provider_failed' }),
    }));
  });

  it('persists generated AI prose and its provider provenance for adaptive runs', async () => {
    const slot = claimedSlot({
      workflowId: 'workflow-1', workflowVersionId: 'version-1',
      workflowProviderKey: 'signal_digest.v1', workflowProviderSchemaVersion: '1',
      contentHash: 'a'.repeat(64), projectionVersion: 1,
      workflowPayloadSnapshot: {}, summaryInstruction: 'Summarize matches.',
    });
    const runRepo = runRepoWith([slot, null]);
    const synthesize = vi.fn().mockResolvedValue({
      text: 'One finance update [a].',
      metadata: {
        state: 'generated', provider: 'embedded', model: 'managed', reasoningMode: 'on_device',
        runtimeVersion: 'unreported',
        summaryInstructionSha256: 'c'.repeat(64),
      },
    });
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: signalRepoWith([[
        signal({ id: 'a', timestamp: new Date('2026-07-05T08:00:00Z') }),
      ]]),
      synthesize,
    });
    expect(synthesize).toHaveBeenCalledWith(
      slot,
      [expect.objectContaining({ signalId: 'a' })],
      1,
    );
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      summary: 'One finance update [a].',
      synthesisMetadata: expect.objectContaining({ state: 'generated', provider: 'embedded' }),
    }));
  });

  it('records an explicit adaptive explanation when a pinned run has no matches', async () => {
    const slot = claimedSlot({
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      workflowProviderKey: 'signal_digest.v1',
      workflowProviderSchemaVersion: '1',
      contentHash: 'a'.repeat(64),
      projectionVersion: 1,
      workflowPayloadSnapshot: {},
      summaryInstruction: 'Summarize matches.',
    });
    const runRepo = runRepoWith([slot, null]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: signalRepoWith([[]]),
      synthesize: vi.fn().mockResolvedValue({
        text: null,
        metadata: {
          state: 'unavailable', reason: 'no_matches',
          summaryInstructionSha256: 'd'.repeat(64),
        },
      }),
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      id: slot.id,
      matchedCount: 0,
      summary: 'AI summary unavailable — No matching signals.',
      matchedRefs: [],
    }));
  });

  it('falls back deterministically instead of retrying the slot when synthesis throws', async () => {
    const slot = claimedSlot({
      workflowId: 'workflow-1', workflowVersionId: 'version-1',
      workflowProviderKey: 'signal_digest.v1', workflowProviderSchemaVersion: '1',
      contentHash: 'a'.repeat(64), projectionVersion: 1,
      workflowPayloadSnapshot: {}, summaryInstruction: 'Summarize matches.',
    });
    const runRepo = runRepoWith([slot, null]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: signalRepoWith([[
        signal({ id: 'a', timestamp: new Date('2026-07-05T08:00:00Z') }),
      ]]),
      synthesize: vi.fn().mockRejectedValue(new Error('model offline')),
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.stringMatching(/^AI summary unavailable —/),
      synthesisMetadata: expect.objectContaining({ state: 'unavailable', reason: 'provider_failed' }),
    }));
    expect(runRepo.failSlot).not.toHaveBeenCalled();
  });

  it('completes zero-match slots so the persisted schedule has no gaps', async () => {
    const slot = claimedSlot();
    const runRepo = runRepoWith([slot, null]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: signalRepoWith([[]]),
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({
      id: slot.id,
      matchedCount: 0,
      summary: '',
      matchedRefs: [],
    }));
  });

  it('does not retry or fail a completion after losing its lease', async () => {
    const runRepo = runRepoWith([claimedSlot(), null]);
    runRepo.completeSlot.mockResolvedValue(false);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo: signalRepoWith([[signal()]]),
    });
    expect(runRepo.completeSlot).toHaveBeenCalledTimes(1);
    expect(runRepo.failSlot).not.toHaveBeenCalled();
  });

  it('uses the immutable slot window rather than recalculating a lookback', async () => {
    const slot = claimedSlot({
      windowStart: new Date('2026-07-05T08:15:00Z'),
      windowEnd: new Date('2026-07-05T08:45:00Z'),
    });
    const runRepo = runRepoWith([slot, null]);
    const signalRepo = signalRepoWith([[]]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo,
    });
    expect(signalRepo.visitInWindowPages).toHaveBeenCalledWith(
      slot.userId,
      slot.windowStart,
      slot.windowEnd,
      500,
      expect.any(Function),
    );
  });

  it('records a failed attempt and continues to the next durable slot', async () => {
    const bad = claimedSlot({ id: 'bad-slot', leaseToken: 'bad-lease' });
    const good = claimedSlot({ id: 'good-slot', leaseToken: 'good-lease' });
    const runRepo = runRepoWith([bad, good, null]);
    const signalRepo = signalRepoWith([
      new Error('signal read failed'),
      [signal({ id: 'a' })],
    ]);
    await runWatchSchedulerJob({
      runRepo,
      signalRepo,
    });
    expect(runRepo.failSlot).toHaveBeenCalledWith({
      id: bad.id,
      leaseToken: bad.leaseToken,
      retryDelayMs: WATCH_SCHEDULER_INTERVAL_MS,
      error: 'signal read failed',
    });
    expect(runRepo.completeSlot).toHaveBeenCalledWith(expect.objectContaining({ id: good.id }));
  });
});
