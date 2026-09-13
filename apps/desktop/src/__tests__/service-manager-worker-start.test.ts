import type {
  ChildProcess,
  fork as forkType,
  spawn as spawnType,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processState = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/skytwin-worker-start-test",
    getAppPath: () => "/tmp/skytwin-worker-start-test",
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
      getDataDir: () => "/tmp/skytwin-worker-start-test/crdb-data",
      isManagedStartCurrent: vi.fn().mockReturnValue(true),
      setAuthorityLossHandler: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { ServiceManager } = await import("../service-manager.js");

interface TestStartup {
  ownership: "managed-child";
  dataDir: string;
  generation: number;
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

interface ManagerInternals {
  activeDatabaseStartup: TestStartup | null;
  api: {
    process: ChildProcess | null;
    status: string;
    external: boolean;
  };
  worker: {
    process: ChildProcess | null;
    status: string;
    restartCount: number;
    failureTimestamps: number[];
    external: boolean;
  };
  apiGeneration: TestApiGeneration | null;
  registeredWorkerGeneration: TestApiGeneration | null;
  paused: boolean;
  getResourcePath(): string;
  ensureEmbeddedRoot(): Promise<string>;
  startWorker(
    startup: TestStartup,
    generation: TestApiGeneration,
  ): Promise<void>;
  resume(): Promise<void>;
}

function child(pid: number): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  Object.assign(process, {
    pid,
    exitCode: null,
    signalCode: null,
    connected: true,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return process;
}

function authorize(manager: ManagerInternals): {
  startup: TestStartup;
  generation: TestApiGeneration;
} {
  const startup: TestStartup = {
    ownership: "managed-child",
    dataDir: "/tmp/skytwin-worker-start-test/crdb-data",
    generation: 1,
  };
  const apiProcess = child(8100);
  const generation: TestApiGeneration = {
    generation: 1,
    process: apiProcess,
    instanceCapability: "a".repeat(64),
    ingestCredential: "b".repeat(64),
    workerAuthorityId: "93c89fcc-2fa4-49a4-8510-171193973983",
    workerAuthoritySecret: "c".repeat(64),
    controller: new AbortController(),
  };
  manager.activeDatabaseStartup = startup;
  manager.api.process = apiProcess;
  manager.api.external = false;
  manager.apiGeneration = generation;
  manager.registeredWorkerGeneration = generation;
  manager.paused = false;
  manager.getResourcePath = vi.fn().mockReturnValue("/tmp/embedded");
  return { startup, generation };
}

describe("ServiceManager worker start serialization", () => {
  const previousSessionSecret = process.env["SESSION_SECRET"];

  beforeEach(() => {
    process.env["SESSION_SECRET"] = "d".repeat(64);
    processState.fork.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (previousSessionSecret === undefined) {
      delete process.env["SESSION_SECRET"];
    } else {
      process.env["SESSION_SECRET"] = previousSessionSecret;
    }
  });

  it("coalesces hostile concurrent starts through child assignment", async () => {
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const { startup, generation } = authorize(manager);
    const worker = child(8200);
    processState.fork.mockReturnValue(worker);
    let releaseBundle: ((path: string) => void) | undefined;
    manager.ensureEmbeddedRoot = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseBundle = resolve;
        }),
    );

    const first = manager.startWorker(startup, generation);
    const second = manager.startWorker(startup, generation);
    expect(first).toBe(second);
    expect(processState.fork).not.toHaveBeenCalled();

    releaseBundle?.("/tmp/embedded");
    await Promise.all([first, second]);

    expect(processState.fork).toHaveBeenCalledOnce();
    expect(manager.worker.process).toBe(worker);
    expect(manager.worker.status).toBe("running");
  });

  it("publishes the start latch before a synchronous status listener reenters", async () => {
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const { startup, generation } = authorize(manager);
    const worker = child(8206);
    processState.fork.mockReturnValue(worker);
    let releaseBundle: ((path: string) => void) | undefined;
    manager.ensureEmbeddedRoot = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseBundle = resolve;
        }),
    );
    let reentrant: Promise<void> | undefined;
    manager.setStatusHandler((status) => {
      if (status.worker === "starting" && !reentrant) {
        reentrant = manager.startWorker(startup, generation);
      }
    });

    const first = manager.startWorker(startup, generation);

    expect(reentrant).toBe(first);
    expect(manager.ensureEmbeddedRoot).toHaveBeenCalledOnce();
    expect(processState.fork).not.toHaveBeenCalled();

    releaseBundle?.("/tmp/embedded");
    await Promise.all([first, reentrant]);

    expect(manager.ensureEmbeddedRoot).toHaveBeenCalledOnce();
    expect(processState.fork).toHaveBeenCalledOnce();
    expect(manager.worker.process).toBe(worker);
    expect(manager.worker.status).toBe("running");
  });

  it("coalesces a delayed restart that races an in-flight resume", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const { startup, generation } = authorize(manager);
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const firstWorker = child(8201);
    const resumeWorker = child(8202);
    processState.fork
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(resumeWorker);

    await manager.startWorker(startup, generation);
    Object.assign(firstWorker, { exitCode: 1 });
    firstWorker.emit("exit", 1, null);

    let releaseBundle: ((path: string) => void) | undefined;
    manager.ensureEmbeddedRoot = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseBundle = resolve;
        }),
    );
    const resuming = manager.resume();
    await vi.waitFor(() =>
      expect(manager.ensureEmbeddedRoot).toHaveBeenCalledOnce(),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(processState.fork).toHaveBeenCalledOnce();

    releaseBundle?.("/tmp/embedded");
    await resuming;
    await Promise.resolve();

    expect(processState.fork).toHaveBeenCalledTimes(2);
    expect(manager.worker.process).toBe(resumeWorker);
    expect(manager.worker.status).toBe("running");
    expect(info).not.toHaveBeenCalledWith(
      "[worker] Delayed restart skipped because a worker child is already retained.",
    );
    expect(error).not.toHaveBeenCalledWith(
      "[worker] Delayed restart failed:",
      expect.anything(),
    );
  });

  it("classifies a delayed restart after resume as an expected retained child", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const { startup, generation } = authorize(manager);
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const firstWorker = child(8203);
    const resumeWorker = child(8204);
    processState.fork
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(resumeWorker);

    await manager.startWorker(startup, generation);
    Object.assign(firstWorker, { exitCode: 1 });
    firstWorker.emit("exit", 1, null);
    await manager.resume();
    expect(manager.worker.process).toBe(resumeWorker);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(processState.fork).toHaveBeenCalledTimes(2);
    expect(manager.worker.process).toBe(resumeWorker);
    expect(manager.worker.status).toBe("running");
    expect(info).toHaveBeenCalledWith(
      "[worker] Delayed restart skipped because a worker child is already retained.",
    );
    expect(error).not.toHaveBeenCalledWith(
      "[worker] Delayed restart failed:",
      expect.anything(),
    );
  });

  it("catches and surfaces an unexpected delayed restart failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const manager = new ServiceManager() as InstanceType<
      typeof ServiceManager
    > &
      ManagerInternals;
    const { startup, generation } = authorize(manager);
    manager.ensureEmbeddedRoot = vi.fn().mockResolvedValue("/tmp/embedded");
    const firstWorker = child(8205);
    processState.fork.mockReturnValueOnce(firstWorker);

    await manager.startWorker(startup, generation);
    manager.ensureEmbeddedRoot = vi
      .fn()
      .mockRejectedValue(new Error("worker bundle unavailable"));
    Object.assign(firstWorker, { exitCode: 1 });
    firstWorker.emit("exit", 1, null);

    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith(
      "[worker] Delayed restart failed:",
      expect.objectContaining({ message: "worker bundle unavailable" }),
    );
    expect(manager.worker.status).toBe("error");
    expect(manager.worker.process).toBeNull();
  });
});
