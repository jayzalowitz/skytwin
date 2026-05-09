import { Router } from 'express';
import { createEmbeddedSttPort, type EmbeddedSttPort } from '@skytwin/embedded-llm';
import { createLogger } from '@skytwin/core';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';

const log = createLogger('api:voice');

/**
 * Voice transcription routes (#194 Child 4 + #187 AC#3 consumer).
 *
 *   GET  /api/voice/capabilities/:userId  — does this server have whisper?
 *   POST /api/voice/transcribe           — body: { userId, audioBase64, mime?, language? }
 *
 * Backed by `createEmbeddedSttPort()` from `@skytwin/embedded-llm`. The
 * port returns a `NullEmbeddedSttPort` when whisper-cli isn't installed
 * — its `transcribe()` throws `NotAvailableError`, which we surface as
 * 503 so the client can fall back to a manual transcript.
 *
 * Why the binary lives behind a single port: the same backend serves
 * desktop voice-first (#194 Child 4) and mobile voice (#179). Both
 * clients POST audio here; one place to install/upgrade the model.
 */

let cachedPort: Promise<EmbeddedSttPort> | null = null;
function getPort(): Promise<EmbeddedSttPort> {
  if (cachedPort === null) cachedPort = createEmbeddedSttPort();
  return cachedPort;
}

/**
 * Test helper — clears the cached port so a beforeEach can swap out
 * `createEmbeddedSttPort` mocks between cases. Production callers never
 * need this; the port is intentionally cached for hot-path latency.
 */
export function _resetVoicePortCache(): void {
  cachedPort = null;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB, ~10 minutes of WAV

export function createVoiceRouter(): Router {
  const router = Router();
  bindUserIdParamOwnership(router);

  router.get('/capabilities/:userId', async (_req, res, next) => {
    try {
      const port = await getPort();
      res.json({
        available: port.capabilities.available,
        supportedFormats: port.capabilities.supportedFormats,
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
      if (audioBase64.length > Math.ceil(MAX_AUDIO_BYTES * 4 / 3)) {
        res.status(413).json({ error: 'audio too large (max 25MB)' });
        return;
      }
      const audio = Buffer.from(audioBase64, 'base64');
      if (audio.length === 0) {
        res.status(400).json({ error: 'audio decoded to zero bytes' });
        return;
      }

      const port = await getPort();
      if (!port.capabilities.available) {
        res.status(503).json({
          error: 'whisper-cli not available on this server',
          hint: 'install whisper.cpp and a ggml model, or set SKYTWIN_WHISPER_BIN + SKYTWIN_WHISPER_MODEL',
        });
        return;
      }

      const opts: { language?: string } = {};
      if (typeof language === 'string' && language.length > 0) {
        opts.language = language;
      }
      const transcript = await port.transcribe(audio, opts);
      log.info('Transcribed audio', {
        userId,
        bytes: audio.length,
        chars: transcript.length,
      });
      res.json({ transcript, durationBytes: audio.length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
