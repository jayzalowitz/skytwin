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
    external: boolean;
  };
  worker: {
    process: ChildProcess | null;
    status: string;
    restartCount: number;
    failureTimestamps: number[];
    external: boolean;
  };
  apiGeneration: ApiGenerationForTest | null;
  getResourcePath(): string;
  ensureEmbeddedRoot(): Promise<string>;
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
});
