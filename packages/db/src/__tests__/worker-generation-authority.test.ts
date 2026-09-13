import { createHash } from "node:crypto";
import type { QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  registerWorkerGenerationAuthority,
  revokeWorkerGenerationAuthority,
  type WorkerGenerationAuthorityClient,
} from "../worker-generation-authority.js";

const GENERATION_ID = "93c89fcc-2fa4-49a4-8510-171193973983";
const GENERATION_SECRET = "a".repeat(64);

function fakeClient(
  responseFor: (sql: string) => {
    rowCount: number;
    rows: Array<Record<string, unknown>>;
  } = () => ({ rowCount: 0, rows: [] }),
): WorkerGenerationAuthorityClient & {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const resultFor = (sql: string): QueryResult => ({
    command: "",
    oid: 0,
    fields: [],
    ...responseFor(sql),
  });
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (sql: string) => resultFor(sql)),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("worker generation database authority", () => {
  it("registers the hashed capability in one authorized transaction", async () => {
    const client = fakeClient();
    await registerWorkerGenerationAuthority({
      connectionString: "postgresql://owned/skytwin",
      generationId: GENERATION_ID,
      generationSecret: GENERATION_SECRET,
      authorize: () => true,
      createClient: () => client,
    });

    expect(
      client.query.mock.calls.map(
        ([sql]) => String(sql).trim().split(/\s+/)[0],
      ),
    ).toEqual(["BEGIN", "UPDATE", "INSERT", "COMMIT"]);
    const insert = client.query.mock.calls[2];
    expect(insert?.[1]).toEqual([
      GENERATION_ID,
      createHash("sha256").update(GENERATION_SECRET).digest("hex"),
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rolls back before registration writes when authority is already revoked", async () => {
    const client = fakeClient();
    await expect(
      registerWorkerGenerationAuthority({
        connectionString: "postgresql://owned/skytwin",
        generationId: GENERATION_ID,
        generationSecret: GENERATION_SECRET,
        authorize: () => false,
        createClient: () => client,
      }),
    ).rejects.toThrow(/authority changed/);

    expect(client.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      "ROLLBACK",
    ]);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rolls back if authority changes between registration statements", async () => {
    const client = fakeClient();
    const authorize = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(
      registerWorkerGenerationAuthority({
        connectionString: "postgresql://owned/skytwin",
        generationId: GENERATION_ID,
        generationSecret: GENERATION_SECRET,
        authorize,
        createClient: () => client,
      }),
    ).rejects.toThrow(/authority changed/);

    expect(
      client.query.mock.calls.map(
        ([sql]) => String(sql).trim().split(/\s+/)[0],
      ),
    ).toEqual(["BEGIN", "UPDATE", "ROLLBACK"]);
  });

  it("revokes the exact generation and accepts an already-revoked retry", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("UPDATE worker_generation_authority"))
        return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT secret_hash"))
        return {
          rowCount: 1,
          rows: [
            {
              secret_hash: createHash("sha256")
                .update(GENERATION_SECRET)
                .digest("hex"),
              active: false,
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    });

    await revokeWorkerGenerationAuthority({
      connectionString: "postgresql://owned/skytwin",
      generationId: GENERATION_ID,
      generationSecret: GENERATION_SECRET,
      authorize: () => true,
      createClient: () => client,
    });

    expect(client.query.mock.calls[1]?.[1]).toEqual([
      GENERATION_ID,
      createHash("sha256").update(GENERATION_SECRET).digest("hex"),
    ]);
    expect(
      client.query.mock.calls.map(
        ([sql]) => String(sql).trim().split(/\s+/)[0],
      ),
    ).toEqual(["BEGIN", "UPDATE", "SELECT", "COMMIT"]);
  });

  it("accepts cleanup when an ambiguous registration never created a row", async () => {
    const client = fakeClient();

    await revokeWorkerGenerationAuthority({
      connectionString: "postgresql://owned/skytwin",
      generationId: GENERATION_ID,
      generationSecret: GENERATION_SECRET,
      authorize: () => true,
      createClient: () => client,
    });

    expect(
      client.query.mock.calls.map(
        ([sql]) => String(sql).trim().split(/\s+/)[0],
      ),
    ).toEqual(["BEGIN", "UPDATE", "SELECT", "COMMIT"]);
  });

  it.each([
    {
      label: "same ID with a different secret",
      row: { secret_hash: "f".repeat(64), active: false },
    },
    {
      label: "same ID and secret that remains active",
      row: {
        secret_hash: createHash("sha256")
          .update(GENERATION_SECRET)
          .digest("hex"),
        active: true,
      },
    },
  ])("rejects $label during revocation reconciliation", async ({ row }) => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT secret_hash")) {
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(
      revokeWorkerGenerationAuthority({
        connectionString: "postgresql://owned/skytwin",
        generationId: GENERATION_ID,
        generationSecret: GENERATION_SECRET,
        authorize: () => true,
        createClient: () => client,
      }),
    ).rejects.toThrow(/could not be revoked exactly/);

    expect(
      client.query.mock.calls.map(
        ([sql]) => String(sql).trim().split(/\s+/)[0],
      ),
    ).toEqual(["BEGIN", "UPDATE", "SELECT", "ROLLBACK"]);
  });
});
