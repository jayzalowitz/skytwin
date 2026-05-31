import { Router } from 'express';
import {
  createEmbeddedSttPort,
  createEmbeddedTtsPort,
  type EmbeddedSttPort,
  type EmbeddedTtsPort,
} from '@skytwin/embedded-llm';
import { createLogger } from '@skytwin/core';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';
import { UploadSessionStore } from '../lib/upload-session.js';

const log = createLogger('api:voice');

/**
 * Voice routes (#194 Child 4 + #187 AC#3 + AC#4 consumer).
 *
 *   GET  /api/voice/capabilities/:userId  — does this server have whisper / piper?
 *   POST /api/voice/transcribe           — body: { userId, audioBase64, language? }
 *   POST /api/voice/synthesize           — body: { userId, text, voice? }
 *
 * Backed by `createEmbeddedSttPort()` + `createEmbeddedTtsPort()` from
 * `@skytwin/embedded-llm`. Each returns its `Null*` fallback when the
 * corresponding binary isn't installed — those throw `NotAvailableError`
 * on use, which we surface as 503 so the client can fall back to a
 * manual transcript / silent text rendering.
 *
 * Why both ports live in this router: the same backend serves desktop
 * voice-first (#194 Child 4) and mobile voice (#179). Both clients
 * POST here; one place to install/upgrade the binaries and models.
 */

let cachedSttPort: Promise<EmbeddedSttPort> | null = null;
let cachedTtsPort: Promise<EmbeddedTtsPort> | null = null;

function getSttPort(): Promise<EmbeddedSttPort> {
  if (cachedSttPort === null) cachedSttPort = createEmbeddedSttPort();
  return cachedSttPort;
}

function getTtsPort(): Promise<EmbeddedTtsPort> {
  if (cachedTtsPort === null) cachedTtsPort = createEmbeddedTtsPort();
  return cachedTtsPort;
}

/**
 * Test helper — clears the cached ports so a beforeEach can swap out
 * `createEmbeddedSttPort` / `createEmbeddedTtsPort` mocks between
 * cases. Production callers never need this; the ports are
 * intentionally cached for hot-path latency.
 */
