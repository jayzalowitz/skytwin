/**
 * @skytwin/embedded-llm
 *
 * Runtime detection and port interfaces for embedded LLM/STT/TTS binaries
 * (llama.cpp, Whisper-tiny, Piper). The Null* fallback implementations are
 * the production defaults until the actual binaries are installed.
 *
 * See issue #187 for the full spec.
 */

export {
  detectEmbeddedRuntimes,
  type EmbeddedRuntimeInfo,
  type EmbeddedRuntimeEntry,
} from './runtime-detector.js';

export { NotAvailableError } from './errors.js';

export {
  NullEmbeddedTextPort,
  type EmbeddedTextPort,
  type EmbeddedTextCapabilities,
} from './text-port.js';

export {
  NullEmbeddedSttPort,
  type EmbeddedSttPort,
  type EmbeddedSttCapabilities,
} from './stt-port.js';

export {
  NullEmbeddedTtsPort,
  type EmbeddedTtsPort,
  type EmbeddedTtsCapabilities,
} from './tts-port.js';
