import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../runtime-detector.js", () => ({ detectEmbeddedRuntimes: vi.fn() }));
vi.mock("../llama-cpp-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../llama-cpp-backend.js")
  >("../llama-cpp-backend.js");
  return { ...actual, findFirstGgufModel: vi.fn() };
});
vi.mock("../managed-model-store.js", () => ({
  inspectManagedActiveModelAsync: vi.fn(),
  computeFileSha256Async: vi.fn(async () => "c".repeat(64)),
}));
vi.mock("../runtime-compatibility.js", () => ({
  detectLlamaCppBuild: vi.fn(() => 5000),
}));
vi.mock("../whisper-cpp-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../whisper-cpp-backend.js")
  >("../whisper-cpp-backend.js");
  return { ...actual, findFirstWhisperModel: vi.fn() };
});

import { createEmbeddedSttPort, createEmbeddedTextPort } from "../factory.js";
import { LlamaCppTextBackend } from "../llama-cpp-backend.js";
import { inspectManagedActiveModelAsync } from "../managed-model-store.js";
import { MODEL_REGISTRY } from "../model-registry.js";
import { detectLlamaCppBuild } from "../runtime-compatibility.js";
import { detectEmbeddedRuntimes } from "../runtime-detector.js";
import { NullEmbeddedSttPort } from "../stt-port.js";
import { NullEmbeddedTextPort } from "../text-port.js";
import {
  findFirstWhisperModel,
  WhisperCppSttBackend,
} from "../whisper-cpp-backend.js";

const mockDetect = vi.mocked(detectEmbeddedRuntimes);
const mockInspectManaged = vi.mocked(inspectManagedActiveModelAsync);
const mockRuntimeBuild = vi.mocked(detectLlamaCppBuild);
const mockFindWhisper = vi.mocked(findFirstWhisperModel);

beforeEach(() => {
  vi.resetAllMocks();
  mockInspectManaged.mockResolvedValue({ state: "missing" });
  mockRuntimeBuild.mockReturnValue(5000);
  delete process.env["SKYTWIN_LLAMA_MODEL"];
  delete process.env["SKYTWIN_WHISPER_MODEL"];
});
afterEach(() => {
  delete process.env["SKYTWIN_LLAMA_MODEL"];
  delete process.env["SKYTWIN_WHISPER_MODEL"];
});

