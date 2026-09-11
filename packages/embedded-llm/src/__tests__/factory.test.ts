import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime-detector.js", () => ({ detectEmbeddedRuntimes: vi.fn() }));
vi.mock("../llama-cpp-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../llama-cpp-backend.js")
  >("../llama-cpp-backend.js");
  return { ...actual, findFirstGgufModel: vi.fn() };
});
vi.mock("../managed-model-store.js", () => ({
  inspectManagedActiveModel: vi.fn(),
}));
vi.mock("../runtime-compatibility.js", () => ({
  isLlamaCppBuildCompatible: vi.fn(() => true),
}));
vi.mock("../whisper-cpp-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../whisper-cpp-backend.js")
  >("../whisper-cpp-backend.js");
  return { ...actual, findFirstWhisperModel: vi.fn() };
});

import { createEmbeddedSttPort, createEmbeddedTextPort } from "../factory.js";
import { LlamaCppTextBackend } from "../llama-cpp-backend.js";
import { inspectManagedActiveModel } from "../managed-model-store.js";
import { MODEL_REGISTRY } from "../model-registry.js";
import { isLlamaCppBuildCompatible } from "../runtime-compatibility.js";
import { detectEmbeddedRuntimes } from "../runtime-detector.js";
import { NullEmbeddedSttPort } from "../stt-port.js";
import { NullEmbeddedTextPort } from "../text-port.js";
import {
  findFirstWhisperModel,
  WhisperCppSttBackend,
} from "../whisper-cpp-backend.js";

const mockDetect = vi.mocked(detectEmbeddedRuntimes);
const mockInspectManaged = vi.mocked(inspectManagedActiveModel);
const mockCompatible = vi.mocked(isLlamaCppBuildCompatible);
const mockFindWhisper = vi.mocked(findFirstWhisperModel);

beforeEach(() => {
  vi.resetAllMocks();
  mockInspectManaged.mockReturnValue({ state: "missing" });
  mockCompatible.mockReturnValue(true);
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
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
  });

  it("returns NullEmbeddedTextPort when binary present but no model is resolvable", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-cli",
        modelDir: null,
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
  });

  it("prefers SKYTWIN_LLAMA_MODEL env var over directory scan", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-cli",
        modelDir: "/some/dir",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    process.env["SKYTWIN_LLAMA_MODEL"] = "/env/phi.gguf";
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(LlamaCppTextBackend);
    expect(port.capabilities.modelName).toBe("phi.gguf");
    expect(mockInspectManaged).not.toHaveBeenCalled();
  });

  it("uses only the verified managed artifact when no manual override exists", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-cli",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockInspectManaged.mockReturnValue({
      state: "verified",
      path: "/models/qwen.gguf",
      manifest: {} as never,
      model: MODEL_REGISTRY[0]!,
    });
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(LlamaCppTextBackend);
    expect(port.capabilities.modelName).toBe("qwen.gguf");
    expect(mockInspectManaged).toHaveBeenCalledWith("/models");
  });

  it("respects explicit overrides for binary and model", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: { available: false, binaryPath: null, modelDir: null },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    const port = await createEmbeddedTextPort({
      binaryPath: "/custom/llama",
      modelPath: "/custom/m.gguf",
    });
    expect(port).toBeInstanceOf(LlamaCppTextBackend);
  });

  it("fails closed when a managed artifact meets integrity but llama.cpp is too old", async () => {
    mockDetect.mockResolvedValue({
      llamaCpp: {
        available: true,
        binaryPath: "/usr/bin/llama-cli",
        modelDir: "/models",
      },
      whisper: { available: false, binaryPath: null, modelDir: null },
      piper: { available: false, binaryPath: null, modelDir: null },
    });
    mockInspectManaged.mockReturnValue({
      state: "verified",
      path: "/models/qwen.gguf",
      manifest: {} as never,
      model: MODEL_REGISTRY[0]!,
    });
    mockCompatible.mockReturnValue(false);
    const port = await createEmbeddedTextPort();
    expect(port).toBeInstanceOf(NullEmbeddedTextPort);
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
