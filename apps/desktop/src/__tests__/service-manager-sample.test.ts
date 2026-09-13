import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/skytwin-sample-test",
    getAppPath: () => process.cwd(),
    isPackaged: true,
  },
}));

vi.mock("../cockroach-manager.js", () => ({
  CockroachManager: vi.fn(function CockroachManager() {
    return {
      getConnectionString: () =>
        "postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable",
      getDataDir: () => "/tmp/skytwin-sample-test/crdb-data",
    };
  }),
}));

const { ServiceManager } = await import("../service-manager.js");

interface SampleManagerInternals {
  cockroachStatus: string;
  sampleBootstrapAllowedThisLaunch: boolean;
  ensureEmbeddedRoot(): Promise<string>;
  waitForExternalApi(timeoutMs: number): Promise<boolean>;
  startCockroach(): Promise<{
    ownership: "managed-child" | "preexisting";
    dataDir: string | null;
  } | null>;
  runMigrations(): Promise<boolean>;
  provisionPackagedSample(startup: {
    ownership: "managed-child" | "preexisting";
    dataDir: string | null;
  }): Promise<void>;
  startApi(): Promise<void>;
  waitForApi(timeoutMs: number): Promise<boolean>;
  startWeb(): Promise<void>;
  startWorker(): Promise<void>;
  startHealthMonitoring(): void;
  startPackagedSampleIngest(): void;
  verifyOwnedApi(): Promise<boolean>;
  ingestPackagedSample(): Promise<void>;
}

function internals(): ServiceManager & SampleManagerInternals {
  return new ServiceManager() as ServiceManager & SampleManagerInternals;
}

describe("packaged sample startup sequencing", () => {
  const previousToken = process.env["SKYTWIN_SERVICE_TOKEN"];

  beforeEach(() => {
    delete process.env["DATABASE_URL"];
    process.env["SKYTWIN_SERVICE_TOKEN"] = "service-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousToken === undefined)
      delete process.env["SKYTWIN_SERVICE_TOKEN"];
    else process.env["SKYTWIN_SERVICE_TOKEN"] = previousToken;
  });

  it("does not await background sample ingestion before starting owner services", async () => {
    const manager = internals();
    manager.cockroachStatus = "running";
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    manager.startCockroach = vi.fn().mockResolvedValue({
      ownership: "managed-child",
      dataDir: "/tmp/skytwin-sample-test/crdb-data",
    });
    manager.runMigrations = vi.fn().mockResolvedValue(true);
    manager.provisionPackagedSample = vi.fn().mockImplementation(async () => {
      manager.sampleBootstrapAllowedThisLaunch = true;
    });
    manager.startApi = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();
    manager.startPackagedSampleIngest = vi.fn(
      () => new Promise<void>(() => undefined) as unknown as void,
    );

    await expect(manager.startAll()).resolves.toBeUndefined();
    expect(manager.startWeb).toHaveBeenCalledOnce();
    expect(manager.startWorker).toHaveBeenCalledOnce();
    expect(manager.startPackagedSampleIngest).toHaveBeenCalledOnce();
  });

  it("keeps a foreign pre-existing CockroachDB sample-free", async () => {
    const manager = internals();
    manager.cockroachStatus = "running";
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    manager.startCockroach = vi.fn().mockResolvedValue({
      ownership: "preexisting",
      dataDir: null,
    });
    manager.runMigrations = vi.fn().mockResolvedValue(true);
    manager.provisionPackagedSample = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    await expect(manager.startAll()).resolves.toBeUndefined();
    await Promise.resolve();

    expect(manager.runMigrations).toHaveBeenCalledOnce();
    expect(manager.provisionPackagedSample).not.toHaveBeenCalled();
    expect(manager.sampleBootstrapAllowedThisLaunch).toBe(false);
    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
    expect(manager.startApi).toHaveBeenCalledOnce();
    expect(manager.startWeb).toHaveBeenCalledOnce();
    expect(manager.startWorker).toHaveBeenCalledOnce();
  });

  it("does not present the service credential unless API ownership verifies", async () => {
    const manager = internals();
    manager.sampleBootstrapAllowedThisLaunch = true;
    manager.verifyOwnedApi = vi.fn().mockResolvedValue(false);
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest();
    await vi.waitFor(() =>
      expect(manager.verifyOwnedApi).toHaveBeenCalledOnce(),
    );

    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
  });

  it("starts ingestion only after API ownership verifies", async () => {
    const manager = internals();
    manager.sampleBootstrapAllowedThisLaunch = true;
    manager.verifyOwnedApi = vi.fn().mockResolvedValue(true);
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest();
    await vi.waitFor(() =>
      expect(manager.ingestPackagedSample).toHaveBeenCalledOnce(),
    );

    expect(manager.verifyOwnedApi).toHaveBeenCalledOnce();
    expect(
      (manager.verifyOwnedApi as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (manager.ingestPackagedSample as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("authenticates the concrete API listener by challenge-response", async () => {
    const manager = internals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const challenge = input.searchParams.get("challenge") ?? "";
        const proof = createHmac("sha256", "service-token")
          .update(`skytwin-api-instance-v1.${challenge}`)
          .digest("hex");
        return new Response(
          JSON.stringify({
            service: "skytwin-api",
            challenge,
            proof,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(manager.verifyOwnedApi()).resolves.toBe(true);
  });

  it("rejects a generic or forged listener before privileged ingest", async () => {
    const manager = internals();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            service: "skytwin-api",
            challenge: "attacker-controlled",
            proof: "0".repeat(64),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(manager.verifyOwnedApi()).resolves.toBe(false);
  });
});
