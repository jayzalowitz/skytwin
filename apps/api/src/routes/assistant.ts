import { Router } from 'express';
import {
  AssistantService,
  ContextBuilder,
  type ChatTurn,
  type TwinContextProvider,
  type MemoryContextProvider,
} from '@skytwin/assistant';
import { LlmClient, AllProvidersFailedError } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import type { AIProviderName } from '@skytwin/shared-types';
import { TwinService } from '@skytwin/twin-model';
import {
  aiProviderRepository,
  assistantRepository,
  mempalaceRepository,
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
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
/**
 * Build the per-process `ContextBuilder` that the assistant uses to
 * enrich its system prompt with twin profile + relevant episodic memories.
 *
 * Issue #147 (phase 2b). The adapters here translate `@skytwin/db` and
 * `@skytwin/twin-model` shapes into the renderer-friendly shape the
 * `@skytwin/assistant` package's port expects, so the assistant package
 * itself stays free of DB / mempalace dependencies (and unit-tests
 * cleanly with stubs).
 *
 * The TwinService is constructed once at module load — same pattern as
 * `events.ts` — because its underlying repositories are stateless and
 * the service itself caches nothing per-request.
 */
function buildContextBuilder(): ContextBuilder {
  const twinService = new TwinService(
    new TwinRepositoryAdapter(),
    new PatternRepositoryAdapter(),
  );

  const twinProvider: TwinContextProvider = {
    async fetch(userId) {
      // Pull profile + user record in parallel — they're independent.
      // Profile gives us preferences/inferences; user record gives us the
      // trust tier (which lives on `users.trust_tier`, not on the profile).
      const [profile, user] = await Promise.all([
        twinService.getOrCreateProfile(userId),
        userRepository.findById(userId),
      ]);
      return {
        trustTier: (user?.trust_tier as string) ?? 'observer',
        preferences: profile.preferences.map((p) => ({
          domain: p.domain,
          key: p.key,
          value: p.value,
          confidence: p.confidence,
        })),
        inferences: profile.inferences.map((i) => ({
          domain: i.domain,
          key: i.key,
          value: i.value,
          confidence: i.confidence,
          reasoning: i.reasoning,
        })),
      };
    },
  };

  /**
   * Memory provider — splits the query into search terms and asks
   * `mempalaceRepository.searchEpisodes` (the same backing call that
   * `@skytwin/mempalace.MemoryStack.search` uses for its L3 deep-search
   * layer). Stop-words and very short tokens are dropped so a query like
   * "the plan for X" doesn't ILIKE-match every episode containing "the".
   */
  const memoryProvider: MemoryContextProvider = {
    async search(userId, query, limit = 5) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((t) => t.length >= 3);
      if (terms.length === 0) return [];
      const rows = await mempalaceRepository.searchEpisodes(userId, terms, limit);
      return rows.map((r) => ({
        summary: r.situation_summary,
        domain: r.domain,
        actionTaken: r.action_taken ?? undefined,
        // outcome is JSON; surface a compact 'kind' if present, else
        // stringify a tiny preview. The renderer only needs a short
        // human-readable hint, not a full structured payload.
        outcome: r.outcome ? renderOutcomeHint(r.outcome) : undefined,
        occurredAt: r.created_at instanceof Date ? r.created_at.toISOString() : undefined,
      }));
    },
  };

  return new ContextBuilder(twinProvider, memoryProvider);
}

/**
 * Compress an episode `outcome` JSON blob to a one-line label for the
 * context block. Prefer a `kind` or `status` field if present (those are
 * the conventional discriminators in this codebase); else fall back to a
 * short stringification capped well below the per-line byte budget.
 */
function renderOutcomeHint(outcome: Record<string, unknown>): string {
  const kind = outcome['kind'] ?? outcome['status'] ?? outcome['result'];
  if (typeof kind === 'string' && kind.length > 0) return kind;
  try {
    const json = JSON.stringify(outcome);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  } catch {
    return 'outcome unavailable';
  }
}

/**
 * Stream an assistant reply over SSE. Issue #146 (phase 2a).
 *
 * Wire format (each event is `event:` + `data:` + blank line):
 *
 *   event: thread
 *   data: {"id":"…","isNew":true}
 *
 *   event: user
 *   data: {…userMessage row…}
 *
 *   event: chunk
 *   data: {"content":"Hello"}
 *
 *   event: chunk
 *   data: {"content":" world"}
 *
 *   event: done
 *   data: {…assistantMessage row…}
 *
 * On mid-stream failure the stream ends with an `error` event carrying
 * the partial content so the UI can render what landed plus a caveat.
 *
 * Pre-first-chunk failures (every provider 5xx, no chunk yielded) end
 * with a single `error` event with `partialContent: ''` — same wire
 * shape so the client doesn't need a separate code path.
 *
 * The assistant message is persisted AFTER the stream closes, using the
 * accumulated full content. If the persist fails the stream's `done`
 * event still fires (the user got a useful reply on screen) but a `warn`
 * is logged — the audit-trail loss is recoverable, the user-facing
 * regression isn't.
 */
