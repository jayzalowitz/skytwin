import { createHmac } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdlePauseController } from "../idle-pause-controller.js";

const cockroachMockState = vi.hoisted(() => ({
  authorityLossHandler: null as ((generation: number) => void) | null,
}));

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
      setAuthorityLossHandler: vi.fn(
        (handler: (generation: number) => void) => {
          cockroachMockState.authorityLossHandler = handler;
        },
      ),
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
  activeDatabaseStartup: SampleStartup | null;
  invalidatedDatabaseStartup: SampleStartup | null;
  api: { process: ChildProcess | null; external: boolean; status?: string };
  web: { process: ChildProcess | null; external: boolean; status?: string };
  worker: {
    process: ChildProcess | null;
    external: boolean;
    status: string;
    restartCount: number;
    failureTimestamps: number[];
  };
  apiGeneration: TestApiGeneration | null;
  readyApiGeneration: TestApiGeneration | null;
  registeredWorkerGeneration: TestApiGeneration | null;
  healthCheckInFlight: boolean;
  cockroach: {
    isManagedStartCurrent: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
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
  startApi(startup?: SampleStartup | null): Promise<TestApiGeneration | null>;
  waitForApi(
    timeoutMs: number,
    startup?: SampleStartup | null,
    generation?: TestApiGeneration | null,
  ): Promise<boolean>;
  startWeb(
    startup?: SampleStartup | null,
    generation?: TestApiGeneration | null,
  ): Promise<void>;
  startWorker(
    startup?: SampleStartup | null,
    generation?: TestApiGeneration | null,
  ): Promise<void>;
  startHealthMonitoring(startup?: SampleStartup | null): void;
  runHealthCheck(startup?: SampleStartup | null): Promise<void>;
  stopDataServicesOwned(): Promise<void>;
  workerGenerationAuthorityModule(): Promise<{
    registerWorkerGenerationAuthority(options: {
      connectionString: string;
      generationId: string;
      generationSecret: string;
      authorize: () => boolean;
    }): Promise<void>;
    revokeWorkerGenerationAuthority(options: {
      connectionString: string;
      generationId: string;
      generationSecret: string;
      authorize: () => boolean;
    }): Promise<void>;
  }>;
  registerWorkerGenerationAuthority(
    generation: TestApiGeneration,
    startup: SampleStartup,
  ): Promise<void>;
  startPackagedSampleIngest(
    startup: SampleStartup,
    epoch: number,
    signal: AbortSignal,
  ): void;
  verifyOwnedApi(
    generation: TestApiGeneration,
    epoch?: number,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<boolean>;
  ingestPackagedSample(
    startup: SampleStartup,
    epoch: number,
    signal: AbortSignal,
    generation: TestApiGeneration,
  ): Promise<void>;
  loadPackagedSampleIngestModule(moduleUrl: string): Promise<{
    ingestPackagedSampleSignals(options: {
      apiUrl: string;
      serviceToken: string;
      signal: AbortSignal;
      authorizeRequest: () => Promise<boolean>;
    }): Promise<{ ingested: number; total: number }>;
  }>;
  revokeApiGeneration(generation?: TestApiGeneration): void;
  stopProcess(
    process: {
      process: ChildProcess | null;
      status: string;
      external: boolean;
    },
    name: string,
  ): Promise<void>;
  revokeSampleLaunch(): void;
  beginSampleLaunch(): { epoch: number; signal: AbortSignal };
  stopAll(): Promise<void>;
  startAll(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getEnv(): Record<string, string>;
  apiEnv(instanceCapability: string): Record<string, string>;
  workerEnv(generation: TestApiGeneration | null): Record<string, string>;
  webEnv(): Record<string, string>;
}

interface TestApiGeneration {
  generation: number;
  process: ChildProcess;
  instanceCapability: string;
  ingestCredential: string;
  workerAuthorityId: string;
  workerAuthoritySecret: string;
  controller: AbortController;
}

interface SampleStartup {
  ownership: "managed-child" | "preexisting";
  dataDir: string | null;
  generation: number | null;
}

function fakeProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    connected: true,
    kill: vi.fn(() => true),
  });
  return child;
}

