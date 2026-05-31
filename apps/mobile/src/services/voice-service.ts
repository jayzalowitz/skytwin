/**
 * Voice service helpers (#179 mobile voice).
 *
 * The recording lifecycle itself lives inside `VoiceScreen.tsx` via the
 * `useAudioRecorder` hook from `expo-audio` — that hook is the only stable
 * way to drive a single in-flight recording without dropping the hook's
 * internal state on re-render. This module owns the bits that are easy to
 * unit-test in isolation:
 *
 *   - URI → base64 conversion via `expo-file-system`'s `File.base64()`
 *   - The `/api/voice/transcribe` round-trip shape + error mapping
 *
 * Keeping these out of the screen file means the test suite can exercise
 * them with mocked `expo-file-system` + mocked `fetch` without spinning up
 * a React Native renderer.
 */

import { File } from 'expo-file-system';
import type { SkyTwinApiClient } from './api-client';
import { chunkBase64, countChunks, DEFAULT_CHUNK_CHARS } from './voice-chunker';

export interface VoiceTranscriptResult {
  ok: true;
  transcript: string;
  durationBytes: number;
}

export interface VoiceTranscriptError {
  ok: false;
  /**
   * Stable code so callers can branch on cause without parsing free-form
   * messages. `no_audio` covers both "recorder returned no URI" and
   * "file decoded to zero bytes." Microphone-permission denial is handled
   * inside `VoiceScreen` before this layer is reached, so there's no
   * `permission_denied` here.
   */
  code: 'no_audio' | 'read_failed' | 'whisper_unavailable' | 'network' | 'unknown';
  message: string;
}

export type VoiceTranscribeOutcome = VoiceTranscriptResult | VoiceTranscriptError;

/**
 * Convert a recorder-produced file URI to a base64 string. Returns a
 * result object rather than throwing so callers can render the
 * specific error case in the UI.
 *
 * The SDK 55 `File` class handles both `file://` and platform-specific
 * URIs returned by `useAudioRecorder.uri`. An empty / missing URI is a
 * common case — the recorder hook returns `null` before the first
 * recording completes — so we surface that as `no_audio` instead of
 * an unhandled rejection.
 */
export async function audioFileToBase64(
  uri: string | null | undefined,
): Promise<{ ok: true; data: string } | { ok: false; code: 'no_audio' | 'read_failed'; message: string }> {
  if (!uri || uri.length === 0) {
    return { ok: false, code: 'no_audio', message: 'No audio file to upload (the recorder did not produce a URI).' };
  }
  try {
    const file = new File(uri);
    const data = await file.base64();
    if (data.length === 0) {
      return { ok: false, code: 'no_audio', message: 'Audio file is empty.' };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'read_failed',
      message: err instanceof Error ? err.message : 'Failed to read the recorded audio file.',
    };
  }
}

/**
 * End-to-end: take a recorder URI, base64-encode it, POST to
 * `/api/voice/transcribe`, and return a `VoiceTranscribeOutcome` that
 * the UI can render directly. The screen calls exactly this function
 * after the user stops recording — no glue logic inline.
 *
 * `language` is forwarded to whisper-cli unchanged. The API tolerates
 * `undefined`; callers that don't care can omit it.
 */
export async function transcribeRecording(
  client: SkyTwinApiClient,
  userId: string,
  uri: string | null | undefined,
  language?: string,
): Promise<VoiceTranscribeOutcome> {
  const encoded = await audioFileToBase64(uri);
  if (!encoded.ok) {
    return encoded;
  }

  const result = await client.transcribeVoice(userId, encoded.data, language);
  if (result.success) {
    return {
      ok: true,
      transcript: result.data.transcript,
      durationBytes: result.data.durationBytes,
    };
  }

  // Map the API's well-known error shapes to stable codes the UI can
  // branch on. The 503 "whisper-cli not available" is the only one we
  // surface with a distinct message because the recovery action is
  // different (install whisper on the desktop, not "try again").
  return mapTranscribeError(result.statusCode, result.error);
}

