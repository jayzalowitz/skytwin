import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQuery, mockTransactionQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockTransactionQuery: vi.fn(),
}));
vi.mock("../connection.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) =>
    fn({ query: mockTransactionQuery }),
}));

const { watchRepository } = await import("../repositories/watch-repository.js");

const SPEC = {
  name: "Finance mail",
  cadence: "daily" as const,
  action: "digest" as const,
  filter: { keywords: ["invoice"] },
};

beforeEach(() => vi.clearAllMocks());

describe("watchRepository atomic active-filter guards", () => {
  it("stores every known filter key as an array for the database invariant", async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: "watch",
          user_id: "user",
          name: SPEC.name,
          source_text: SPEC.name,
          cadence: "daily",
          hour_of_day: null,
          day_of_week: null,
          filter: {
            sources: [],
            fromContains: [],
            keywords: ["invoice"],
            domains: [],
          },
          action: "digest",
          status: "active",
          created_at: new Date(),
          updated_at: new Date(),
          last_run_at: null,
          next_run_at: new Date(),
          schedule_revision: "revision",
          workflow_id: null,
          workflow_version_id: null,
          workflow_provider_key: null,
          workflow_provider_schema_version: null,
          content_hash: null,
          projection_version: null,
        },
      ],
    });
    await watchRepository.create({
      userId: "user",
      sourceText: SPEC.name,
      spec: SPEC,
    });
    const stored = JSON.parse(mockQuery.mock.calls[0]![1][6]);
    expect(stored).toEqual({
      sources: [],
      fromContains: [],
      keywords: ["invoice"],
      domains: [],
    });
  });

  it("checks normalized recognized entries in the activation UPDATE itself", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await watchRepository.setStatus("watch", "user", "active", new Date());
    const [sql] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("jsonb_array_length(filter->'sources') > 0");
    expect(sql).toContain("jsonb_array_length(filter->'fromContains') > 0");
    expect(sql).toContain("jsonb_array_length(filter->'keywords') > 0");
    expect(sql).toContain("jsonb_array_length(filter->'domains') > 0");
    expect(sql).not.toContain("jsonb_path_exists");
    expect(sql).toContain('workflows.active_version_id = watches.workflow_version_id');
  });

  it("gates an active spec edit in the UPDATE without a read/check/write gap", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await watchRepository.updateSpec("watch", "user", { ...SPEC, filter: {} });
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status <> 'active' OR $10 = true");
    expect(sql).toContain("workflow_id IS NULL");
    expect(args[9]).toBe(false);
    expect(JSON.parse(args[6])).toEqual({
      sources: [],
      fromContains: [],
      keywords: [],
      domains: [],
    });
  });

  it("does not let the legacy delete path orphan an active versioned workflow", async () => {
    mockTransactionQuery.mockResolvedValueOnce({
      rows: [{
        id: "watch",
        workflow_id: "workflow",
        workflow_provider_key: "signal_digest.v1",
      }],
    });

    expect(await watchRepository.delete("watch", "user")).toBe(false);

    expect(mockTransactionQuery).toHaveBeenCalledTimes(1);
    expect(mockTransactionQuery.mock.calls[0]![0]).toContain("FOR UPDATE");
  });

  it("deletes an unversioned legacy Watch without touching workflows", async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({
        rows: [{ id: "watch", workflow_id: null, workflow_provider_key: null }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "watch" }] });

    expect(await watchRepository.delete("watch", "user")).toBe(true);

    expect(mockTransactionQuery).toHaveBeenCalledTimes(2);
    expect(mockTransactionQuery.mock.calls[1]![0]).toContain("DELETE FROM watches");
    expect(mockTransactionQuery.mock.calls[1]![0]).toContain("workflow_id IS NULL");
  });

  it("deletes only an inactive quarantined workflow and its cascading Watch", async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({
        rows: [{
          id: "watch",
          workflow_id: "workflow-quarantine",
          workflow_provider_key: "legacy_watch.quarantine.v1",
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: "workflow-quarantine" }] });

    expect(await watchRepository.delete("watch", "user")).toBe(true);

    const [sql, args] = mockTransactionQuery.mock.calls[1]!;
    expect(sql).toContain("DELETE FROM workflows");
    expect(sql).toContain("provider_key = $3");
    expect(sql).toContain("active_version_id IS NULL");
    expect(args).toEqual([
      "workflow-quarantine",
      "user",
      "legacy_watch.quarantine.v1",
    ]);
  });

  it("refuses quarantine deletion when the workflow has become active", async () => {
    mockTransactionQuery
      .mockResolvedValueOnce({
        rows: [{
          id: "watch",
          workflow_id: "workflow-quarantine",
          workflow_provider_key: "legacy_watch.quarantine.v1",
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    expect(await watchRepository.delete("watch", "user")).toBe(false);
    expect(mockTransactionQuery.mock.calls[1]![0]).toContain("active_version_id IS NULL");
  });
});