function apiGeneration(
  process = fakeProcess(),
  generation = 1,
): TestApiGeneration {
  return {
    generation,
    process,
    instanceCapability: `instance-capability-${generation}`,
    ingestCredential: `ingest-credential-${generation}`,
    workerAuthorityId: `93c89fcc-2fa4-49a4-8510-${String(generation).padStart(12, "0")}`,
    workerAuthoritySecret: String(generation).padStart(64, "0"),
    controller: new AbortController(),
  };
}

function authorize(manager: ServiceManager & SampleManagerInternals): {
  startup: SampleStartup;
  controller: AbortController;
  generation: TestApiGeneration;
} {
  const startup: SampleStartup = {
    ownership: "managed-child",
    dataDir: "/tmp/skytwin-sample-test/crdb-data",
    generation: 1,
  };
  const controller = new AbortController();
  const generation = apiGeneration();
  manager.sampleLaunchEpoch = 1;
  manager.sampleAbortController = controller;
  manager.sampleBootstrapAllowedThisLaunch = true;
  manager.api.process = generation.process;
  manager.api.external = false;
  manager.apiGeneration = generation;
  manager.readyApiGeneration = generation;
  manager.cockroach.isManagedStartCurrent.mockReturnValue(true);
  return { startup, controller, generation };
}

function internals(
  realWorkerAuthority = false,
): ServiceManager & SampleManagerInternals {
  const manager = new ServiceManager() as ServiceManager &
    SampleManagerInternals;
  if (!realWorkerAuthority) {
    manager.registerWorkerGenerationAuthority = vi.fn(async (generation) => {
      manager.registeredWorkerGeneration = generation;
    });
    manager.workerGenerationAuthorityModule = vi.fn().mockResolvedValue({
      registerWorkerGenerationAuthority: vi.fn().mockResolvedValue(undefined),
      revokeWorkerGenerationAuthority: vi.fn().mockResolvedValue(undefined),
    });
  }
  return manager;
}

