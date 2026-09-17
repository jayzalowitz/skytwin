import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalDigestV1ContentHash } from "@skytwin/routines";

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();

vi.mock("../connection.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (
    fn: (client: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => fn({ query: mockClientQuery }),
}));

const { watchRunRepository, watchRunEvidenceSha256 } =
  await import("../repositories/watch-run-repository.js");
const { signalRepository } =
  await import("../repositories/signal-repository.js");

const DB_NOW = new Date("2026-09-11T12:00:00Z");
const SCHEDULED_FOR = new Date("2026-09-11T11:55:00Z");
const WINDOW_START = new Date("2026-09-11T10:00:00Z");
const NEXT_RUN = new Date("2026-09-12T08:00:00Z");
const WORKFLOW_ID = "60000000-0000-4000-8000-000000000001";
const WORKFLOW_VERSION_ID = "70000000-0000-4000-8000-000000000001";
const WORKFLOW_PROVIDER_KEY = "signal_digest.v1";
const WORKFLOW_PROVIDER_SCHEMA_VERSION = "1";
const WORKFLOW_PAYLOAD = {
  name: "Finance mail",
  cadence: "daily" as const,
  hourOfDay: 8,
  timezone: "UTC",
  filter: {
    sources: ["gmail"], fromContains: [], keywords: ["invoice"], domains: [],
  },
  action: "digest" as const,
  summaryInstruction: "Summarize finance mail with citations.",
};
const CONTENT_HASH = signalDigestV1ContentHash(WORKFLOW_PAYLOAD);
const PROJECTION_VERSION = 1;

function dueWatch() {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    user_id: "20000000-0000-4000-8000-000000000001",
    name: "Finance mail",
    source_text: "watch finance mail",
    cadence: "daily",
    hour_of_day: 8,
    day_of_week: null,
    filter: {
      sources: ["gmail"],
      fromContains: [],
      keywords: ["invoice"],
      domains: [],
    },
    action: "digest",
    status: "active",
    created_at: WINDOW_START,
    updated_at: WINDOW_START,
    last_run_at: null,
    next_run_at: SCHEDULED_FOR,
    schedule_revision: "30000000-0000-4000-8000-000000000001",
    workflow_id: WORKFLOW_ID,
    workflow_version_id: WORKFLOW_VERSION_ID,
    workflow_provider_key: WORKFLOW_PROVIDER_KEY,
    workflow_provider_schema_version: WORKFLOW_PROVIDER_SCHEMA_VERSION,
    content_hash: CONTENT_HASH,
    projection_version: PROJECTION_VERSION,
    timezone: "America/Los_Angeles",
    workflow_canonical_payload: WORKFLOW_PAYLOAD,
    workflow_inference_metadata: null,
  };
}

function slotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "40000000-0000-4000-8000-000000000001",
    watch_id: dueWatch().id,
    user_id: dueWatch().user_id,
    ran_at: DB_NOW,
    action: "digest",
    matched_count: 0,
    summary: "",
    matched_refs: [],
    evidence_sha256: null,
    evidence_snapshot: [],
    schedule_revision: dueWatch().schedule_revision,
    scheduled_for: SCHEDULED_FOR,
    window_start: WINDOW_START,
    window_end: DB_NOW,
    watch_spec: {
      name: "Finance mail",
      cadence: "daily",
      hourOfDay: 8,
      filter: {
        sources: ["gmail"],
        fromContains: [],
        keywords: ["invoice"],
        domains: [],
      },
      action: "digest",
    },
    workflow_payload_snapshot: WORKFLOW_PAYLOAD,
    workflow_inference_snapshot: null,
    synthesis_metadata: null,
    slot_status: "processing",
    lease_token: "50000000-0000-4000-8000-000000000001",
    lease_expires_at: new Date("2026-09-11T12:05:00Z"),
    attempt_count: 1,
    completed_at: null,
    failed_at: null,
    last_error: null,
    workflow_id: WORKFLOW_ID,
    workflow_version_id: WORKFLOW_VERSION_ID,
    workflow_provider_key: WORKFLOW_PROVIDER_KEY,
    workflow_provider_schema_version: WORKFLOW_PROVIDER_SCHEMA_VERSION,
    content_hash: CONTENT_HASH,
    projection_version: PROJECTION_VERSION,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("watchRunRepository durable slots", () => {
  it("inserts a persisted slot and advances its Watch in one transaction", async () => {
    const inserted = slotRow({ attempt_count: "1", projection_version: "1" });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] }) // cancel inactive expired slots
      .mockResolvedValueOnce({ rows: [] }) // terminally fail exhausted leases
      .mockResolvedValueOnce({ rows: [] }) // no retry slot
      .mockResolvedValueOnce({ rows: [{
        ...dueWatch(),
        hour_of_day: "8",
        projection_version: "1",
      }] })
      .mockResolvedValueOnce({ rows: [inserted] })
      .mockResolvedValueOnce({ rows: [{ id: dueWatch().id }] });
    const calculateNextRun = vi.fn().mockReturnValue(NEXT_RUN);

    const claimed = await watchRunRepository.claimNextDueSlot({
      calculateNextRun,
      leaseMs: 60_000,
    });

    expect(claimed).toMatchObject({
      id: inserted.id,
      windowStart: WINDOW_START,
      windowEnd: DB_NOW,
      scheduledFor: SCHEDULED_FOR,
      attemptCount: 1,
      workflowId: WORKFLOW_ID,
      workflowVersionId: WORKFLOW_VERSION_ID,
      workflowProviderKey: WORKFLOW_PROVIDER_KEY,
      workflowProviderSchemaVersion: WORKFLOW_PROVIDER_SCHEMA_VERSION,
      contentHash: CONTENT_HASH,
      projectionVersion: PROJECTION_VERSION,
    });
    expect(calculateNextRun).toHaveBeenCalledWith(
      expect.objectContaining({ cadence: "daily", action: "digest", hourOfDay: 8 }),
      DB_NOW,
      "UTC",
    );
    const insertCall = mockClientQuery.mock.calls[5]!;
    expect(insertCall[0]).toContain("INSERT INTO watch_runs");
    expect(insertCall[1]).toEqual(
      expect.arrayContaining([SCHEDULED_FOR, WINDOW_START, DB_NOW]),
    );
    expect(insertCall[1]).toEqual(
      expect.arrayContaining([
        WORKFLOW_ID,
        WORKFLOW_VERSION_ID,
        WORKFLOW_PROVIDER_KEY,
        WORKFLOW_PROVIDER_SCHEMA_VERSION,
        CONTENT_HASH,
        PROJECTION_VERSION,
      ]),
    );
    expect(mockClientQuery.mock.calls[4]![0]).toContain(
      "wf.active_version_id = w.workflow_version_id",
    );
    expect(mockClientQuery.mock.calls[6]![0]).toContain(
      "schedule_revision = $5",
    );
  });

  it("reclaims the same persisted window/spec with a fresh lease token", async () => {
    const expired = slotRow({
      lease_token: "old-lease",
      lease_expires_at: new Date("2026-09-11T11:00:00Z"),
    });
    const reclaimed = slotRow({ lease_token: "new-lease", attempt_count: 2 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [expired] })
      .mockResolvedValueOnce({ rows: [reclaimed] });

    const result = await watchRunRepository.claimNextDueSlot({
      calculateNextRun: vi.fn(),
    });

    expect(result).toMatchObject({
      id: expired.id,
      leaseToken: "new-lease",
      windowStart: WINDOW_START,
      windowEnd: DB_NOW,
      attemptCount: 2,
      workflowId: WORKFLOW_ID,
      workflowVersionId: WORKFLOW_VERSION_ID,
      workflowProviderKey: WORKFLOW_PROVIDER_KEY,
      workflowProviderSchemaVersion: WORKFLOW_PROVIDER_SCHEMA_VERSION,
      contentHash: CONTENT_HASH,
      projectionVersion: PROJECTION_VERSION,
    });
    expect(mockClientQuery.mock.calls[3]![0]).toContain(
      "lease_expires_at <= now()",
    );
    expect(mockClientQuery.mock.calls[4]![0]).toContain(
      "slot_status = 'processing'",
    );
  });

  it("terminally quarantines a corrupt persisted snapshot and continues to another Watch", async () => {
    const corrupt = slotRow({
      watch_spec: { cadence: "daily", filter: { keywords: [null] } },
    });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [corrupt] })
      .mockResolvedValueOnce({ rows: [{ id: corrupt.id }] }) // quarantine corrupt slot
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dueWatch()] })
      .mockResolvedValueOnce({ rows: [slotRow()] })
      .mockResolvedValueOnce({ rows: [{ id: dueWatch().id }] });

    await expect(
      watchRunRepository.claimNextDueSlot({
        calculateNextRun: vi.fn().mockReturnValue(NEXT_RUN),
      }),
    ).resolves.toMatchObject({ id: slotRow().id });
    expect(mockClientQuery.mock.calls[4]![0]).toContain(
      "slot_status = 'failed'",
    );
    expect(mockClientQuery.mock.calls[9]![0]).toContain("FROM watches AS w");
  });

  it("quarantines an unschedulable Watch without starving the next due Watch", async () => {
    const bad = {
      ...dueWatch(),
      id: "bad-watch",
      timezone: "invalid/timezone",
      workflow_id: null,
      workflow_version_id: null,
      workflow_provider_key: null,
      workflow_provider_schema_version: null,
      content_hash: null,
      projection_version: null,
      workflow_canonical_payload: null,
      workflow_inference_metadata: null,
    };
    const good = {
      ...bad,
      id: "good-watch",
      timezone: "UTC",
      schedule_revision: "good-revision",
    };
    const goodSlot = slotRow({
      watch_id: good.id,
      schedule_revision: good.schedule_revision,
      workflow_id: null,
      workflow_version_id: null,
      workflow_provider_key: null,
      workflow_provider_schema_version: null,
      content_hash: null,
      projection_version: null,
      workflow_payload_snapshot: null,
      workflow_inference_snapshot: null,
    });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [bad] })
      .mockResolvedValueOnce({ rows: [] }) // failed slot telemetry
      .mockResolvedValueOnce({ rows: [{ id: bad.id }] }) // pause bad Watch
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [good] })
      .mockResolvedValueOnce({ rows: [goodSlot] })
      .mockResolvedValueOnce({ rows: [{ id: good.id }] });
    const calculateNextRun = vi.fn(
      (_spec: unknown, _from: Date, timezone: string) => {
        if (timezone === "invalid/timezone")
          throw new Error("invalid timezone");
        return NEXT_RUN;
      },
    );

    await expect(
      watchRunRepository.claimNextDueSlot({ calculateNextRun }),
    ).resolves.toMatchObject({ watchId: good.id });
    expect(mockClientQuery.mock.calls[5]![0]).toContain("'failed'");
    expect(mockClientQuery.mock.calls[6]![0]).toContain("status = 'paused'");
    expect(calculateNextRun).toHaveBeenCalledTimes(2);
  });

  it("retries the complete claim/schedule transaction on Cockroach serialization failure", async () => {
    mockClientQuery
      .mockRejectedValueOnce(
        Object.assign(new Error("retry"), { code: "40001" }),
      )
      .mockResolvedValueOnce({ rows: [{ db_now: DB_NOW }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      watchRunRepository.claimNextDueSlot({
        calculateNextRun: vi.fn(),
      }),
    ).resolves.toBeNull();
    expect(mockClientQuery).toHaveBeenCalledTimes(6);
  });

  it("rejects an invalid lease duration", async () => {
    await expect(
      watchRunRepository.claimNextDueSlot({
        calculateNextRun: vi.fn(),
        leaseMs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(/finite/);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("fences completion by token and an unexpired DB-time lease, bounding output", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "slot" }] });
    const refs = Array.from({ length: 250 }, (_, i) => `signal-${i}`);
    const evidenceSnapshot = refs.slice(0, 200).map((signalId) => ({
      signalId, source: "gmail", timestamp: DB_NOW.toISOString(), title: "Invoice", from: "",
      matchTextSha256: "c".repeat(64),
    }));
    await expect(
      watchRunRepository.completeSlot({
        id: "slot",
        leaseToken: "lease",
        matchedCount: 250.9,
        summary: "x".repeat(5_000),
        matchedRefs: refs,
        evidenceSnapshot,
        synthesisMetadata: null,
      }),
    ).resolves.toBe(true);
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("lease_expires_at > now()");
    expect(args[2]).toBe(250);
    expect(args[3]).toHaveLength(4_000);
    expect(JSON.parse(args[4])).toHaveLength(200);
    expect(args[5]).toBe(watchRunEvidenceSha256(250, evidenceSnapshot));
    expect(JSON.parse(args[6])).toHaveLength(200);
  });

  it("releases a failed attempt as pending without retaining its fence token", async () => {
    mockQuery.mockResolvedValue({ rows: [{ slot_status: "pending" }] });
    await expect(
      watchRunRepository.failSlot({
        id: "slot",
        leaseToken: "stale-token",
        retryDelayMs: 60_000,
        error: "temporary",
      }),
    ).resolves.toBe("retry_scheduled");
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("ELSE 'pending'");
    expect(sql).toContain("lease_token = NULL");
    expect(sql).toContain("lease_expires_at > now()");
  });

  it("rejects retry delays that cannot fit the bounded scheduler contract", async () => {
    await expect(
      watchRunRepository.failSlot({
        id: "slot",
        leaseToken: "lease",
        retryDelayMs: 24 * 60 * 60 * 1000 + 1,
        error: "temporary",
      }),
    ).rejects.toThrow(/between one second and one day/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("reports a stale completion token as losing the lease", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(
      watchRunRepository.completeSlot({
        id: "slot",
        leaseToken: "stale-token",
        matchedCount: 1,
        summary: "stale",
        matchedRefs: ["signal"],
        evidenceSnapshot: [{
          signalId: "signal", source: "gmail", timestamp: DB_NOW.toISOString(), title: "Invoice", from: "",
          matchTextSha256: "d".repeat(64),
        }],
        synthesisMetadata: null,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a completed row whose commitment does not bind its canonical evidence", async () => {
    mockQuery.mockResolvedValue({ rows: [slotRow({
      slot_status: "completed",
      matched_count: "1",
      matched_refs: ["signal"],
      evidence_sha256: "a".repeat(64),
      evidence_snapshot: [{
        signalId: "signal", source: "gmail", timestamp: DB_NOW.toISOString(), title: "Invoice", from: "",
        matchTextSha256: "d".repeat(64),
      }],
    })] });

    await expect(watchRunRepository.listForWatch("watch", "owner", 1))
      .rejects.toThrow(/commitment does not match/);
  });

  it("prunes only bounded, expired, completed zero-match slots", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "one" }, { id: "two" }] });
    await expect(watchRunRepository.pruneZeroMatchSlots(30, 100)).resolves.toBe(
      2,
    );
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("slot_status = 'completed'");
    expect(sql).toContain("matched_count = 0");
    expect(sql).toContain("INTERVAL '1 day'");
    expect(args).toEqual([30, 100]);
  });

  it("derives ownership through both Watch keys and hides non-positive/incomplete slots", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await watchRunRepository.listForWatch("watch", "owner", 20);
    await watchRunRepository.listRecentForUser("owner", DB_NOW, 6);
    for (const [sql] of mockQuery.mock.calls) {
      expect(sql).toContain("w.id = wr.watch_id AND w.user_id = wr.user_id");
      expect(sql).toContain("wr.slot_status = 'completed'");
      expect(sql).toContain("wr.matched_count > 0");
    }
  });
});