export function _resetVoicePortCache(): void {
  cachedSttPort = null;
  cachedTtsPort = null;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB, ~10 minutes of WAV
const MAX_TTS_TEXT_LENGTH = 8000; // Mirror PiperTtsBackend's internal ceiling.

// One shared session store per router instance backs the resumable
// chunked-upload endpoints (#386). In-memory + TTL-swept; ephemeral by
// design (see upload-session.ts). Exposed via the factory's options so
// tests can inject a clock.
export function createVoiceRouter(
  opts: { uploadStore?: UploadSessionStore } = {},
): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  const uploadStore = opts.uploadStore ?? new UploadSessionStore();

  /**
   * Shared transcription tail used by both the single-shot
   * `/transcribe` and the chunked `/upload/finalize` paths. Takes an
   * already-validated base64 string, decodes, runs whisper, returns the
   * transcript JSON or writes the appropriate error status.
   */
  async function runTranscription(
    res: import('express').Response,
    userId: string,
    audioBase64: string,
    language: unknown,
  ): Promise<void> {
    if (audioBase64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3)) {
      res.status(413).json({ error: 'audio too large (max 25MB)' });
      return;
    }
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0) {
      res.status(400).json({ error: 'audio decoded to zero bytes' });
      return;
    }
    const port = await getSttPort();
    if (!port.capabilities.available) {
      res.status(503).json({
        error: 'whisper-cli not available on this server',
        hint: 'install whisper.cpp and a ggml model, or set SKYTWIN_WHISPER_BIN + SKYTWIN_WHISPER_MODEL',
      });
      return;
    }
    const transcribeOpts: { language?: string } = {};
    if (typeof language === 'string' && language.length > 0) {
      transcribeOpts.language = language;
    }
    const transcript = await port.transcribe(audio, transcribeOpts);
    log.info('Transcribed audio', { userId, bytes: audio.length, chars: transcript.length });
    res.json({ transcript, durationBytes: audio.length });
  }

  router.get('/capabilities/:userId', async (_req, res, next) => {
    try {
      const [stt, tts] = await Promise.all([getSttPort(), getTtsPort()]);
      res.json({
        // Legacy STT-shaped fields preserved for clients written before
        // TTS landed. New clients should prefer the nested objects.
        available: stt.capabilities.available,
        supportedFormats: stt.capabilities.supportedFormats,
        stt: {
          available: stt.capabilities.available,
          supportedFormats: stt.capabilities.supportedFormats,
        },
        tts: {
          available: tts.capabilities.available,
          voices: tts.capabilities.voices,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/transcribe', async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const audioBase64 = body['audioBase64'];
      const language = body['language'];

      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
        res.status(400).json({ error: 'audioBase64 required' });
        return;
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) {
        res.status(400).json({ error: 'audioBase64 must be valid base64' });
        return;
      }
      await runTranscription(res, userId, audioBase64, language);
    } catch (err) {
      next(err);
    }
  });

  // ---- Resumable chunked upload (#386) ----
  //
  // For flaky-cellular clients: open a session, push base64 chunks in
  // any order (retrying individual chunks on drop), then finalize to
  // transcribe. The single-shot /transcribe above stays for small
  // clips + backward compatibility.

  router.post('/upload/session', (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const totalChunks = body['totalChunks'];
      const language = body['language'];
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof totalChunks !== 'number') {
        res.status(400).json({ error: 'totalChunks (number) required' });
        return;
      }
      const meta: { userId: string; totalChunks: number; language?: string } = {
        userId,
        totalChunks,
      };
      if (typeof language === 'string' && language.length > 0) meta.language = language;
      const result = uploadStore.open(meta);
      if (!result.ok) {
        res.status(400).json({ error: result.message });
        return;
      }
      res.json({ sessionId: result.sessionId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/upload/chunk', (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const sessionId = body['sessionId'];
      const index = body['index'];
      const chunkBase64 = body['chunkBase64'];
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        res.status(400).json({ error: 'sessionId required' });
        return;
      }
      if (typeof index !== 'number') {
        res.status(400).json({ error: 'index (number) required' });
        return;
      }
      if (typeof chunkBase64 !== 'string') {
        res.status(400).json({ error: 'chunkBase64 required' });
        return;
      }
      const result = uploadStore.addChunk(sessionId, userId, index, chunkBase64);
      if (!result.ok) {
        // no_session ⇒ 404 (likely TTL-expired); the rest are 400.
        res.status(result.code === 'no_session' ? 404 : 400).json({ error: result.message });
        return;
      }
      res.json(result.ack);
    } catch (err) {
      next(err);
    }
  });

  router.post('/upload/finalize', async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const sessionId = body['sessionId'];
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        res.status(400).json({ error: 'sessionId required' });
        return;
      }
      const result = uploadStore.finalize(sessionId, userId);
      if (!result.ok) {
        if (result.code === 'incomplete') {
          res.status(409).json({ error: result.message, missing: result.missing });
          return;
        }
        res.status(404).json({ error: result.message });
        return;
      }
      await runTranscription(res, userId, result.base64, result.meta.language);
    } catch (err) {
      next(err);
    }
  });

  router.post('/upload/cancel', (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const sessionId = body['sessionId'];
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        res.status(400).json({ error: 'sessionId required' });
        return;
      }
      const cancelled = uploadStore.cancel(sessionId, userId);
      res.json({ cancelled });
    } catch (err) {
      next(err);
    }
  });

  /**
   * #187 AC#4 consumer: synthesize spoken audio from text using Piper.
   *
   * Body: `{ userId: string, text: string, voice?: string }`.
   * Response: `{ audioBase64: string, audioBytes: number, voice: string }`
   * — base64 instead of binary so it goes through the same JSON
   * envelope the rest of the API uses (the mobile client + the web
   * dashboard both decode base64 → Blob/audio element). `audioBytes`
   * is the WAV byte count; we deliberately did not name it
   * `durationBytes` (which would imply seconds) since this is a new
   * endpoint with no compat concern — Copilot caught the confusion
   * with the existing transcribe response on PR #255.
   *
   * 503 when the Null port is in play (no piper binary). Same hint
   * shape as the transcribe path so clients can surface a uniform
   * "install whisper / piper" message in the embedded-llm card.
   */
  router.post('/synthesize', async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const text = body['text'];
      const voice = body['voice'];

      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (typeof text !== 'string' || text.length === 0) {
        res.status(400).json({ error: 'text required' });
        return;
      }
      if (text.length > MAX_TTS_TEXT_LENGTH) {
        res.status(413).json({ error: `text too long (max ${MAX_TTS_TEXT_LENGTH} chars)` });
        return;
      }

      const port = await getTtsPort();
      if (!port.capabilities.available) {
        res.status(503).json({
          error: 'piper not available on this server',
          hint: 'install piper-tts and an .onnx voice model, or set SKYTWIN_PIPER_BIN + SKYTWIN_PIPER_MODEL',
        });
        return;
      }

      const opts: { voice?: string } = {};
      if (typeof voice === 'string' && voice.length > 0) opts.voice = voice;
      const wav = await port.synthesize(text, opts);
      log.info('Synthesized audio', {
        userId,
        chars: text.length,
        bytes: wav.length,
        voice: opts.voice ?? port.capabilities.voices[0],
      });
      res.json({
        audioBase64: wav.toString('base64'),
        audioBytes: wav.length,
        voice: opts.voice ?? port.capabilities.voices[0] ?? '',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
