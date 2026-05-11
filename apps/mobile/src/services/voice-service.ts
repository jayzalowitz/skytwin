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
import { SkyTwinApiClient } from './api-client';

export interface VoiceTranscriptResult {
  ok: true;
  transcript: string;
  durationBytes: number;
}

export interface VoiceTranscriptError {
  ok: false;
  /** Stable code so callers can branch on `permission_denied` vs. generic. */
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
  const statusCode = result.statusCode;
  if (statusCode === 503) {
    return {
      ok: false,
      code: 'whisper_unavailable',
      message: 'Your paired desktop does not have whisper installed yet.',
    };
  }
  if (statusCode === undefined || statusCode === 0) {
    return { ok: false, code: 'network', message: result.error };
  }
  return { ok: false, code: 'unknown', message: result.error };
}
