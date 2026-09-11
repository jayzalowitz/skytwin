import { describe, expect, it } from "vitest";
import { parseLlamaCppBuild } from "../runtime-compatibility.js";

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
});
