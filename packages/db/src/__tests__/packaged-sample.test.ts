import { describe, expect, it, vi } from 'vitest';
import {
  assertPackagedSampleSafe,
  ingestPackagedSampleSignals,
  provisionPackagedSampleWithClient,
} from '../seeds/packaged-sample.js';
import { DEMO_USER_ID } from '../seeds/demo-guard.js';
import { DEMO_SIGNALS } from '../seeds/demo-fixtures/signals.js';

describe('packaged sample safety', () => {
  const safe = {
    packaged: true,
    desktopMode: 'true',
    nodeEnv: 'production',
    databaseUrl: 'postgresql://root@127.0.0.1:26257/skytwin',
  } as const;

  it('allows only the packaged production desktop against loopback', () => {
    expect(assertPackagedSampleSafe(safe)).toEqual({ ok: true });
    expect(assertPackagedSampleSafe({ ...safe, packaged: false }).ok).toBe(
      false,
    );
    expect(assertPackagedSampleSafe({ ...safe, desktopMode: 'false' }).ok).toBe(
      false,
    );
    expect(
      assertPackagedSampleSafe({ ...safe, nodeEnv: 'development' }).ok,
    ).toBe(false);
    expect(
      assertPackagedSampleSafe({
        ...safe,
        databaseUrl: 'postgresql://db.example.com/skytwin',
      }).ok,
    ).toBe(false);
  });

  it('creates only the reserved sample user and its profile', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: DEMO_USER_ID }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(
      provisionPackagedSampleWithClient({ query } as never),
    ).resolves.toEqual({
      created: true,
      userId: DEMO_USER_ID,
    });
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(DEMO_USER_ID);
    expect(query.mock.calls[1]?.[1]).toEqual([DEMO_USER_ID]);
  });

  it('is idempotent for an existing sample identity', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ is_demo: true }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(
      provisionPackagedSampleWithClient({ query } as never),
    ).resolves.toEqual({
      created: false,
      userId: DEMO_USER_ID,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[1]).toEqual([DEMO_USER_ID]);
  });

  it('fails closed when a non-sample account occupies the reserved UUID', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ is_demo: false }] });

    await expect(
      provisionPackagedSampleWithClient({ query } as never),
    ).rejects.toThrow(/non-sample account/);
  });

  it('authenticates every synthetic event and restricts ingestion to the reserved identity', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const result = await ingestPackagedSampleSignals({
      apiUrl: 'http://127.0.0.1:3100',
      serviceToken: 'local-secret',
      fetchImpl,
    });

    expect(result).toEqual({
      ingested: DEMO_SIGNALS.length,
      total: DEMO_SIGNALS.length,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(DEMO_SIGNALS.length);
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(
        (init.headers as Record<string, string>)['x-skytwin-service-token'],
      ).toBe('local-secret');
      const body = JSON.parse(String(init.body));
      expect(body.userId).toBe(DEMO_USER_ID);
      expect(body.signalId).toMatch(
        /^51a7e000-0001-4000-8000-\d{12}$/,
      );
      expect(body.data.sampleFixtureVersion).toBe(1);
      expect(body.signalId.split('-')[1]).toBe(
        body.data.sampleFixtureVersion.toString(16).padStart(4, '0'),
      );
    }

    const firstRunIds = fetchImpl.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)).signalId,
    );
    fetchImpl.mockClear();
    await ingestPackagedSampleSignals({
      apiUrl: 'http://127.0.0.1:3100',
      serviceToken: 'local-secret',
      fetchImpl,
    });
    const retryIds = fetchImpl.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)).signalId,
    );
    expect(retryIds).toEqual(firstRunIds);

    await expect(
      ingestPackagedSampleSignals({
        apiUrl: 'http://127.0.0.1:3100',
        serviceToken: 'local-secret',
        userId: '00000000-0000-4000-8000-000000000000',
        fetchImpl,
      }),
    ).rejects.toThrow(/reserved identity/);

    await expect(
      ingestPackagedSampleSignals({
        apiUrl: 'https://api.example.com',
        serviceToken: 'local-secret',
        fetchImpl,
      }),
    ).rejects.toThrow(/loopback API URL/);
    await expect(
      ingestPackagedSampleSignals({
        apiUrl: 'http://localhost.evil.example',
        serviceToken: 'local-secret',
        fetchImpl,
      }),
    ).rejects.toThrow(/loopback API URL/);
  });
});
