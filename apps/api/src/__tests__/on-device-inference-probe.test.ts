import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOnDeviceProbeArguments } from "../bin/verify-on-device-inference.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; binary: string; model: string } {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "on-device-probe-test-")),
  );
  roots.push(root);
  const binary = join(root, "llama-cli");
  const model = join(root, "model.gguf");
  writeFileSync(binary, "binary");
  writeFileSync(model, "model");
  chmodSync(binary, 0o700);
  return { root, binary, model };
}

describe("packaged on-device inference probe arguments", () => {
  it("accepts only canonical private files and a 32-byte nonce", () => {
    const { binary, model } = fixture();
    expect(
      parseOnDeviceProbeArguments([
        "--binary",
        binary,
        "--model",
        model,
        "--nonce",
        "a".repeat(64),
      ]),
    ).toEqual({ binaryPath: binary, modelPath: model, nonce: "a".repeat(64) });
    expect(() =>
      parseOnDeviceProbeArguments([
        "--binary",
        binary,
        "--model",
        model,
        "--nonce",
        "short",
      ]),
    ).toThrow(/nonce/);
  });

  it("rejects a symlinked model and reordered or extra arguments", () => {
    const { root, binary, model } = fixture();
    const link = join(root, "linked.gguf");
    symlinkSync(model, link);
    expect(() =>
      parseOnDeviceProbeArguments([
        "--binary",
        binary,
        "--model",
        link,
        "--nonce",
        "a".repeat(64),
      ]),
    ).toThrow(/non-symlink/);
    expect(() =>
      parseOnDeviceProbeArguments([
        "--model",
        model,
        "--binary",
        binary,
        "--nonce",
        "a".repeat(64),
      ]),
    ).toThrow(/exactly/);
  });
});
