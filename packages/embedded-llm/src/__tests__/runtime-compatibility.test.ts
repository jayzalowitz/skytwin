import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLlamaCppBuildCompatible,
  parseLlamaCppBuild,
} from "../runtime-compatibility.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function stderrVersionProbe(version: number, exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "skytwin-llama-version-"));
  dirs.push(dir);
  const fixture = join(dir, "stderr-version.cjs");
  writeFileSync(
    fixture,
    `#!/usr/bin/env node\nprocess.stderr.write("version: ${version} (fixture)\\n"); process.exit(${exitCode});\n`,
  );
  chmodSync(fixture, 0o700);
  return fixture;
}

describe("parseLlamaCppBuild", () => {
  it("parses official build output variants", () => {
    expect(parseLlamaCppBuild("version: 4000 (c02e5ab2)\nbuild: 4000")).toBe(
      4000,
    );
    expect(
      parseLlamaCppBuild("ggml_cuda_init: ready\nversion: 7265 (abc123)"),
    ).toBe(7265);
    expect(parseLlamaCppBuild("llama.cpp b4123")).toBe(4123);
  });
  it("fails closed on unknown output", () => {
    expect(parseLlamaCppBuild("llama-cli unknown")).toBeNull();
    expect(parseLlamaCppBuild("version: 0 (unknown)")).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "accepts a successful runtime that reports its version only on stderr",
    () => {
      const fixture = stderrVersionProbe(9_080);
      expect(isLlamaCppBuildCompatible(fixture, 9_080)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects valid version output from a runtime that exits unsuccessfully",
    () => {
      const fixture = stderrVersionProbe(9_080, 7);
      expect(isLlamaCppBuildCompatible(fixture, 9_080)).toBe(false);
    },
  );
});
