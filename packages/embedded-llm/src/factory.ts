import {
  findFirstGgufModel,
  LlamaCppTextBackend,
} from './llama-cpp-backend.js';
import {
  findFirstPiperModel,
  PiperTtsBackend,
} from './piper-tts-backend.js';
import { detectEmbeddedRuntimes } from './runtime-detector.js';
import { NullEmbeddedSttPort, type EmbeddedSttPort } from './stt-port.js';
import { NullEmbeddedTextPort, type EmbeddedTextPort } from './text-port.js';
import { NullEmbeddedTtsPort, type EmbeddedTtsPort } from './tts-port.js';
import {
  findFirstWhisperModel,
  WhisperCppSttBackend,
} from './whisper-cpp-backend.js';

export interface CreatePortOverrides {
  binaryPath?: string;
  modelPath?: string;
}

export async function createEmbeddedTextPort(
  overrides: CreatePortOverrides = {},
): Promise<EmbeddedTextPort> {
  const info = await detectEmbeddedRuntimes();
  const binaryPath = overrides.binaryPath ?? info.llamaCpp.binaryPath;
  if (binaryPath === null || binaryPath === undefined || binaryPath === '') {
    return new NullEmbeddedTextPort();
  }
  const modelPath =
    overrides.modelPath ??
    process.env['SKYTWIN_LLAMA_MODEL'] ??
    findFirstGgufModel(info.llamaCpp.modelDir);
  if (modelPath === null || modelPath === undefined || modelPath === '') {
    return new NullEmbeddedTextPort();
  }
  return new LlamaCppTextBackend({ binaryPath, modelPath });
}

export async function createEmbeddedSttPort(
  overrides: CreatePortOverrides = {},
): Promise<EmbeddedSttPort> {
  const info = await detectEmbeddedRuntimes();
  const binaryPath = overrides.binaryPath ?? info.whisper.binaryPath;
  if (binaryPath === null || binaryPath === undefined || binaryPath === '') {
    return new NullEmbeddedSttPort();
  }
  const modelPath =
    overrides.modelPath ??
    process.env['SKYTWIN_WHISPER_MODEL'] ??
    findFirstWhisperModel(info.whisper.modelDir);
  if (modelPath === null || modelPath === undefined || modelPath === '') {
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
  if (binaryPath === null || binaryPath === undefined || binaryPath === '') {
    return new NullEmbeddedTtsPort();
  }
  const modelPath =
    overrides.modelPath ??
    process.env['SKYTWIN_PIPER_MODEL'] ??
    findFirstPiperModel(info.piper.modelDir);
  if (modelPath === null || modelPath === undefined || modelPath === '') {
    return new NullEmbeddedTtsPort();
  }
  return new PiperTtsBackend({ binaryPath, modelPath });
}
