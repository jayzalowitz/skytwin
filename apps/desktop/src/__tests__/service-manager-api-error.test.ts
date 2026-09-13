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
    manager.startWeb = vi.fn().mockResolvedValue(undefined);
    manager.startWorker = vi.fn().mockResolvedValue(undefined);
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
    expect(manager.stopDataServicesOwned).toHaveBeenCalledTimes(3);
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

    expect(manager.scheduleApiRestart).toHaveBeenCalledWith(startup, "child process error");
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
    const generation = await manager.startApi(startup);
    expect(generation).not.toBeNull();
    manager.readyApiGeneration = generation;
    manager.paused = true;
    manager.stopDataServicesOwned = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", fetchImpl);

    await manager.runHealthCheck(startup);
    await vi.waitFor(() => expect(manager.stopDataServicesOwned).toHaveBeenCalledOnce());

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(generation?.controller.signal.aborted).toBe(true);
  });
});