describe("packaged sample startup sequencing", () => {
  const previousToken = process.env["SKYTWIN_SERVICE_TOKEN"];
  const previousDatabaseUrl = process.env["DATABASE_URL"];

  beforeEach(() => {
    cockroachMockState.authorityLossHandler = null;
    delete process.env["DATABASE_URL"];
    process.env["SKYTWIN_SERVICE_TOKEN"] = "service-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousToken === undefined)
      delete process.env["SKYTWIN_SERVICE_TOKEN"];
    else process.env["SKYTWIN_SERVICE_TOKEN"] = previousToken;
    if (previousDatabaseUrl === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousDatabaseUrl;
  });

  it("pins packaged child services to the attested bundled database", () => {
    process.env["DATABASE_URL"] =
      "postgresql://root@127.0.0.1:39999/foreign?sslmode=disable";
    const manager = internals();

    expect(manager.getEnv()["DATABASE_URL"]).toBe(
      "postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable",
    );
  });

  it("shares generation-scoped ingest credentials only with the API and its worker", () => {
    const manager = internals();
    const { generation } = authorize(manager);
    const environment = manager.apiEnv(generation.instanceCapability);
    generation.ingestCredential = environment["SKYTWIN_SERVICE_TOKEN"];
    manager.registeredWorkerGeneration = generation;

    expect(manager.getEnv()["SKYTWIN_SERVICE_TOKEN"]).toBeUndefined();
    expect(environment).toMatchObject({
      SKYTWIN_API_INSTANCE_CAPABILITY: generation.instanceCapability,
      SKYTWIN_SERVICE_TOKEN: generation.ingestCredential,
      API_BASE_URL: "http://127.0.0.1:3100",
    });
    expect(manager.workerEnv(generation)["SKYTWIN_SERVICE_TOKEN"]).toBe(
      generation.ingestCredential,
    );
    expect(
      manager.apiEnv("next-instance-capability")["SKYTWIN_SERVICE_TOKEN"],
    ).not.toBe(generation.ingestCredential);
    expect(manager.workerEnv(generation)).toMatchObject({
      SKYTWIN_WORKER_GENERATION_ID: generation.workerAuthorityId,
      SKYTWIN_WORKER_GENERATION_SECRET: generation.workerAuthoritySecret,
    });
    expect(
      manager.workerEnv(generation)["SKYTWIN_API_INSTANCE_CAPABILITY"],
    ).toBeUndefined();
    expect(manager.webEnv()["SKYTWIN_SERVICE_TOKEN"]).toBeUndefined();
    expect(manager.webEnv()["SKYTWIN_API_INSTANCE_CAPABILITY"]).toBeUndefined();
  });

  it("registers and durably revokes the exact worker generation", async () => {
    const manager = internals(true);
    const { startup, generation } = authorize(manager);
    manager.activeDatabaseStartup = startup;
    const register = vi.fn().mockResolvedValue(undefined);
    const revoke = vi.fn().mockResolvedValue(undefined);
    manager.workerGenerationAuthorityModule = vi.fn().mockResolvedValue({
      registerWorkerGenerationAuthority: register,
      revokeWorkerGenerationAuthority: revoke,
    });

    await manager.registerWorkerGenerationAuthority(generation, startup);
    expect(register).toHaveBeenCalledOnce();
    const registration = register.mock.calls[0]![0];
    expect(registration).toMatchObject({
      generationId: generation.workerAuthorityId,
      generationSecret: generation.workerAuthoritySecret,
      connectionString:
        "postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable",
    });
    expect(registration.authorize()).toBe(true);
    expect(manager.registeredWorkerGeneration).toBe(generation);

    manager.api.process = null;
    await manager.stopDataServicesOwned();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke.mock.calls[0]![0]).toMatchObject({
      generationId: generation.workerAuthorityId,
      generationSecret: generation.workerAuthoritySecret,
    });
    expect(manager.registeredWorkerGeneration).toBeNull();
  });

  it("retains worker authority state when durable revocation cannot be proven", async () => {
    const manager = internals();
    const { startup, generation } = authorize(manager);
    manager.activeDatabaseStartup = startup;
    manager.registeredWorkerGeneration = generation;
    manager.api.process = null;
    manager.workerGenerationAuthorityModule = vi.fn().mockResolvedValue({
      registerWorkerGenerationAuthority: vi.fn(),
      revokeWorkerGenerationAuthority: vi
        .fn()
        .mockRejectedValue(new Error("revocation unproven")),
    });

    await expect(manager.stopDataServicesOwned()).rejects.toThrow(
      "revocation unproven",
    );
    expect(manager.registeredWorkerGeneration).toBe(generation);
  });

  it("reconciles registration when the database response is ambiguous", async () => {
    const manager = internals(true);
    const { startup, generation } = authorize(manager);
    manager.activeDatabaseStartup = startup;
    const register = vi
      .fn()
      .mockRejectedValue(new Error("commit response lost"));
    const revoke = vi.fn().mockResolvedValue(undefined);
    manager.workerGenerationAuthorityModule = vi.fn().mockResolvedValue({
      registerWorkerGenerationAuthority: register,
      revokeWorkerGenerationAuthority: revoke,
    });

    await expect(
      manager.registerWorkerGenerationAuthority(generation, startup),
    ).rejects.toThrow("commit response lost");

    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: generation.workerAuthorityId,
        generationSecret: generation.workerAuthoritySecret,
      }),
    );
    expect(manager.registeredWorkerGeneration).toBeNull();
  });

  it("fails closed before database or web startup if packaged external detection ever succeeds", async () => {
    const manager = internals();
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(true);
    manager.startCockroach = vi.fn().mockResolvedValue(null);
    manager.startApi = vi.fn().mockResolvedValue(null);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);

    await expect(manager.startAll()).rejects.toThrow(
      /refused an external API listener/,
    );

    expect(manager.cockroachStatus).toBe("error");
    expect(manager.startCockroach).not.toHaveBeenCalled();
    expect(manager.startApi).not.toHaveBeenCalled();
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
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
    const generation = apiGeneration();
    manager.startApi = vi.fn().mockImplementation(async () => {
      manager.api.process = generation.process;
      manager.apiGeneration = generation;
      return generation;
    });
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
    expect(
      (manager.registerWorkerGenerationAuthority as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0],
    ).toBeLessThan(
      (manager.waitForApi as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      (manager.registerWorkerGenerationAuthority as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder[0],
    ).toBeLessThan(
      (manager.startWeb as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not start web or worker when the API generation cannot prove readiness", async () => {
    const manager = internals();
    manager.cockroachStatus = "running";
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    const startup: SampleStartup = {
      ownership: "managed-child",
      dataDir: "/tmp/skytwin-sample-test/crdb-data",
      generation: 1,
    };
    manager.startCockroach = vi.fn().mockResolvedValue(startup);
    manager.runMigrations = vi.fn().mockResolvedValue(true);
    manager.provisionPackagedSample = vi.fn().mockResolvedValue(undefined);
    const generation = apiGeneration();
    manager.startApi = vi.fn().mockImplementation(async () => {
      manager.api.process = generation.process;
      manager.apiGeneration = generation;
      return generation;
    });
    manager.waitForApi = vi.fn().mockResolvedValue(false);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.stopDataServicesOwned = vi.fn().mockImplementation(async () => {
      manager.revokeApiGeneration(generation);
    });

    await expect(manager.startAll()).rejects.toThrow(
      /could not authenticate the desktop-owned API listener/,
    );

    expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce();
    expect(generation.controller.signal.aborted).toBe(true);
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
  });

  it("refuses packaged services when a foreign CockroachDB owns the port", async () => {
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
    manager.startApi = vi.fn().mockResolvedValue(null);
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();
    manager.ingestPackagedSample = vi.fn().mockResolvedValue(undefined);

    await expect(manager.startAll()).rejects.toThrow(
      /requires the desktop-owned CockroachDB instance/,
    );
    await Promise.resolve();

    expect(manager.runMigrations).not.toHaveBeenCalled();
    expect(manager.provisionPackagedSample).not.toHaveBeenCalled();
    expect(manager.sampleBootstrapAllowedThisLaunch).toBe(false);
    expect(manager.ingestPackagedSample).not.toHaveBeenCalled();
    expect(manager.startApi).not.toHaveBeenCalled();
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
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
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    manager.runMigrations = vi.fn().mockResolvedValue(true);
    manager.provisionPackagedSample = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue(null);
    manager.waitForApi = vi.fn().mockResolvedValue(false);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();

    await expect(manager.startAll()).rejects.toThrow(
      /requires migrations on the desktop-owned CockroachDB instance/,
    );

    expect(manager.runMigrations).toHaveBeenCalledOnce();
    expect(manager.provisionPackagedSample).not.toHaveBeenCalled();
    expect(manager.startApi).not.toHaveBeenCalled();
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
  });

  it("refuses packaged services when owned migrations do not complete", async () => {
    const manager = internals();
    manager.cockroachStatus = "running";
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    manager.startCockroach = vi.fn().mockResolvedValue({
      ownership: "managed-child",
      dataDir: "/tmp/skytwin-sample-test/crdb-data",
      generation: 1,
    });
    manager.runMigrations = vi.fn().mockResolvedValue(false);
    manager.provisionPackagedSample = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue(null);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();

    await expect(manager.startAll()).rejects.toThrow(
      /requires migrations on the desktop-owned CockroachDB instance/,
    );

    expect(manager.provisionPackagedSample).not.toHaveBeenCalled();
    expect(manager.startApi).not.toHaveBeenCalled();
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
  });

  it("stops startup when the owned database dies during API readiness", async () => {
    const manager = internals();
    manager.cockroachStatus = "running";
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    const startup: SampleStartup = {
      ownership: "managed-child",
      dataDir: "/tmp/skytwin-sample-test/crdb-data",
      generation: 1,
    };
    manager.startCockroach = vi.fn().mockResolvedValue(startup);
    manager.runMigrations = vi.fn().mockResolvedValue(true);
    manager.provisionPackagedSample = vi.fn().mockImplementation(async () => {
      manager.sampleBootstrapAllowedThisLaunch = true;
    });
    const generation = apiGeneration();
    manager.startApi = vi.fn().mockImplementation(async () => {
      manager.api.process = generation.process;
      manager.apiGeneration = generation;
      return generation;
    });
    let launchSignal: AbortSignal | undefined;
    manager.waitForApi = vi.fn().mockImplementation(async () => {
      launchSignal = manager.sampleAbortController?.signal;
      manager.cockroach.isManagedStartCurrent.mockReturnValue(false);
      return true;
    });
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();
    manager.stopDataServicesOwned = vi.fn().mockImplementation(async () => {
      manager.revokeApiGeneration(generation);
    });

    await expect(manager.startAll()).rejects.toThrow(
      /ownership changed during API readiness/,
    );

    expect(manager.startApi).toHaveBeenCalledExactlyOnceWith(startup);
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
    expect(launchSignal?.aborted).toBe(true);
    expect(manager.cockroachStatus).toBe("error");
  });

  it("revokes the launch and stops all services when the owned database exits", async () => {
    const manager = internals();
    const startup: SampleStartup = {
      ownership: "managed-child",
      dataDir: "/tmp/skytwin-sample-test/crdb-data",
      generation: 7,
    };
    const controller = new AbortController();
    manager.activeDatabaseStartup = startup;
    manager.sampleAbortController = controller;
    manager.sampleLaunchEpoch = 1;
    manager.sampleBootstrapAllowedThisLaunch = true;
    manager.cockroachStatus = "running";
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);

    expect(cockroachMockState.authorityLossHandler).not.toBeNull();
    cockroachMockState.authorityLossHandler?.(7);
    await vi.waitFor(() =>
      expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce(),
    );

    expect(manager.activeDatabaseStartup).toBeNull();
    expect(controller.signal.aborted).toBe(true);
    expect(manager.sampleBootstrapAllowedThisLaunch).toBe(false);
    expect(manager.cockroachStatus).toBe("error");
  });

  it("treats a replacement listener as database authority loss during health monitoring", async () => {
    const manager = internals();
    const { startup, controller } = authorize(manager);
    manager.activeDatabaseStartup = startup;
    manager.cockroachStatus = "running";
    manager.stopDataServicesOwned = vi.fn().mockImplementation(async () => {
      manager.api.process = null;
      manager.apiGeneration = null;
      manager.registeredWorkerGeneration = null;
    });
    manager.cockroach.isManagedStartCurrent.mockReturnValue(false);

    await manager.runHealthCheck(startup);
    await vi.waitFor(() =>
      expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce(),
    );

    expect(controller.signal.aborted).toBe(true);
    expect(manager.activeDatabaseStartup).toBeNull();
    expect(manager.cockroachStatus).toBe("error");
  });

  it("blocks a hostile listener reconnect before any new packaged startup work", async () => {
    const manager = internals();
    const { startup, generation } = authorize(manager);
    manager.activeDatabaseStartup = startup;
    manager.registeredWorkerGeneration = generation;
    manager.cockroachStatus = "running";
    manager.stopDataServicesOwned = vi
      .fn()
      .mockRejectedValue(new Error("old API exit unproven"));
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.waitForExternalApi = vi.fn().mockResolvedValue(false);
    manager.startCockroach = vi.fn();
    manager.runMigrations = vi.fn();
    manager.startApi = vi.fn();

    manager.cockroach.isManagedStartCurrent.mockReturnValue(false);
    cockroachMockState.authorityLossHandler?.(startup.generation!);
    await vi.waitFor(() =>
      expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce(),
    );
    // Model an unrelated listener taking the same endpoint after the owned
    // database disappeared. Retained generation state must still win.
    manager.cockroach.isManagedStartCurrent.mockReturnValue(true);

    await expect(manager.startAll()).rejects.toThrow(
      /blocked until every previous service generation has proven termination/,
    );
    expect(manager.activeDatabaseStartup).toBe(startup);
    expect(manager.invalidatedDatabaseStartup).toBe(startup);
    expect(manager.registeredWorkerGeneration).toBe(generation);
    expect(manager.ensureEmbeddedRoot).not.toHaveBeenCalled();
    expect(manager.waitForExternalApi).not.toHaveBeenCalled();
    expect(manager.startCockroach).not.toHaveBeenCalled();
    expect(manager.runMigrations).not.toHaveBeenCalled();
    expect(manager.startApi).not.toHaveBeenCalled();
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
    const { startup, controller, generation } = authorize(manager);
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
      generation,
    );
    manager.revokeSampleLaunch();
    finishDiscovery?.("/tmp/embedded");
    await ingestion;

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechecks API-generation authority after deferred embedded-module discovery", async () => {
    const manager = internals();
    const { startup, controller, generation } = authorize(manager);
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
      generation,
    );
    manager.revokeApiGeneration(generation);
    finishDiscovery?.("/tmp/embedded");
    await ingestion;

    expect(generation.controller.signal.aborted).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts an in-flight sample POST when its exact API generation is revoked", async () => {
    const manager = internals();
    const { startup, controller, generation } = authorize(manager);
    const embeddedRoot = mkdtempSync(
      join(tmpdir(), "skytwin-generation-ingest-"),
    );
    const moduleDir = join(
      embeddedRoot,
      "api",
      "node_modules",
      "@skytwin",
      "db",
      "dist",
      "seeds",
    );
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, "packaged-sample.js"),
      "test module placeholder",
    );
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue(embeddedRoot);
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        const finish = (): void => resolve(new Response(null, { status: 202 }));
        if (requestSignal?.aborted) finish();
        else requestSignal?.addEventListener("abort", finish, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    manager.loadPackagedSampleIngestModule = vi.fn().mockResolvedValue({
      ingestPackagedSampleSignals: async (options) => {
        await fetch("http://127.0.0.1:3100/api/events/ingest", {
          method: "POST",
          headers: { "x-skytwin-service-token": options.serviceToken },
          signal: options.signal,
        });
        return { ingested: 1, total: 1 };
      },
    });

    try {
      const ingestion = manager.ingestPackagedSample(
        startup,
        1,
        controller.signal,
        generation,
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
      const requestInit = fetchImpl.mock.calls[0]?.[1];
      expect(
        (requestInit?.headers as Record<string, string>)[
          "x-skytwin-service-token"
        ],
      ).toBe(generation.ingestCredential);

      manager.revokeApiGeneration(generation);
      await ingestion;

      expect(requestSignal?.aborted).toBe(true);
    } finally {
      rmSync(embeddedRoot, { recursive: true, force: true });
    }
  });

  it("authenticates the concrete API listener by challenge-response", async () => {
    const manager = internals();
    const { generation } = authorize(manager);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const challenge = input.searchParams.get("challenge") ?? "";
        const proof = createHmac("sha256", generation.instanceCapability)
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

    await expect(manager.verifyOwnedApi(generation)).resolves.toBe(true);
  });

  it("rejects a generic or forged listener before privileged ingest", async () => {
    const manager = internals();
    const { generation } = authorize(manager);
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

    await expect(manager.verifyOwnedApi(generation)).resolves.toBe(false);
  });

  it("rejects a proof made with a stale API generation capability", async () => {
    const manager = internals();
    const { generation } = authorize(manager);
    const stale = apiGeneration(fakeProcess(), generation.generation - 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL) => {
        const challenge = input.searchParams.get("challenge") ?? "";
        return new Response(
          JSON.stringify({
            service: "skytwin-api",
            challenge,
            proof: createHmac("sha256", stale.instanceCapability)
              .update(`skytwin-api-instance-v1.${challenge}`)
              .digest("hex"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(manager.verifyOwnedApi(generation)).resolves.toBe(false);
  });

  it("bounds a listener that never returns response headers", async () => {
    const manager = internals();
    const { generation } = authorize(manager);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );

    await expect(
      manager.verifyOwnedApi(generation, undefined, undefined, 10),
    ).resolves.toBe(false);
  });

  it("bounds a listener that sends headers but never completes its proof body", async () => {
    const manager = internals();
    const { generation } = authorize(manager);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => new Promise<unknown>(() => undefined),
      }),
    );

    await expect(
      manager.verifyOwnedApi(generation, undefined, undefined, 10),
    ).resolves.toBe(false);
  });

  it("prevents overlapping health probes and aborts the in-flight proof on generation revoke", async () => {
    const manager = internals();
    const { startup, generation } = authorize(manager);
    manager.activeDatabaseStartup = startup;
    manager.api.status = "running";
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchImpl);

    const first = manager.runHealthCheck(startup);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await manager.runHealthCheck(startup);
    expect(fetchImpl).toHaveBeenCalledOnce();

    manager.revokeApiGeneration(generation);
    await first;
    expect(generation.controller.signal.aborted).toBe(true);
    expect(manager.healthCheckInFlight).toBe(false);
  });

  it("retains an unproven child handle and reports a typed fatal stop failure", async () => {
    vi.useFakeTimers();
    try {
      const manager = internals();
      const process = fakeProcess();
      const managed = { process, status: "running", external: false };
      const stopped = manager.stopProcess(managed, "api");
      const assertion = expect(stopped).rejects.toMatchObject({
        code: "CHILD_TERMINATION_UNPROVEN",
        serviceName: "api",
      });

      await vi.runAllTimersAsync();
      await assertion;
      expect(process.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(managed.process).toBe(process);
      expect(managed.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failed pause fail-closed when manual resume is requested", async () => {
    vi.useFakeTimers();
    try {
      const manager = internals(true);
      const { startup, generation } = authorize(manager);
      const worker = fakeProcess();
      manager.activeDatabaseStartup = startup;
      manager.registeredWorkerGeneration = generation;
      manager.worker = {
        process: worker,
        status: "running",
        external: false,
        restartCount: 0,
        failureTimestamps: [],
      };
      const revoke = vi.fn().mockResolvedValue(undefined);
      manager.workerGenerationAuthorityModule = vi.fn().mockResolvedValue({
        registerWorkerGenerationAuthority: vi.fn(),
        revokeWorkerGenerationAuthority: revoke,
      });

      const pausing = manager.pause();
      const pauseFailure = expect(pausing).rejects.toThrow(
        /pause and generation containment both failed/,
      );
      await vi.runAllTimersAsync();
      await pauseFailure;

      const killsBeforeResume = (worker.kill as ReturnType<typeof vi.fn>).mock
        .calls.length;
      await expect(
        manager.startWorker(startup, generation),
      ).rejects.toMatchObject({
        code: "CHILD_TERMINATION_UNPROVEN",
        serviceName: "worker",
      });
      await expect(manager.resume()).rejects.toMatchObject({
        code: "CHILD_TERMINATION_UNPROVEN",
        serviceName: "worker",
      });
      expect(manager.worker.process).toBe(worker);
      expect(manager.worker.status).toBe("error");
      expect(manager.isPaused()).toBe(true);
      expect(worker.kill).toHaveBeenCalledTimes(killsBeforeResume);
      expect(revoke).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps idle auto-pause ownership after hostile pause and resume failures", async () => {
    vi.useFakeTimers();
    try {
      const manager = internals(true);
      const { startup, generation } = authorize(manager);
      const worker = fakeProcess();
      manager.activeDatabaseStartup = startup;
      manager.registeredWorkerGeneration = generation;
      manager.worker = {
        process: worker,
        status: "running",
        external: false,
        restartCount: 0,
        failureTimestamps: [],
      };
      manager.workerGenerationAuthorityModule = vi.fn().mockResolvedValue({
        registerWorkerGenerationAuthority: vi.fn(),
        revokeWorkerGenerationAuthority: vi.fn().mockResolvedValue(undefined),
      });
      const idle = new IdlePauseController({
        getEnabled: () => true,
        isCurrentlyPaused: () => manager.isPaused(),
        pauseServices: () => manager.pause(),
        resumeServices: () => manager.resume(),
      });

      const pausing = idle.onIdleStateChange("idle");
      const pauseFailure = expect(pausing).rejects.toThrow(
        /pause and generation containment both failed/,
      );
      await vi.runAllTimersAsync();
      await pauseFailure;
      expect(idle.isAutoPausedByIdle()).toBe(true);

      await expect(idle.onIdleStateChange("active")).rejects.toMatchObject({
        code: "CHILD_TERMINATION_UNPROVEN",
        serviceName: "worker",
      });
      expect(idle.isAutoPausedByIdle()).toBe(true);
      expect(manager.worker.process).toBe(worker);
      expect(manager.isPaused()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for forced child close before reporting a service stopped", async () => {
    vi.useFakeTimers();
    try {
      const manager = internals();
      const process = fakeProcess();
      (process.kill as ReturnType<typeof vi.fn>).mockImplementation(
        (signal: NodeJS.Signals) => {
          if (signal === "SIGKILL")
            queueMicrotask(() => process.emit("close", null, "SIGKILL"));
          return true;
        },
      );
      const managed = { process, status: "running", external: false };

      const stopped = manager.stopProcess(managed, "worker");
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;

      expect(process.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(managed.process).toBeNull();
      expect(managed.status).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the proven database listener up when a data-service exit cannot be proven", async () => {
    const manager = internals();
    manager.stopDataServicesOwned = vi.fn().mockRejectedValue(
      Object.assign(new Error("api child termination could not be proven"), {
        code: "CHILD_TERMINATION_UNPROVEN",
      }),
    );

    await expect(manager.stopAll()).rejects.toMatchObject({
      code: "CHILD_TERMINATION_UNPROVEN",
    });
    expect(manager.cockroach.stop).not.toHaveBeenCalled();
  });
});
