import { createHmac } from "node:crypto";
import type { ChildProcess } from "node:child_process";
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
      isManagedStartCurrent: vi.fn().mockReturnValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { ServiceManager } = await import("../service-manager.js");

interface SampleManagerInternals {
  cockroachStatus: string;
  sampleBootstrapAllowedThisLaunch: boolean;
  sampleLaunchEpoch: number;
  sampleAbortController: AbortController | null;
  api: { process: ChildProcess | null; external: boolean };
  cockroach: { isManagedStartCurrent: ReturnType<typeof vi.fn> };
  ensureEmbeddedRoot(): Promise<string>;
  waitForExternalApi(timeoutMs: number): Promise<boolean>;
  startCockroach(): Promise<{
    ownership: "managed-child" | "preexisting";
    dataDir: string | null;
  } | null>;
  runMigrations(startup: SampleStartup): Promise<boolean>;
  provisionPackagedSample(
    startup: {
      ownership: "managed-child" | "preexisting";
      dataDir: string | null;
    },
    epoch: number,
    signal: AbortSignal,
  ): Promise<void>;
  startApi(): Promise<void>;
  waitForApi(timeoutMs: number): Promise<boolean>;
  startWeb(): Promise<void>;
  startWorker(): Promise<void>;
  startHealthMonitoring(): void;
  startPackagedSampleIngest(
    startup: SampleStartup,
    epoch: number,
    signal: AbortSignal,
  ): void;
  verifyOwnedApi(
    process?: ChildProcess,
    epoch?: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  ingestPackagedSample(
    startup: SampleStartup,
    epoch: number,
    signal: AbortSignal,
    process: ChildProcess,
  ): Promise<void>;
  revokeSampleLaunch(): void;
  beginSampleLaunch(): { epoch: number; signal: AbortSignal };
  stopAll(): Promise<void>;
}

interface SampleStartup {
  ownership: "managed-child" | "preexisting";
  dataDir: string | null;
  generation: number | null;
}

function fakeProcess(): ChildProcess {
  return { exitCode: null } as ChildProcess;
}

function authorize(manager: ServiceManager & SampleManagerInternals): {
  startup: SampleStartup;
  controller: AbortController;
  process: ChildProcess;
} {
  const startup: SampleStartup = {
    ownership: "managed-child",
    dataDir: "/tmp/skytwin-sample-test/crdb-data",
    generation: 1,
  };
  const controller = new AbortController();
  const process = fakeProcess();
  manager.sampleLaunchEpoch = 1;
  manager.sampleAbortController = controller;
  manager.sampleBootstrapAllowedThisLaunch = true;
  manager.api.process = process;
  manager.api.external = false;
  manager.cockroach.isManagedStartCurrent.mockReturnValue(true);
  return { startup, controller, process };
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
      generation: 1,
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
    expect(manager.runMigrations).toHaveBeenCalledOnce();
    expect(manager.provisionPackagedSample).toHaveBeenCalledOnce();
    expect(
      (manager.runMigrations as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (manager.provisionPackagedSample as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
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
      generation: null,
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

    expect(manager.runMigrations).not.toHaveBeenCalled();
    expect(manager.provisionPackagedSample).not.toHaveBeenCalled();
    expect(manager.sampleBootstrapAllowedThisLaunch).toBe(false);
    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
    expect(manager.startApi).toHaveBeenCalledOnce();
    expect(manager.startWeb).toHaveBeenCalledOnce();
    expect(manager.startWorker).toHaveBeenCalledOnce();
  });

  it("does not present the service credential unless API ownership verifies", async () => {
    const manager = internals();
    const { startup, controller } = authorize(manager);
    manager.verifyOwnedApi = vi.fn().mockResolvedValue(false);
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest(startup, 1, controller.signal);
    await vi.waitFor(() =>
      expect(manager.verifyOwnedApi).toHaveBeenCalledOnce(),
    );

    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
  });

  it("starts ingestion only after API ownership verifies", async () => {
    const manager = internals();
    const { startup, controller } = authorize(manager);
    manager.verifyOwnedApi = vi.fn().mockResolvedValue(true);
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest(startup, 1, controller.signal);
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

  it("does not provision when the managed child exits during migrations", async () => {
    const manager = internals();
    manager.cockroachStatus = "running";
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    manager.startCockroach = vi.fn().mockResolvedValue({
      ownership: "managed-child",
      dataDir: "/tmp/skytwin-sample-test/crdb-data",
      generation: 1,
    });
    manager.cockroach.isManagedStartCurrent
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    manager.runMigrations = vi.fn().mockResolvedValue(true);
    manager.provisionPackagedSample = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn().mockResolvedValue(false);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();

    await manager.startAll();

    expect(manager.runMigrations).toHaveBeenCalledOnce();
    expect(manager.provisionPackagedSample).not.toHaveBeenCalled();
  });

  it("revokes a deferred verifier before stop can hand the port to another listener", async () => {
    const manager = internals();
    const { startup, controller } = authorize(manager);
    let finishVerification: ((value: boolean) => void) | undefined;
    manager.verifyOwnedApi = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishVerification = resolve;
        }),
    );
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest(startup, 1, controller.signal);
    await vi.waitFor(() =>
      expect(manager.verifyOwnedApi).toHaveBeenCalledOnce(),
    );
    manager.api.process = null;
    await manager.stopAll();
    finishVerification?.(true);
    await Promise.resolve();

    expect(controller.signal.aborted).toBe(true);
    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
  });

  it("rejects a replacement API process after challenge verification", async () => {
    const manager = internals();
    const { startup, controller } = authorize(manager);
    manager.verifyOwnedApi = vi.fn().mockImplementation(async () => {
      manager.api.process = fakeProcess();
      return true;
    });
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest(startup, 1, controller.signal);
    await vi.waitFor(() =>
      expect(manager.verifyOwnedApi).toHaveBeenCalledOnce(),
    );
    await Promise.resolve();

    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
  });

  it("revokes a deferred verifier when a newer launch begins", async () => {
    const manager = internals();
    const { startup, controller } = authorize(manager);
    let finishVerification: ((value: boolean) => void) | undefined;
    manager.verifyOwnedApi = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishVerification = resolve;
        }),
    );
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    manager.startPackagedSampleIngest(startup, 1, controller.signal);
    await vi.waitFor(() =>
      expect(manager.verifyOwnedApi).toHaveBeenCalledOnce(),
    );
    const nextLaunch = manager.beginSampleLaunch();
    finishVerification?.(true);
    await Promise.resolve();

    expect(nextLaunch.epoch).toBe(2);
    expect(controller.signal.aborted).toBe(true);
    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
  });

  it("rechecks launch authority after deferred embedded-module discovery", async () => {
    const manager = internals();
    const { startup, controller, process } = authorize(manager);
    let finishDiscovery: ((value: string) => void) | undefined;
    manager.ensureEmbeddedRoot = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const ingestion = manager.ingestPackagedSample(
      startup,
      1,
      controller.signal,
      process,
    );
    manager.revokeSampleLaunch();
    finishDiscovery?.("/tmp/embedded");
    await ingestion;

    expect(fetchImpl).not.toHaveBeenCalled();
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
