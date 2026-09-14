import express, { type Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemRouter } from "../routes/system.js";

const servers: Array<ReturnType<Express["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function request(
  path: string,
): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use("/api/system", createSystemRouter());
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing test port");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

describe("public local-model recommendation", () => {
  it("returns the recommendation without raw host hardware", async () => {
    const { status, body } = await request("/api/system/recommend-local-model");
    expect(status).toBe(200);
    const result = body as Record<string, unknown>;
    expect(result).toHaveProperty("model");
    expect(result).toEqual(
      expect.objectContaining({
        reason: expect.any(String),
        fitsDisk: expect.any(Boolean),
      }),
    );
    expect(result).not.toHaveProperty("hardware");
  });

  it("does not expose a public raw-hardware endpoint", async () => {
    const { status } = await request("/api/system/hardware");
    expect(status).toBe(404);
  });
});
