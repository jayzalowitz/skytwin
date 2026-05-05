import { Router } from 'express';
import { AssistantService, type ChatTurn } from '@skytwin/assistant';
import { LlmClient, AllProvidersFailedError } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import type { AIProviderName } from '@skytwin/shared-types';
import {
  aiProviderRepository,
  assistantRepository,
} from '@skytwin/db';
import { createLogger } from '@skytwin/core';

import { validateAssistantMessage } from '../validators/assistant-message.js';

const log = createLogger('api:assistant');

/**
 * Build an LlmClient from the user's enabled AI providers. Returns null if
 * the user has no providers configured — the route turns that into a 409
 * response so the dashboard can prompt them to set one up.
 *
 * Mirrors `events.ts:buildLlmClientForUser` deliberately. We could share
 * the helper but events.ts also does its own per-request branching and
 * cross-importing the helper would couple the two routes. One copy is
 * cheaper to reason about than one shared utility with two callers in
 * different files. Issue #135 phase 1.
 */
async function buildLlmClientForUser(userId: string): Promise<LlmClient | null> {
  const rows = await aiProviderRepository.getEnabledForUser(userId);
  if (rows.length === 0) return null;
  const providers: ProviderEntry[] = rows.map(
    (r: { provider: string; api_key: string; model: string; base_url: string | null }) => ({
      name: r.provider as AIProviderName,
      apiKey: r.api_key,
      model: r.model,
      baseUrl: r.base_url ?? undefined,
    }),
  );
  return new LlmClient(providers, userId);
}

/**
 * UUID validator for path params. The `requireOwnership` middleware already
 * gates `?userId=…`; this is the per-route check on `:threadId`.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Routes for the conversational assistant. Issue #135 phase 1 — sync chat
 * completion only. Phase 2 will add SSE streaming on `POST /messages`.
 *
 * Endpoints:
 *   POST   /api/assistant/messages            — submit message, get reply
 *   GET    /api/assistant/threads?userId=…    — list user's threads
 *   GET    /api/assistant/threads/:threadId   — fetch one thread + messages
 *   DELETE /api/assistant/threads/:threadId   — delete a thread
 *
 * All four require auth + ownership (mounted under sessionAuth +
 * requireOwnership in apps/api/src/index.ts). Cross-user access is
 * forbidden by the middleware, not the route.
 */
export function createAssistantRouter(): Router {
  const router = Router();

  /**
   * POST /api/assistant/messages
   *
   * Body: { userId, content, threadId? }
   *
   * If `threadId` is omitted, a new thread is created and `content` becomes
   * the first user message. The response includes the thread (so the
   * client can update its URL) and the assistant's reply message.
   *
   * Returns 409 when the user has no LLM provider configured — the
   * dashboard surfaces this as "set up an AI provider in Settings."
   * Returns 502 when every provider in the chain fails — phase 1 doesn't
   * fall back to canned replies, the user is told to retry.
   */
  router.post('/messages', async (req, res, next) => {
    try {
      const validation = validateAssistantMessage(req.body);
      if (!validation.ok) {
        res.status(400).json({
          error: 'Invalid message payload',
          details: validation.errors,
        });
        return;
      }
      const { userId, content, threadId: providedThreadId } = validation;

      const llm = await buildLlmClientForUser(userId);
      if (!llm) {
        res.status(409).json({
          error: 'No AI provider configured',
          message:
            'Configure at least one provider in Settings → AI providers before chatting with the assistant.',
        });
        return;
      }

      // Resolve the thread: existing one or new one based on the first
      // user message. We persist the user message FIRST so it's durable
      // even if the LLM call fails — the user shouldn't lose their input
      // because of an upstream provider outage.
      let threadId: string;
      let isNewThread = false;
      if (providedThreadId) {
        const existing = await assistantRepository.getThread(userId, providedThreadId);
        if (!existing) {
          // Don't leak whether the thread exists vs. is owned by another
          // user — same hygiene as the repository's documented contract.
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        threadId = existing.thread.id;
      } else {
        const newThread = await assistantRepository.createThread(userId, content);
        threadId = newThread.id;
        isNewThread = true;
      }

      const userMessage = await assistantRepository.appendMessage(threadId, 'user', content);

      // Build the prompt history from the persisted thread (gives us the
      // full conversation including the user message we just appended).
      const fetched = await assistantRepository.getThread(userId, threadId);
      // Defensive — we just wrote the thread, but if a concurrent DELETE
      // landed between INSERT and SELECT we'd have a stale view. Treat as
      // 404 so the client retries with a fresh thread.
      if (!fetched) {
        res.status(404).json({ error: 'Thread vanished mid-request' });
        return;
      }
      const history: ChatTurn[] = fetched.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const service = new AssistantService(llm);
      let reply;
      try {
        reply = await service.reply(history);
      } catch (err) {
        if (err instanceof AllProvidersFailedError) {
          log.warn('All LLM providers failed for assistant request', {
            userId,
            threadId,
            attempted: err.attempted,
          });
          res.status(502).json({
            error: 'All configured AI providers failed',
            message:
              'Every configured provider returned an error. Try again in a moment, or check Settings → AI providers.',
            attempted: err.attempted,
          });
          return;
        }
        throw err;
      }

      const assistantMessage = await assistantRepository.appendMessage(
        threadId,
        'assistant',
        reply.content,
        reply.metadata,
      );

      res.json({
        thread: { id: threadId, isNew: isNewThread },
        userMessage,
        assistantMessage,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/assistant/threads?userId=…
   *
   * Returns up to 50 most-recently-active threads for the user. Phase 1
   * doesn't paginate — 50 is enough for a left-rail view and a future
   * phase can add cursor-based paging when users have hundreds of threads.
   */
  router.get('/threads', async (req, res, next) => {
    try {
      const userId = req.query['userId'];
      if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
        res.status(400).json({ error: 'userId query param is required and must be a UUID' });
        return;
      }
      const threads = await assistantRepository.listThreads(userId);
      res.json({ threads });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/assistant/threads/:threadId?userId=…
   *
   * Returns the thread + all messages in chronological order. 404 when
   * the thread doesn't exist or isn't owned by the requesting user.
   */
  router.get('/threads/:threadId', async (req, res, next) => {
    try {
      const userId = req.query['userId'];
      const { threadId } = req.params;
      if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
        res.status(400).json({ error: 'userId query param is required and must be a UUID' });
        return;
      }
      if (!threadId || !UUID_REGEX.test(threadId)) {
        res.status(400).json({ error: 'threadId path param must be a UUID' });
        return;
      }
      const fetched = await assistantRepository.getThread(userId, threadId);
      if (!fetched) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      res.json(fetched);
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /api/assistant/threads/:threadId?userId=…
   *
   * Cascades the message rows. 404 when the thread doesn't exist or isn't
   * owned by the requesting user (don't-leak-existence semantics).
   */
  router.delete('/threads/:threadId', async (req, res, next) => {
    try {
      const userId = req.query['userId'];
      const { threadId } = req.params;
      if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
        res.status(400).json({ error: 'userId query param is required and must be a UUID' });
        return;
      }
      if (!threadId || !UUID_REGEX.test(threadId)) {
        res.status(400).json({ error: 'threadId path param must be a UUID' });
        return;
      }
      const deleted = await assistantRepository.deleteThread(userId, threadId);
      if (!deleted) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
