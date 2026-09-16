import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
vi.mock("../connection.js", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
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
  });

  it("gates an active spec edit in the UPDATE without a read/check/write gap", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await watchRepository.updateSpec("watch", "user", { ...SPEC, filter: {} });
    const [sql, args] = mockQuery.mock.calls[0]!;
    expect(sql).toContain("status <> 'active' OR $10 = true");
    expect(args[9]).toBe(false);
    expect(JSON.parse(args[6])).toEqual({
      sources: [],
      fromContains: [],
      keywords: [],
      domains: [],
    });
  });
});