describe("createEmbeddedTextPort", () => {
  it("returns NullEmbeddedTextPort when llama binary is not detected", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockInspectManaged.mockResolvedValue({
      state: "verified",
      path: "/models/qwen.gguf",
      manifest: {} as never,
      model: MODEL_REGISTRY[0]!,
    });
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
    expect(port.capabilities.unavailableReason).toBe("runtime_binary_missing");
  });

  it("returns NullEmbeddedTextPort when binary present but no model is resolvable", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: null,
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
    expect(port.capabilities.unavailableReason).toBe("artifact_missing");
  });

  it("prefers SKYTWIN_LLAMA_MODEL env var over directory scan", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: "/some/dir",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const directory = mkdtempSync(join(tmpdir(), "skytwin-factory-"));
    process.env["SKYTWIN_LLAMA_MODEL"] = join(directory, "phi.gguf");
    writeFileSync(process.env["SKYTWIN_LLAMA_MODEL"], "test");
    try {
      const port = await createEmbeddedTextPort();
      expect(port).toBeInstanceOf(LlamaCppTextBackend);
      expect(port.capabilities.modelName).toBe("phi.gguf");
      expect(port.capabilities.artifactSha256).toBe("c".repeat(64));
      expect(mockInspectManaged).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses only the verified managed artifact when no manual override exists", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockInspectManaged.mockResolvedValue({
      state: "verified",
      path: "/models/qwen.gguf",
      manifest: {} as never,
      model: MODEL_REGISTRY[0]!,
    });
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(LlamaCppTextBackend);
    expect(port.capabilities.modelName).toBe("qwen.gguf");
    expect(port.capabilities.artifactSha256).toBe(MODEL_REGISTRY[0]!.sha256);
    expect(port.capabilities.runtimeVersion).toBe("llama.cpp-b5000");
    expect(port.capabilities.workflowAuthoringQualified).toBe(false);
    expect(mockInspectManaged).toHaveBeenCalledWith("/models");
  });

  it("exposes the managed model workflow-authoring qualification", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockRuntimeBuild.mockReturnValue(9080);
    const qualified = {
      ...MODEL_REGISTRY[0]!,
      workflowAuthoring: {
        ...MODEL_REGISTRY[0]!.workflowAuthoring,
        status: "qualified" as const,
        evaluatedRuntimeBuild: 9080,
      },
    };
    mockInspectManaged.mockResolvedValue({
      state: "verified",
      path: "/models/qwen3.gguf",
      manifest: {} as never,
      model: qualified,
    });

    const port = await createEmbeddedTextPort();

    expect(port.capabilities.workflowAuthoringQualified).toBe(true);
  });

  it("does not extend workflow qualification to an unevaluated runtime build", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockRuntimeBuild.mockReturnValue(9081);
    const qualified = {
      ...MODEL_REGISTRY[0]!,
      workflowAuthoring: {
        ...MODEL_REGISTRY[0]!.workflowAuthoring,
        status: "qualified" as const,
        evaluatedRuntimeBuild: 9080,
      },
    };
    mockInspectManaged.mockResolvedValue({
      state: "verified",
      path: "/models/qwen3.gguf",
      manifest: {} as never,
      model: qualified,
    });

    const port = await createEmbeddedTextPort();

    expect(port.capabilities.available).toBe(true);
    expect(port.capabilities.workflowAuthoringQualified).toBe(false);
  });

  it("respects explicit overrides for binary and model", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const directory = mkdtempSync(join(tmpdir(), "skytwin-factory-"));
    const modelPath = join(directory, "m.gguf");
    writeFileSync(modelPath, "test");
    try {
      const port = await createEmbeddedTextPort({
        binaryPath: "/custom/llama",
        modelPath,
      });
      expect(port).toBeInstanceOf(LlamaCppTextBackend);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the sibling non-interactive generation binary for a llama-cli override", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const directory = mkdtempSync(join(tmpdir(), "skytwin-factory-"));
    const cliPath = join(directory, "llama-cli");
    const completionPath = join(directory, "llama-completion");
    const modelPath = join(directory, "m.gguf");
    writeFileSync(cliPath, "");
    writeFileSync(completionPath, "");
    writeFileSync(modelPath, "test");
    try {
      const port = await createEmbeddedTextPort({ binaryPath: cliPath, modelPath });
      expect(port).toBeInstanceOf(LlamaCppTextBackend);
      expect(mockRuntimeBuild).toHaveBeenCalledWith(completionPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a llama-cli override has no completion companion", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const directory = mkdtempSync(join(tmpdir(), "skytwin-factory-"));
    const cliPath = join(directory, "llama-cli");
    const modelPath = join(directory, "m.gguf");
    writeFileSync(cliPath, "");
    writeFileSync(modelPath, "test");
    try {
      const port = await createEmbeddedTextPort({ binaryPath: cliPath, modelPath });
      expect(port).toBeInstanceOf(NullEmbeddedTextPort);
      expect(port.capabilities.unavailableReason).toBe("runtime_binary_missing");
      expect(mockRuntimeBuild).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a missing explicit model path as an artifact problem", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: true, binaryPath: "/usr/bin/llama-completion", modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });

    const port = await createEmbeddedTextPort({ modelPath: "/missing/skytwin.gguf" });

    expect(port.capabilities).toMatchObject({
      available: false,
      unavailableReason: "artifact_missing",
    });
  });

  it("fails closed when a managed artifact meets integrity but llama.cpp is too old", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockInspectManaged.mockResolvedValue({
      state: "verified",
      path: "/models/qwen.gguf",
      manifest: {} as never,
      model: MODEL_REGISTRY[0]!,
    });
    mockRuntimeBuild.mockReturnValue(3_999);
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
    expect(port.capabilities.unavailableReason).toBe("runtime_incompatible");
  });

  it("reports an invalid managed artifact separately from runtime readiness", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-completion",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockInspectManaged.mockResolvedValue({
      state: "invalid",
      reason: "artifact_digest_mismatch",
    });

    const port = await createEmbeddedTextPort();

    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
    expect(port.capabilities.unavailableReason).toBe("artifact_invalid");
    expect(mockRuntimeBuild).not.toHaveBeenCalled();
  });
});

describe("createEmbeddedSttPort", () => {
  it("returns NullEmbeddedSttPort when whisper binary is not detected", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const port = await createEmbeddedSttPort();
    expect(port).toBeInstanceOf(NullEmbeddedSttPort);
  });

  it("returns Null port when binary present but no model is resolvable", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: {
        available: true,
        binaryPath: "/usr/bin/whisper-cli",
        modelDir: null,
      },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockFindWhisper.mockReturnValue(null);
    const port = await createEmbeddedSttPort();
    expect(port).toBeInstanceOf(NullEmbeddedSttPort);
  });

  it("builds WhisperCppSttBackend with env-var model override", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: {
        available: true,
        binaryPath: "/usr/bin/whisper-cli",
        modelDir: null,
      },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    process.env["SKYTWIN_WHISPER_MODEL"] = "/env/ggml-tiny.bin";
    const port = await createEmbeddedSttPort();
    expect(port).toBeInstanceOf(WhisperCppSttBackend);
    expect(mockFindWhisper).not.toHaveBeenCalled();
  });
});
