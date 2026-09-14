import { LlamaCppTextBackend } from "./llama-cpp-backend.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectManagedActiveModelAsync } from "./managed-model-store.js";
import { isLlamaCppBuildCompatible } from "./runtime-compatibility.js";
import { findFirstPiperModel, PiperTtsBackend } from "./piper-tts-backend.js";
import { detectEmbeddedRuntimes } from "./runtime-detector.js";
import { NullEmbeddedSttPort, type EmbeddedSttPort } from "./stt-port.js";
import { NullEmbeddedTextPort, type EmbeddedTextPort } from "./text-port.js";
import { NullEmbeddedTtsPort, type EmbeddedTtsPort } from "./tts-port.js";
import {
  findFirstWhisperModel,
  WhisperCppSttBackend,
} from "./whisper-cpp-backend.js";

export interface CreatePortOverrides {
  binaryPath?: string;
  modelPath?: string;
}

export async function createEmbeddedTextPort(
  overrides: CreatePortOverrides = {},
): Promise<EmbeddedTextPort> {
  const info = await detectEmbeddedRuntimes();
  const binaryPath = overrides.binaryPath ?? info.llamaCpp.binaryPath;
  if (binaryPath === null || binaryPath === undefined || binaryPath === "") {
    return new NullEmbeddedTextPort();
  }
  // Explicit paths are user-managed and remain a separate, opt-in trust path.
  // Automatic discovery only returns the digest-verified managed artifact.
  const manualPath = overrides.modelPath ?? process.env["SKYTWIN_LLAMA_MODEL"];
  const managedDir =
    info.llamaCpp.modelDir ?? join(homedir(), ".skytwin", "models", "llama");
  const inspected = manualPath
    ? null
    : await inspectManagedActiveModelAsync(managedDir);
  const compatibleManagedPath =
    inspected?.state === "verified" &&
    isLlamaCppBuildCompatible(binaryPath, inspected.model.runtime.minimumBuild)
      ? inspected.path
      : null;
  const modelPath = manualPath ?? compatibleManagedPath;
  if (modelPath === null || modelPath === undefined || modelPath === "") {
    return new NullEmbeddedTextPort();
  }
  return new LlamaCppTextBackend({
    binaryPath,
    modelPath,
    ...(inspected?.state === "verified" && !manualPath
      ? {
          verifiedModel: {
            exactBytes: inspected.model.exactBytes,
            sha256: inspected.model.sha256,
          },
        }
      : {}),
  });
}

export async function createEmbeddedSttPort(
  overrides: CreatePortOverrides = {},
): Promise<EmbeddedSttPort> {
  const info = await detectEmbeddedRuntimes();
  const binaryPath = overrides.binaryPath ?? info.whisper.binaryPath;
  if (binaryPath === null || binaryPath === undefined || binaryPath === "") {
    return new NullEmbeddedSttPort();
  }
  const modelPath =
    overrides.modelPath ??
    process.env["SKYTWIN_WHISPER_MODEL"] ??
    findFirstWhisperModel(info.whisper.modelDir);
  if (modelPath === null || modelPath === undefined || modelPath === "") {
    return new NullEmbeddedSttPort();
  }
  return new WhisperCppSttBackend({ binaryPath, modelPath });
}

/**
 * Resolve an `EmbeddedTtsPort`. Mirrors the STT factory: probe the
 * runtime detector for a `piper` binary (env-var override → PATH
 * lookup), then resolve a voice model (env-var override → first
 * `.onnx`+`.onnx.json` pair in the configured model directory). If
 * either resolves to nothing, return the `NullEmbeddedTtsPort` whose
 * `synthesize()` throws `NotAvailableError` — same contract callers
 * already handle for the STT side.
 */
export async function createEmbeddedTtsPort(
  overrides: CreatePortOverrides = {},
): Promise<EmbeddedTtsPort> {
  const info = await detectEmbeddedRuntimes();
  const binaryPath = overrides.binaryPath ?? info.piper.binaryPath;
  if (binaryPath === null || binaryPath === undefined || binaryPath === "") {
    return new NullEmbeddedTtsPort();
  }
  const modelPath =
    overrides.modelPath ??
    process.env["SKYTWIN_PIPER_MODEL"] ??
    findFirstPiperModel(info.piper.modelDir);
  if (modelPath === null || modelPath === undefined || modelPath === "") {
    return new NullEmbeddedTtsPort();
  }
  return new PiperTtsBackend({ binaryPath, modelPath });
}
