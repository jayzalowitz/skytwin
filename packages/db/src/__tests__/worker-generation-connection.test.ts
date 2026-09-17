import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closePool,
  query,
  setWorkerGenerationAuthorityLossHandler,
  WorkerGenerationAuthorityError,
} from "../connection.js";

const previousId = process.env["SKYTWIN_WORKER_GENERATION_ID"];
const previousSecret = process.env["SKYTWIN_WORKER_GENERATION_SECRET"];

afterEach(async () => {
  setWorkerGenerationAuthorityLossHandler(null);
  if (previousId === undefined)
    delete process.env["SKYTWIN_WORKER_GENERATION_ID"];
  else process.env["SKYTWIN_WORKER_GENERATION_ID"] = previousId;
  if (previousSecret === undefined)
    delete process.env["SKYTWIN_WORKER_GENERATION_SECRET"];
  else process.env["SKYTWIN_WORKER_GENERATION_SECRET"] = previousSecret;
  await closePool();
});

describe("worker generation connection fence", () => {
  it("synchronously revokes process admission on malformed authority", async () => {
    process.env["SKYTWIN_WORKER_GENERATION_ID"] = "not-a-generation";
    process.env["SKYTWIN_WORKER_GENERATION_SECRET"] = "bad";
    const onLoss = vi.fn();
    setWorkerGenerationAuthorityLossHandler(onLoss);

    await expect(query("SELECT 1")).rejects.toBeInstanceOf(
      WorkerGenerationAuthorityError,
    );
    expect(onLoss).toHaveBeenCalledOnce();
    expect(onLoss.mock.calls[0]?.[0]).toBeInstanceOf(
      WorkerGenerationAuthorityError,
    );
  });
});