describe("signalRepository.listInWindow", () => {
  it("uses exact owner-scoped half-open persisted boundaries", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await signalRepository.listInWindow("owner", WINDOW_START, DB_NOW);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("timestamp > $2 AND timestamp <= $3"),
      ["owner", WINDOW_START, DB_NOW],
    );
  });

  it("visits a stable window in bounded deterministic keyset pages", async () => {
    const first = [
      {
        ...slotRow(), id: "10000000-0000-4000-8000-000000000001", timestamp: DB_NOW,
        page_cursor_timestamp: "2026-09-11 12:00:00+00:00",
      },
      {
        ...slotRow(), id: "10000000-0000-4000-8000-000000000002", timestamp: WINDOW_START,
        page_cursor_timestamp: "2026-09-11 10:00:00.123456+00:00",
      },
    ];
    const second = [
      {
        ...slotRow(), id: "10000000-0000-4000-8000-000000000003", timestamp: WINDOW_START,
        page_cursor_timestamp: "2026-09-11 10:00:00.000001+00:00",
      },
    ];
    mockClientQuery
      .mockResolvedValueOnce({ rows: first })
      .mockResolvedValueOnce({ rows: second });
    const visited: string[][] = [];

    await signalRepository.visitInWindowPages(
      "owner",
      WINDOW_START,
      DB_NOW,
      2,
      (records) => { visited.push(records.map((record) => record.id)); },
    );

    expect(visited).toEqual([
      first.map((row) => row.id),
      second.map((row) => row.id),
    ]);
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls[0]![0]).toContain("ORDER BY timestamp DESC, id ASC");
    expect(mockClientQuery.mock.calls[0]![1]).toEqual([
      "owner", WINDOW_START, DB_NOW, null, null, 2,
    ]);
    expect(mockClientQuery.mock.calls[1]![1]).toEqual([
      "owner", WINDOW_START, DB_NOW, first[1]!.page_cursor_timestamp, first[1]!.id, 2,
    ]);
  });

  it("bounds replay rows in SQL while reporting the full window count", async () => {
    mockQuery.mockResolvedValue({ rows: [{
      id: "signal-1",
      user_id: "owner",
      total_count: "2400",
    }] });
    const result = await signalRepository.listInWindowBounded(
      "owner",
      WINDOW_START,
      DB_NOW,
      2000,
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("count(*) OVER () AS total_count"),
      ["owner", WINDOW_START, DB_NOW, 2000],
    );
    expect(mockQuery.mock.calls[0]![0]).toContain("LIMIT $4");
    expect(result).toMatchObject({ totalCount: 2400, truncated: true });
    expect(result.records[0]).not.toHaveProperty("total_count");
  });
});
