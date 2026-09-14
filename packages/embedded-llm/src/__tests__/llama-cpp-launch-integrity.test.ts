import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlamaCppTextBackend } from "../llama-cpp-backend.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("managed llama.cpp launch boundary", () => {
  it("kills the child when the verified model path is swapped during spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skytwin-launch-integrity-"));
    dirs.push(dir);
    const modelPath = join(dir, "model.gguf");
    const replacement = join(dir, "replacement.gguf");
    const bytes = Buffer.from("verified model");
    writeFileSync(modelPath, bytes);
    writeFileSync(replacement, Buffer.from("malicious model"));
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const port = new LlamaCppTextBackend({
      binaryPath: "/usr/bin/llama-cli",
      modelPath,
      verifiedModel: {
        exactBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      spawnProcess: vi.fn(() => {
        rmSync(modelPath);
        renameSync(replacement, modelPath);
        return child as never;
      }) as never,
    });

    await expect(port.generate("hello")).rejects.toThrow(
      "changed at the runtime launch boundary",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills the child when the verified model is modified in place during spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skytwin-launch-integrity-"));
    dirs.push(dir);
    const modelPath = join(dir, "model.gguf");
    const bytes = Buffer.from("verified model");
    writeFileSync(modelPath, bytes);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const port = new LlamaCppTextBackend({
      binaryPath: "/usr/bin/llama-cli",
      modelPath,
      verifiedModel: {
        exactBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      spawnProcess: vi.fn(() => {
        writeFileSync(modelPath, Buffer.from("modified model"));
        return child as never;
      }) as never,
    });

    await expect(port.generate("hello")).rejects.toThrow(
      "changed at the runtime launch boundary",
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
