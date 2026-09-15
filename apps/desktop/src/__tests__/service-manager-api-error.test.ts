import type {
  ChildProcess,
  fork as forkType,
  spawn as spawnType,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processState = vi.hoisted(() => ({
  child: null as ChildProcess | null,
  fork: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/skytwin-api-error-test",
    isPackaged: true,
  },
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  fork: processState.fork as unknown as typeof forkType,
  spawn: vi.fn() as unknown as typeof spawnType,
}));

vi.mock("../cockroach-manager.js", () => ({
  CockroachManager: vi.fn(function CockroachManager() {
    return {
      getConnectionString: () =>
        "postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable",
      getDataDir: () => "/tmp/skytwin-api-error-test/crdb-data",
      isManagedStartCurrent: vi.fn().mockReturnValue(true),
      setAuthorityLossHandler: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { ServiceManager } = await import("../service-manager.js");

interface ApiGenerationForTest {
  process: ChildProcess;
  controller: AbortController;
  ingestCredential: string;
}

interface ManagerInternals {
  activeDatabaseStartup: {
    ownership: "managed-child";
    dataDir: string;
    generation: number;
  } | null;
  api: {
    process: ChildProcess | null;
    status: string;
    restartCount: number;
    failureTimestamps: number[];
    external: boolean;
  };
  worker: {
    process: ChildProcess | null;
    status: string;
    restartCount: number;
    failureTimestamps: number[];
    external: boolean;
  };
  web: {
    process: ChildProcess | null;
    status: string;
    restartCount: number;
    failureTimestamps: number[];
    external: boolean;
  };
  apiGeneration: ApiGenerationForTest | null;
  readyApiGeneration: ApiGenerationForTest | null;
  webApiGeneration: ApiGenerationForTest | null;
  workerApiGeneration: ApiGenerationForTest | null;
  registeredWorkerGeneration: ApiGenerationForTest | null;
  paused: boolean;
  serviceLifecycleTail: Promise<void>;
  getResourcePath(): string;
  ensureEmbeddedRoot(): Promise<string>;
  revokeWorkerGenerationAuthority(
    generation: ApiGenerationForTest,
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
  ): Promise<void>;
  workerEnv(generation: ApiGenerationForTest): Record<string, string>;
  webEnv(): Record<string, string>;
  scheduleApiRestart(
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
    reason: string,
  ): void;
  restartDataServicesAfterApiExit(
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
    delayMs: number,
  ): Promise<void>;
  stopDataServicesOwned(): Promise<void>;
  stopDataServicesForApiGeneration(
    generation: ApiGenerationForTest,
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
  ): Promise<void>;
  registerWorkerGenerationAuthority(
    generation: ApiGenerationForTest,
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
  ): Promise<void>;
  waitForApi(
    timeoutMs: number,
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
    generation: ApiGenerationForTest,
  ): Promise<boolean>;
  startWeb(
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
    generation: ApiGenerationForTest,
  ): Promise<void>;
  startWorker(
    startup: {
      ownership: "managed-child";
      dataDir: string;
      generation: number;
    },
    generation: ApiGenerationForTest,
  ): Promise<void>;
  startHealthMonitoring(startup: {
    ownership: "managed-child";
    dataDir: string;
    generation: number;
  }): void;
  resume(): Promise<void>;
  stopAll(): Promise<void>;
  startAll(): Promise<void>;
  stopAllOwned(): Promise<void>;
  startAllOwned(): Promise<void>;
  runHealthCheck(startup: {
    ownership: "managed-child";
    dataDir: string;
    generation: number;
  }): Promise<void>;
  startApi(startup: {
    ownership: "managed-child";
    dataDir: string;
    generation: number;
  }): Promise<ApiGenerationForTest | null>;
  detectExternalApi(): Promise<boolean>;
}

function stubbornChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 7654,
    exitCode: null,
    signalCode: null,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

function generationWorker(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 7655,
    exitCode: null,
    signalCode: null,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        // `kill()` only requests delivery; it does not synchronously run the
        // worker's signal handler or prove exit. Model that boundary by
        // emitting close on a later turn.
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      }
      return true;
    }),
  });
  return child;
}

describe("ServiceManager API error lifecycle", () => {
  const previousSessionSecret = process.env["SESSION_SECRET"];

  beforeEach(() => {
    process.env["SESSION_SECRET"] = "a".repeat(64);
    processState.child = stubbornChild();
    processState.fork.mockReset();
    processState.fork.mockImplementation(() => processState.child);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousSessionSecret === undefined)
      delete process.env["SESSION_SECRET"];
    else process.env["SESSION_SECRET"] = previousSessionSecret;
  });

  it("awaits generation worker shutdown and blocks replacement when API error has no exit proof", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const worker = generationWorker();
    manager.worker = {
      process: worker,
      status: "running",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;

    const generation = await manager.startApi(startup);
    expect(generation).not.toBeNull();
    manager.workerApiGeneration = generation;
    processState.child?.emit("error", new Error("spawn channel failed"));

    expect(generation?.controller.signal.aborted).toBe(true);
    expect(manager.apiGeneration).toBeNull();
    expect(manager.api.process).toBe(processState.child);
    expect(worker.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.worker.process).toBe(worker);
    expect(processState.fork).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(manager.worker.process).toBeNull();
    expect(processState.child?.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(processState.child?.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(manager.api.process).toBe(processState.child);
    expect(manager.api.status).toBe("error");
    expect(processState.fork).toHaveBeenCalledOnce();
  });

  it("contains the API when source-key broker attachment fails", async () => {
    const broker = { attachChild: vi.fn().mockResolvedValue(false) };
    const manager = new ServiceManager(
      broker as unknown as ConstructorParameters<typeof ServiceManager>[0],
    ) as InstanceType<typeof ServiceManager> & ManagerInternals;
    const api = generationWorker();
    processState.child = api;
    processState.fork.mockReturnValue(api);
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.detectExternalApi = vi.fn().mockResolvedValue(false);
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;

    expect(await manager.startApi(startup)).toBeNull();
    expect(broker.attachChild).toHaveBeenCalledWith(api, "api", new Set());
    expect(api.kill).toHaveBeenCalledWith("SIGTERM");
    expect(manager.api.process).toBeNull();
    expect(manager.apiGeneration).toBeNull();
  });

  it("observes an API exit that races a successful broker attachment", async () => {
    const broker = {
      attachChild: vi.fn().mockImplementation(async (child: ChildProcess) => {
        child.exitCode = 1;
        child.emit("exit", 1);
        return true;
      }),
    };
    const manager = new ServiceManager(
      broker as unknown as ConstructorParameters<typeof ServiceManager>[0],
    ) as InstanceType<typeof ServiceManager> & ManagerInternals;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.detectExternalApi = vi.fn().mockResolvedValue(false);
    manager.scheduleApiRestart = vi.fn();
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;

    expect(await manager.startApi(startup)).toBeNull();
    expect(manager.scheduleApiRestart).toHaveBeenCalledOnce();
    expect(manager.api.process).toBeNull();
    expect(manager.apiGeneration).toBeNull();
    expect(manager.api.status).toBe("error");
  });

  it("contains sibling services and durable worker authority when the API restart budget is exhausted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const worker = generationWorker();
    const web = generationWorker();
    manager.worker = {
      process: worker,
      status: "running",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.web = {
      process: web,
      status: "running",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;

    const generation = await manager.startApi(startup);
    expect(generation).not.toBeNull();
    const forkEnvironment = processState.fork.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(generation?.ingestCredential).toBe(forkEnvironment?.["SKYTWIN_SERVICE_TOKEN"]);
    manager.registeredWorkerGeneration = generation;
    manager.workerApiGeneration = generation;
    manager.webApiGeneration = generation;
    expect(manager.workerEnv(generation!)["SKYTWIN_SERVICE_TOKEN"]).toBe(
      generation?.ingestCredential,
    );
    expect(manager.webEnv()["SKYTWIN_SERVICE_TOKEN"]).toBeUndefined();

    const revokeAuthority = vi
      .fn()
      .mockResolvedValue(undefined);
    manager.revokeWorkerGenerationAuthority = revokeAuthority;
    manager.api.failureTimestamps = Array.from({ length: 4 }, () => Date.now());
    if (processState.child) processState.child.exitCode = 1;
    processState.child?.emit("exit", 1);
    await manager.serviceLifecycleTail;

    expect(manager.api.status).toBe("error");
    expect(manager.worker.process).toBeNull();
    expect(manager.web.process).toBeNull();
    expect(manager.registeredWorkerGeneration).toBeNull();
    expect(revokeAuthority).toHaveBeenCalledWith(generation, startup);
    expect(processState.fork).toHaveBeenCalledOnce();
  });

  it("continues the bounded restart sequence after replacement start and readiness failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    const first = { process: generationWorker(), controller: new AbortController(), ingestCredential: "first" };
    const second = { process: generationWorker(), controller: new AbortController(), ingestCredential: "second" };
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    manager.stopDataServicesForApiGeneration = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn()
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async () => {
        manager.apiGeneration = first;
        manager.api.process = first.process;
        return first;
      })
      .mockImplementationOnce(async () => {
        manager.apiGeneration = second;
        manager.api.process = second.process;
        return second;
      });
    manager.registerWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    manager.startWeb = vi.fn().mockImplementation(async (_startup, generation) => {
      manager.web.process = generationWorker();
      manager.webApiGeneration = generation;
    });
    manager.startWorker = vi.fn().mockImplementation(async (_startup, generation) => {
      manager.worker.process = generationWorker();
      manager.workerApiGeneration = generation;
    });
    manager.startHealthMonitoring = vi.fn();

    manager.scheduleApiRestart(startup, "initial API exit");
    await vi.runAllTimersAsync();
    await manager.serviceLifecycleTail;

    expect(manager.startApi).toHaveBeenCalledTimes(3);
    expect(manager.waitForApi).toHaveBeenCalledTimes(2);
    expect(manager.startWeb).toHaveBeenCalledOnce();
    expect(manager.startWorker).toHaveBeenCalledOnce();
    expect(manager.api.failureTimestamps).toHaveLength(3);
  });

  it("contains services when failed replacement readiness exhausts the budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.api.failureTimestamps = Array.from({ length: 3 }, () => Date.now());
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    manager.stopDataServicesForApiGeneration = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue({
      process: generationWorker(),
      controller: new AbortController(),
      ingestCredential: "replacement",
    });
    manager.registerWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn().mockResolvedValue(false);
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
    manager.startHealthMonitoring = vi.fn();

    manager.scheduleApiRestart(startup, "initial API exit");
    await vi.runAllTimersAsync();
    await manager.serviceLifecycleTail;

    expect(manager.startApi).toHaveBeenCalledOnce();
    expect(manager.api.failureTimestamps).toHaveLength(5);
    expect(manager.api.status).toBe("error");
    expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce();
    expect(manager.stopDataServicesForApiGeneration).toHaveBeenCalledTimes(2);
    expect(manager.startWeb).not.toHaveBeenCalled();
    expect(manager.startWorker).not.toHaveBeenCalled();
  });

  it("does not double-schedule when the replacement child exit already advanced the budget", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.api.restartCount = 1;
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    manager.stopDataServicesForApiGeneration = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue({
      process: generationWorker(),
      controller: new AbortController(),
      ingestCredential: "replacement",
    });
    manager.registerWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn().mockImplementation(async () => {
      // The real child exit handler increments this through scheduleApiRestart.
      manager.api.restartCount++;
      return false;
    });
    manager.scheduleApiRestart = vi.fn();

    await expect(manager.restartDataServicesAfterApiExit(startup, 0))
      .rejects.toThrow("Replacement API generation could not prove listener ownership");

    expect(manager.api.restartCount).toBe(2);
    expect(manager.scheduleApiRestart).not.toHaveBeenCalled();
  });

  it("claims replacement recovery once when a child error races failed readiness", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.api.restartCount = 1;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    manager.stopDataServicesForApiGeneration = vi.fn().mockResolvedValue(undefined);
    manager.registerWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);
    manager.waitForApi = vi.fn().mockImplementation(async () => {
      processState.child?.emit("error", new Error("replacement channel failed"));
      await Promise.resolve();
      return false;
    });
    manager.scheduleApiRestart = vi.fn();

    await expect(manager.restartDataServicesAfterApiExit(startup, 0))
      .rejects.toThrow("Replacement API generation could not prove listener ownership");
    await vi.waitFor(() => expect(manager.scheduleApiRestart).toHaveBeenCalledOnce());

    expect(manager.scheduleApiRestart).toHaveBeenCalledWith(
      startup,
      "child process error",
      expect.objectContaining({ process: processState.child }),
    );
    expect(processState.fork).toHaveBeenCalledOnce();
  });

  it("does not health-check a packaged API generation before readiness", async () => {
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchImpl);

    const generation = await manager.startApi(startup);
    expect(generation).not.toBeNull();
    expect(manager.readyApiGeneration).toBeNull();

    await manager.runHealthCheck(startup);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(generation?.controller.signal.aborted).toBe(false);
    expect(manager.apiGeneration).toBe(generation);
    expect(manager.api.status).toBe("running");
  });

  it("suppresses a queued replacement when pause begins during its backoff", async () => {
    vi.useFakeTimers();
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    const realStartApi = manager.startApi.bind(manager);
    manager.startApi = vi.fn().mockResolvedValue(null);

    manager.scheduleApiRestart(startup, "initial API exit");
    await vi.waitFor(() => expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce());
    manager.paused = true;
    await vi.runAllTimersAsync();
    await manager.serviceLifecycleTail;

    expect(manager.startApi).not.toHaveBeenCalled();
    expect(manager.api.restartCount).toBe(1);
    expect(manager.api.failureTimestamps).toHaveLength(1);

    vi.useRealTimers();
    const replacementApi = generationWorker();
    const replacementWeb = generationWorker();
    const replacementWorker = generationWorker();
    processState.fork.mockReset();
    processState.fork
      .mockReturnValueOnce(replacementApi)
      .mockReturnValueOnce(replacementWeb)
      .mockReturnValueOnce(replacementWorker);
    manager.startApi = realStartApi;
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.registerWorkerGenerationAuthority = vi.fn().mockImplementation(async (next) => {
      manager.registeredWorkerGeneration = next;
    });

    await manager.resume();

    expect(manager.api.restartCount).toBe(0);
    expect(manager.api.failureTimestamps).toHaveLength(0);
    expect(manager.readyApiGeneration).toBe(manager.apiGeneration);
    expect(manager.web.process).toBe(replacementWeb);
    expect(manager.worker.process).toBe(replacementWorker);
    expect(processState.fork).toHaveBeenCalledTimes(3);
  });

  it("suppresses a queued replacement when pause wins at the lifecycle boundary", async () => {
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    manager.startApi = vi.fn().mockResolvedValue(null);
    let releaseLifecycle: (() => void) | undefined;
    manager.serviceLifecycleTail = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });

    manager.scheduleApiRestart(startup, "initial API exit");
    manager.paused = true;
    releaseLifecycle?.();
    await manager.serviceLifecycleTail;

    expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce();
    expect(manager.startApi).not.toHaveBeenCalled();
    expect(manager.api.restartCount).toBe(1);
    expect(manager.api.failureTimestamps).toHaveLength(1);
  });

  it("honors a newer pause while explicit resume is awaiting API readiness", async () => {
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.paused = true;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    processState.child = generationWorker();
    manager.registerWorkerGenerationAuthority = vi.fn().mockImplementation(async (generation) => {
      manager.registeredWorkerGeneration = generation;
    });
    manager.revokeWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);
    let releaseReadiness: ((ready: boolean) => void) | undefined;
    manager.waitForApi = vi.fn(
      () => new Promise<boolean>((resolve) => {
        releaseReadiness = resolve;
      }),
    );

    const resuming = manager.resume();
    await vi.waitFor(() => expect(manager.waitForApi).toHaveBeenCalledOnce());
    const attemptedGeneration = manager.apiGeneration;
    expect(attemptedGeneration).not.toBeNull();

    await manager.pause();
    releaseReadiness?.(true);
    await expect(resuming).rejects.toThrow("Resume cancelled by a newer pause request");

    expect(attemptedGeneration?.controller.signal.aborted).toBe(true);
    expect(manager.paused).toBe(true);
    expect(manager.api.process).toBeNull();
    expect(manager.web.process).toBeNull();
    expect(manager.worker.process).toBeNull();
    expect(manager.registeredWorkerGeneration).toBeNull();
    expect(processState.fork).toHaveBeenCalledOnce();
  });

  it.each([
    ["web", 2, 1],
    ["worker", 3, 2],
  ])("contains the resume generation when %s bundle resolution fails", async (_service, failingRead, expectedForks) => {
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.paused = true;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    let bundleReads = 0;
    manager.ensureEmbeddedRoot = vi.fn().mockImplementation(async () => {
      bundleReads++;
      if (bundleReads === failingRead) throw new Error(`${_service} bundle unavailable`);
      return "/tmp/embedded";
    });
    const replacementApi = generationWorker();
    const replacementWeb = generationWorker();
    processState.fork
      .mockReturnValueOnce(replacementApi)
      .mockReturnValueOnce(replacementWeb);
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.registerWorkerGenerationAuthority = vi.fn().mockImplementation(async (generation) => {
      manager.registeredWorkerGeneration = generation;
    });
    const revokeAuthority = vi.fn().mockResolvedValue(undefined);
    manager.revokeWorkerGenerationAuthority = revokeAuthority;

    await expect(manager.resume()).rejects.toThrow(`${_service} bundle unavailable`);

    expect(manager.paused).toBe(true);
    expect(manager.api.process).toBeNull();
    expect(manager.web.process).toBeNull();
    expect(manager.worker.process).toBeNull();
    expect(manager.registeredWorkerGeneration).toBeNull();
    expect(revokeAuthority).toHaveBeenCalledOnce();
    expect(processState.fork).toHaveBeenCalledTimes(expectedForks);
  });

  it("contains sibling services without restarting when the API exits while paused", async () => {
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    const worker = generationWorker();
    const web = generationWorker();
    manager.activeDatabaseStartup = startup;
    manager.worker = {
      process: worker,
      status: "paused",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.web = {
      process: web,
      status: "running",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const generation = await manager.startApi(startup);
    expect(generation).not.toBeNull();
    manager.workerApiGeneration = generation;
    manager.webApiGeneration = generation;
    manager.registeredWorkerGeneration = generation;
    manager.paused = true;
    const revokeAuthority = vi.fn().mockResolvedValue(undefined);
    manager.revokeWorkerGenerationAuthority = revokeAuthority;

    if (processState.child) processState.child.exitCode = 1;
    processState.child?.emit("exit", 1);
    await manager.serviceLifecycleTail;

    expect(manager.api.restartCount).toBe(0);
    expect(manager.api.process).toBeNull();
    expect(manager.worker.process).toBeNull();
    expect(manager.web.process).toBeNull();
    expect(manager.registeredWorkerGeneration).toBeNull();
    expect(revokeAuthority).toHaveBeenCalledWith(generation, startup);
    expect(processState.fork).toHaveBeenCalledOnce();

    const replacementApi = generationWorker();
    const replacementWeb = generationWorker();
    const replacementWorker = generationWorker();
    processState.fork.mockReset();
    processState.fork
      .mockReturnValueOnce(replacementApi)
      .mockReturnValueOnce(replacementWeb)
      .mockReturnValueOnce(replacementWorker);
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.registerWorkerGenerationAuthority = vi.fn().mockImplementation(async (next) => {
      manager.registeredWorkerGeneration = next;
    });

    await manager.resume();

    expect(manager.readyApiGeneration).toBe(manager.apiGeneration);
    expect(manager.web.process).toBe(replacementWeb);
    expect(manager.worker.process).toBe(replacementWorker);
    expect(manager.paused).toBe(false);
    expect(processState.fork).toHaveBeenCalledTimes(3);
  });

  it("continues packaged API identity monitoring while worker execution is paused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    processState.child = generationWorker();
    const originalWeb = generationWorker();
    const originalWorker = generationWorker();
    const generation = await manager.startApi(startup);
    expect(generation).not.toBeNull();
    manager.readyApiGeneration = generation;
    manager.web = {
      process: originalWeb,
      status: "running",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.worker = {
      process: originalWorker,
      status: "paused",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.webApiGeneration = generation;
    manager.workerApiGeneration = generation;
    manager.registeredWorkerGeneration = generation;
    manager.paused = true;
    manager.revokeWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchImpl);

    await manager.runHealthCheck(startup);
    await manager.serviceLifecycleTail;

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(generation?.controller.signal.aborted).toBe(true);
    expect(manager.api.process).toBeNull();
    expect(manager.web.process).toBeNull();
    expect(manager.worker.process).toBeNull();

    const replacementApi = generationWorker();
    const replacementWeb = generationWorker();
    const replacementWorker = generationWorker();
    processState.fork.mockReset();
    processState.fork
      .mockReturnValueOnce(replacementApi)
      .mockReturnValueOnce(replacementWeb)
      .mockReturnValueOnce(replacementWorker);
    manager.waitForApi = vi.fn().mockResolvedValue(true);
    manager.registerWorkerGenerationAuthority = vi.fn().mockImplementation(async (next) => {
      manager.registeredWorkerGeneration = next;
    });

    await manager.resume();

    expect(manager.readyApiGeneration).toBe(manager.apiGeneration);
    expect(manager.web.process).toBe(replacementWeb);
    expect(manager.worker.process).toBe(replacementWorker);
    expect(manager.paused).toBe(false);
  });

  it.each([
    ["explicit lifecycle queued before containment", true],
    ["containment queued before explicit lifecycle", false],
  ])("does not let stale paused-exit cleanup stop a successor: %s", async (_label, lifecycleFirst) => {
    const manager = new ServiceManager() as InstanceType<typeof ServiceManager> & ManagerInternals;
    const startup = {
      ownership: "managed-child" as const,
      dataDir: "/tmp/skytwin-api-error-test/crdb-data",
      generation: 1,
    };
    manager.activeDatabaseStartup = startup;
    manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const originalGeneration = await manager.startApi(startup);
    expect(originalGeneration).not.toBeNull();
    const originalWeb = generationWorker();
    const originalWorker = generationWorker();
    manager.web = {
      process: originalWeb,
      status: "running",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.worker = {
      process: originalWorker,
      status: "paused",
      restartCount: 0,
      failureTimestamps: [],
      external: false,
    };
    manager.webApiGeneration = originalGeneration;
    manager.workerApiGeneration = originalGeneration;
    manager.registeredWorkerGeneration = originalGeneration;
    manager.paused = true;
    manager.revokeWorkerGenerationAuthority = vi.fn().mockResolvedValue(undefined);

    const successorApi = generationWorker();
    const successorWeb = generationWorker();
    const successorWorker = generationWorker();
    const successorGeneration = {
      process: successorApi,
      controller: new AbortController(),
      ingestCredential: "successor",
    };
    manager.stopAllOwned = vi.fn().mockImplementation(async () => {
      manager.web.process = null;
      manager.worker.process = null;
      manager.webApiGeneration = null;
      manager.workerApiGeneration = null;
      manager.registeredWorkerGeneration = null;
    });
    manager.startAllOwned = vi.fn().mockImplementation(async () => {
      manager.api.process = successorApi;
      manager.api.status = "running";
      manager.apiGeneration = successorGeneration;
      manager.readyApiGeneration = successorGeneration;
      manager.web.process = successorWeb;
      manager.web.status = "running";
      manager.worker.process = successorWorker;
      manager.worker.status = "running";
      manager.webApiGeneration = successorGeneration;
      manager.workerApiGeneration = successorGeneration;
      manager.registeredWorkerGeneration = successorGeneration;
      manager.paused = false;
    });

    let stopping: Promise<void>;
    let starting: Promise<void>;
    if (lifecycleFirst) {
      stopping = manager.stopAll();
      starting = manager.startAll();
      if (processState.child) processState.child.exitCode = 1;
      processState.child?.emit("exit", 1);
    } else {
      if (processState.child) processState.child.exitCode = 1;
      processState.child?.emit("exit", 1);
      stopping = manager.stopAll();
      starting = manager.startAll();
    }

    await Promise.all([stopping, starting]);
    await manager.serviceLifecycleTail;

    expect(manager.apiGeneration).toBe(successorGeneration);
    expect(manager.api.process).toBe(successorApi);
    expect(manager.web.process).toBe(successorWeb);
    expect(manager.worker.process).toBe(successorWorker);
    expect(manager.registeredWorkerGeneration).toBe(successorGeneration);
    expect(successorApi.kill).not.toHaveBeenCalled();
    expect(successorWeb.kill).not.toHaveBeenCalled();
    expect(successorWorker.kill).not.toHaveBeenCalled();
  });
});