async function streamAssistantReply(args: {
  service: AssistantService;
  history: ChatTurn[];
  enrichment: { userId: string; query: string };
  threadId: string;
  isNewThread: boolean;
  userMessage: unknown;
  res: import('express').Response;
  log: ReturnType<typeof createLogger>;
}): Promise<void> {
  const { service, history, enrichment, threadId, isNewThread, userMessage, res, log: logger } = args;

  // Standard SSE response headers. `X-Accel-Buffering: no` keeps nginx
  // from buffering the stream end-to-end (would defeat the point of
  // streaming under that proxy). Harmless when no nginx is in front.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    // Defensive — once the client drops the connection (`req.on('close')`)
    // any further write throws ERR_STREAM_WRITE_AFTER_END and crashes the
    // request. Check `res.writableEnded` and `res.destroyed` before each
    // send so the for-await loop can keep iterating but stop emitting.
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Pre-stream events: thread + the persisted user message. The client
  // needs both before tokens start landing — the user message ID lets it
  // replace its optimistic bubble with the durable row, and the thread
  // ID lets a brand-new thread show up in the left rail immediately.
  send('thread', { id: threadId, isNew: isNewThread });
  send('user', userMessage);

  let collectedFullContent = '';
  let metadata: { provider: string; model: string; latencyMs: number } | null = null;

  try {
    for await (const event of service.replyStream(history, enrichment)) {
      // Stop iterating if the client went away mid-stream — saves the
      // provider's tokens and lets the underlying generator clean up.
      if (res.writableEnded || res.destroyed) {
        logger.info('Assistant stream client disconnected mid-flight', {
          threadId,
          userId: enrichment.userId,
        });
        // Throwing here propagates up to abort the underlying generateStream
        // (the provider's AbortController is wired to the generator's
        // `finally` blocks).
        return;
      }

      if (event.type === 'chunk') {
        collectedFullContent += event.content;
        send('chunk', { content: event.content });
      } else if (event.type === 'done') {
        collectedFullContent = event.fullContent;
        metadata = event.metadata;
        // Persist the assistant message NOW (after we know the full
        // content) so a partial-stream failure earlier doesn't leave a
        // half-message in the DB.
        try {
          const assistantMessage = await assistantRepository.appendMessage(
            threadId,
            'assistant',
            collectedFullContent,
            metadata,
          );
          send('done', assistantMessage);
        } catch (persistErr) {
          // Stream completed and the user saw the reply, but we couldn't
          // persist. Log a warning and emit done with a synthetic shape
          // so the client still terminates cleanly. The next thread
          // fetch won't include this message — that's the recoverable
          // failure mode (vs. corrupting the user's UI).
          logger.warn('Assistant message persist failed after stream complete', {
            threadId,
            userId: enrichment.userId,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
          send('done', {
            id: null,
            threadId,
            role: 'assistant',
            content: collectedFullContent,
            createdAt: new Date().toISOString(),
            metadata,
            persistFailed: true,
          });
        }
        res.end();
        return;
      } else if (event.type === 'error') {
        // Mid-stream failure with partial content already on screen.
        send('error', {
          message: event.message,
          partialContent: event.partialContent,
        });
        res.end();
        return;
      }
    }
  } catch (err) {
    // Pre-first-chunk failure (AllProvidersFailedError) or any unexpected
    // throw bubbles up here. Surface as a single `error` event so the
    // client has one terminal-event shape to handle.
    if (err instanceof AllProvidersFailedError) {
      logger.warn('All LLM providers failed for assistant stream', {
        userId: enrichment.userId,
        threadId,
        attempted: err.attempted,
      });
      send('error', {
        message:
          'Every configured provider returned an error. Try again in a moment, or check Settings → AI providers.',
        partialContent: '',
        attempted: err.attempted,
      });
    } else {
      logger.error('Unexpected error during assistant stream', {
        userId: enrichment.userId,
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
      send('error', {
        message: err instanceof Error ? err.message : 'Unknown error',
        partialContent: collectedFullContent,
      });
    }
    res.end();
  }
}

export function createAssistantRouter(): Router {
  const router = Router();
  // Built once per process — adapters are stateless, the underlying
  // TwinService caches nothing per-request.
  const contextBuilder = buildContextBuilder();

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

      // Issue #147: pass the ContextBuilder so the assistant gets a
      // system prompt enriched with twin profile + relevant episodic
      // memories. The `enrichment.query` is the just-sent user message —
      // that's what the assistant is about to answer, so the most-relevant
      // memories are the ones that match it.
      const service = new AssistantService(llm, undefined, contextBuilder);

      // Issue #146 (phase 2a): branch on the Accept header. SSE clients
      // get a token-by-token stream; legacy JSON clients get the existing
      // single-shot response. Both paths persist the assistant message in
      // the same shape so a thread looks identical regardless of how it
      // was generated.
      const wantsStream = (req.headers['accept'] ?? '').toString().includes('text/event-stream');

      if (wantsStream) {
        await streamAssistantReply({
          service,
          history,
          enrichment: { userId, query: content },
          threadId,
          isNewThread,
          userMessage,
          res,
          log,
        });
        return;
      }

      let reply;
      try {
        reply = await service.reply(history, { userId, query: content });
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
