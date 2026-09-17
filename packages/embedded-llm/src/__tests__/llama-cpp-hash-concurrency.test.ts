import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hashMock = vi.hoisted(() => vi.fn());
vi.mock("../managed-model-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../managed-model-store.js")>()),
  computeFileHandleSha256: hashMock,
}));

import { LlamaCppTextBackend } from "../llama-cpp-backend.js";

const dirs: string[] = [];

afterEach(() => {
  hashMock.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function childThatCompletes(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from("ok"));
    child.emit("close", 0);
  });
  return child;
}

describe("managed launch hashing", () => {
  it("yields the event loop and serializes full-artifact verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skytwin-hash-concurrency-"));
    dirs.push(dir);
    const modelPath = join(dir, "model.gguf");
    const bytes = Buffer.from("verified model");
    const digest = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(modelPath, bytes);

    const releases: Array<() => void> = [];
    hashMock.mockImplementation(
      () => new Promise<string>((resolve) => releases.push(() => resolve(digest))),
    );
    const spawnProcess = vi.fn(() => childThatCompletes() as never) as never;
    const backend = new LlamaCppTextBackend({
      binaryPath: "/usr/bin/llama-cli",
      modelPath,
      verifiedModel: { exactBytes: bytes.length, sha256: digest },
      spawnProcess,
    });

    const first = backend.generate("first");
    const second = backend.generate("second");
    await vi.waitFor(() => expect(hashMock).toHaveBeenCalledTimes(1));

    let heartbeat = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        heartbeat = true;
        resolve();
      }, 0);
    });
    expect(heartbeat).toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();

    releases.shift()?.();
    await vi.waitFor(() => expect(hashMock).toHaveBeenCalledTimes(2));
    releases.shift()?.();

    await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"]);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});