/** Shared API-error → stable-code mapping for both upload paths. */
function mapTranscribeError(statusCode: number | undefined, error: string): VoiceTranscriptError {
  if (statusCode === 503) {
    return {
      ok: false,
      code: 'whisper_unavailable',
      message: 'Your paired desktop does not have whisper installed yet.',
    };
  }
  if (statusCode === undefined || statusCode === 0) {
    return { ok: false, code: 'network', message: error };
  }
  return { ok: false, code: 'unknown', message: error };
}

export interface ChunkedUploadProgress {
  /** 0..1 fraction of chunks the server has acknowledged. */
  fraction: number;
  uploadedChunks: number;
  totalChunks: number;
  /** True while a dropped chunk is being retried — UI shows "Connection lost — retrying". */
  retrying: boolean;
}

export interface ChunkedUploadOptions {
  language?: string;
  chunkChars?: number;
  /** Max retries per chunk before giving up. Default 4. */
  maxPerChunkRetries?: number;
  /** Called after each chunk ack + on retry-state changes. */
  onProgress?: (p: ChunkedUploadProgress) => void;
  /** Polled before each chunk; return true to abort (cancel button). */
  isCancelled?: () => boolean;
  /** Injectable backoff sleeper for tests. Default real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Resumable chunked transcription (#386). Splits the base64 recording
 * into ~256KB pieces, opens a server session, uploads each chunk with
 * per-chunk retry (so a cellular drop re-sends only the failed piece,
 * not the whole memo), reports progress, then finalizes to transcribe.
 *
 * Cancellation is cooperative: `isCancelled()` is checked before each
 * chunk; on cancel we best-effort tell the server to drop the session
 * and return a `network`-coded result the UI treats as "aborted".
 */
export async function transcribeRecordingChunked(
  client: SkyTwinApiClient,
  userId: string,
  uri: string | null | undefined,
  options: ChunkedUploadOptions = {},
): Promise<VoiceTranscribeOutcome> {
  const encoded = await audioFileToBase64(uri);
  if (!encoded.ok) return encoded;

  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const maxRetries = options.maxPerChunkRetries ?? 4;
  const sleep = options.sleep ?? realSleep;
  const total = countChunks(encoded.data.length, chunkChars);
  const chunks = chunkBase64(encoded.data, chunkChars);

  const emit = (uploaded: number, retrying: boolean): void => {
    options.onProgress?.({
      fraction: total === 0 ? 1 : uploaded / total,
      uploadedChunks: uploaded,
      totalChunks: total,
      retrying,
    });
  };

  const session = await client.voiceUploadSession(userId, total, options.language);
  if (!session.success) {
    return mapTranscribeError(session.statusCode, session.error);
  }
  const sessionId = session.data.sessionId;

  let uploaded = 0;
  emit(0, false);

  for (const chunk of chunks) {
    if (options.isCancelled?.()) {
      await client.voiceUploadCancel(userId, sessionId).catch(() => undefined);
      return { ok: false, code: 'network', message: 'Upload cancelled.' };
    }

    let attempt = 0;
    // Retry only THIS chunk on failure — exponential backoff, capped.
    for (;;) {
      const ack = await client.voiceUploadChunk(userId, sessionId, chunk.index, chunk.data);
      if (ack.success) {
        uploaded = ack.data.received;
        emit(uploaded, false);
        break;
      }
      attempt += 1;
      if (attempt > maxRetries) {
        await client.voiceUploadCancel(userId, sessionId).catch(() => undefined);
        return mapTranscribeError(ack.statusCode, ack.error);
      }
      emit(uploaded, true);
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
  }

  const finalized = await client.voiceUploadFinalize(userId, sessionId);
  if (finalized.success) {
    return {
      ok: true,
      transcript: finalized.data.transcript,
      durationBytes: finalized.data.durationBytes,
    };
  }
  return mapTranscribeError(finalized.statusCode, finalized.error);
}
