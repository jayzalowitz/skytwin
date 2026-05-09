import {
  findFirstGgufModel,
  LlamaCppTextBackend,
} from './llama-cpp-backend.js';
import { detectEmbeddedRuntimes } from './runtime-detector.js';
import { NullEmbeddedSttPort, type EmbeddedSttPort } from './stt-port.js';
import { NullEmbeddedTextPort, type EmbeddedTextPort } from './text-port.js';
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
