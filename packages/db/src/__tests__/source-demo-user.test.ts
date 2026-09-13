import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_USER_ID } from "../seeds/demo-guard.js";
import { upsertSourceDemoUser } from "../seeds/source-demo-user.js";

const databaseState = vi.hoisted(() => ({
  id: null as string | null,
  isDemo: false,
}));

const mockQuery = vi.hoisted(() =>
  vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("INSERT INTO users")) {
      databaseState.id = String(params[0]);
      databaseState.isDemo = sql.includes("is_demo") && sql.includes("true");
      return { rowCount: 1, rows: [{ id: databaseState.id }] };
    }
    if (sql.includes("is_demo = true")) {
      const matches = params[0] === databaseState.id && databaseState.isDemo;
      return {
        rowCount: matches ? 1 : 0,
        rows: matches
          ? [
              {
                id: databaseState.id,
                email: "alex@example.com",
                name: "Alex Thompson",
                trust_tier: "low_autonomy",
                autonomy_settings: {},
                is_demo: true,
                created_at: new Date(0),
                updated_at: new Date(0),
              },
            ]
          : [],
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }),
);

vi.mock("../connection.js", () => ({
  query: (...args: [string, unknown[]]) => mockQuery(...args),
  withTransaction: vi.fn(),
}));

const { userRepository } = await import("../repositories/user-repository.js");

describe("source sample seed discovery contract", () => {
  beforeEach(() => {
    databaseState.id = null;
    databaseState.isDemo = false;
    mockQuery.mockClear();
  });

  it("makes pnpm db:seed identity discoverable only as the reserved demo", async () => {
    const userId = await upsertSourceDemoUser({ query: mockQuery } as never, {
      maxAutoSpend: 5000,
    });

    expect(userId).toBe(DEMO_USER_ID);
    await expect(userRepository.findDemoById(userId)).resolves.toMatchObject({
      id: DEMO_USER_ID,
      is_demo: true,
    });
    expect(mockQuery.mock.calls[0]?.[0]).toContain("is_demo = true");
  });

  it("refuses to relabel an unrelated account at the reserved identity", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(
      upsertSourceDemoUser({ query } as never, { maxAutoSpend: 5000 }),
    ).rejects.toThrow(/occupied by a non-sample account/);
    expect(query.mock.calls[0]?.[0]).toContain("WHERE users.is_demo = true");
    expect(query.mock.calls[0]?.[0]).toContain(
      "users.email = 'alex@example.com'",
    );
  });
});
