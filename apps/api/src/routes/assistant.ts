import { Router } from 'express';
import {
  AssistantService,
  ContextBuilder,
  type ChatTurn,
  type TwinContextProvider,
  type MemoryContextProvider,
  type ActionRouter,
  type ActionRouteOutcome,
  type ActionIntent,
} from '@skytwin/assistant';
import { LlmClient, AllProvidersFailedError } from '@skytwin/llm-client';
import type { ProviderEntry } from '@skytwin/llm-client';
import type { AIProviderName, DecisionContext, DecisionObject } from '@skytwin/shared-types';
import { SituationType, TrustTier } from '@skytwin/shared-types';
import { TwinService } from '@skytwin/twin-model';
import { DecisionMaker } from '@skytwin/decision-engine';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  aiProviderRepository,
  approvalRepository,
  assistantRepository,
  emailLabelRepository,
  mempalaceRepository,
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
} from '@skytwin/db';
import { createLogger } from '@skytwin/core';

import { sseManager } from '../sse.js';
import { validateAssistantMessage } from '../validators/assistant-message.js';
import { getMemoryPortForUser } from '../memory-setup.js';

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
   * Memory provider — uses the user's selected MemoryPort
   * (`getMemoryPortForUser`). The default gbrain backend runs vector +
   * tsvector RRF over brain_pages; mempalace runs the legacy ILIKE
   * search; hybrid runs both and folds. We also fall back to the legacy
   * `mempalaceRepository.searchEpisodes` ILIKE path so that even on a
   * fresh install with an empty brain_pages table, the chat surfaces
   * recent decisions immediately (without waiting for the embedding
   * worker to backfill).
   *
   * The tradeoff: a hot install gets union-of-best (gbrain when it has
   * pages, mempalace when it doesn't). A cold install with empty gbrain
   * still answers from mempalace. No additional latency on the hot path
   * because both sources are fetched in parallel.
   */
  const memoryProvider: MemoryContextProvider = {
    async search(userId, query, limit = 5) {
      // Run gbrain semantic search and mempalace ILIKE in parallel, then
      // dedupe by normalized summary text — the gbrain side never has an
      // occurredAt, so including it in the key would prevent cross-source
      // dedupe entirely (every gbrain hit's occurredAt is undefined while
      // every mempalace hit's is a string, so they'd never match). Both
      // calls have their own internal failure handling so caller can't throw.
      const [semanticHits, mempalaceRows] = await Promise.all([
        getMemoryPortForUser(userId)
          .then((res) => res.port.searchSemantic(query, limit))
          .catch(() => []),
        (async () => {
          const terms = query
            .toLowerCase()
            .split(/[^a-z0-9]+/i)
            .filter((t) => t.length >= 3);
          if (terms.length === 0) return [];
          return mempalaceRepository.searchEpisodes(userId, terms, limit).catch(() => []);
        })(),
      ]);

      interface MergedHit {
        summary: string;
        domain: string;
        actionTaken: string | undefined;
        outcome: string | undefined;
        occurredAt: string | undefined;
      }
      // Convert both shapes into the renderer-friendly contract.
      const fromSemantic: MergedHit[] = semanticHits.map((h) => {
        const meta = (h.metadata ?? {}) as Record<string, unknown>;
        return {
          summary: h.content,
          domain: typeof meta['domain'] === 'string' ? (meta['domain'] as string) : 'memory',
          actionTaken:
            typeof meta['actionType'] === 'string' ? (meta['actionType'] as string) : undefined,
          outcome: undefined,
          occurredAt: undefined,
        };
      });
      const fromMempalace: MergedHit[] = mempalaceRows.map((r) => ({
        summary: r.situation_summary,
        domain: r.domain,
        actionTaken: r.action_taken ?? undefined,
        outcome: r.outcome ? renderOutcomeHint(r.outcome) : undefined,
        occurredAt: r.created_at instanceof Date ? r.created_at.toISOString() : undefined,
      }));

      // Dedupe by summary text — same episode may surface from both sources.
      const seen = new Set<string>();
      const merged: MergedHit[] = [];
      for (const item of [...fromSemantic, ...fromMempalace]) {
        const key = item.summary.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
        if (merged.length >= limit) break;
      }
      return merged;
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
 * Build the per-process `ActionRouter` that the assistant uses to route
 * chat-detected action intents through the existing decision pipeline.
 * Issue #148 v1.
 *
 * Conservative v1 design choice: chat-driven actions ALWAYS land in the
 * approval queue, even when `DecisionMaker.evaluate()` returns
 * `autoExecute=true`. The chat surface skips direct execution. Reasoning:
 *
 *   - Chat is a free-text channel — an unintended intent match
 *     ("schedule a meeting" appearing in a discussion ABOUT scheduling)
 *     should not auto-execute. The /api/events path has a structured
 *     signal as ground truth; chat doesn't.
 *   - The user already has the existing approvals UI to review and
 *     consent. Routing through it preserves the audit trail and feedback
 *     loop unchanged.
 *   - Phase 2 of #148 lifts this restriction once we have an
 *     LLM-classifier confidence score AND an explicit "always approve
 *     chat actions" trust-tier-style escape hatch.
 *
 * The adapter wires the same TwinService + PolicyEvaluator + DecisionMaker
 * stack that `events.ts` constructs. We can't share the events.ts
 * instance directly because that's tied to the events router scope —
 * one copy is cheaper to reason about than a refactor that hoists the
 * stack to a module-level singleton both routers consume.
 */
function buildActionRouter(): ActionRouter {
  const twinService = new TwinService(
    new TwinRepositoryAdapter(),
    new PatternRepositoryAdapter(),
  );
  const policyEvaluator = new PolicyEvaluator(policyRepositoryAdapter);
  const explanationGenerator = new ExplanationGenerator(explanationRepositoryAdapter);

  // Issue #122: same per-user (sender, label) hint port as the events
  // route. Reused so chat-driven label_email candidates get the same
  // learned-from-history confidence boost. Inline literal — typed
  // structurally; @skytwin/decision-engine doesn't export LabelInferencePort.
  const labelInferencePort = {
    async topLabelsForSender(userId: string, sender: string, limit?: number) {
      return emailLabelRepository.topLabelsForSender(userId, sender, limit);
    },
    async topLabelsForListId(userId: string, listId: string, limit?: number) {
      return emailLabelRepository.topLabelsForListId(userId, listId, limit);
    },
  };

  const decisionMaker = new DecisionMaker(
    twinService,
    policyEvaluator,
    decisionRepositoryAdapter,
    undefined,
    labelInferencePort,
  );

  return {
    async route(userId, intent) {
      // Build a synthetic DecisionObject from the chat intent. Mirrors
      // the shape `SituationInterpreter` produces for real signals so
      // downstream code (DecisionMaker + ExplanationGenerator) can't
      // tell the difference.
      const decision: DecisionObject = {
        id: `chat_intent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        situationType: intent.situationType as SituationType,
        domain: intent.domain,
        urgency: 'medium',
        summary: intent.summary,
        rawData: { ...intent.rawData, triggerMessage: intent.triggerMessage },
        interpretedAt: new Date(),
      };

      // Persist the decision so downstream foreign keys (outcomes,
      // candidates, approvals) resolve.
      await decisionRepositoryAdapter.saveDecision(decision);

      // Build the same context shape events.ts builds. Patterns / traits
      // / temporalProfile are fetched in parallel — same as the events
      // route, no chat-specific shortcut.
      const [user, preferences, patterns, traits, temporalProfile] = await Promise.all([
        userRepository.findById(userId),
        twinService.getRelevantPreferences(userId, decision.domain, decision.summary),
        twinService.getPatterns(userId),
        twinService.getTraits(userId),
        twinService.getTemporalProfile(userId),
      ]);

      const context: DecisionContext = {
        userId,
        decision,
        trustTier: (user?.trust_tier as TrustTier) ?? TrustTier.OBSERVER,
        relevantPreferences: preferences,
        timestamp: new Date(),
        patterns,
        traits,
        temporalProfile,
      };

      // Run the full decision pipeline. This is the load-bearing call —
      // every Safety Invariant gate (policy, trust tier, spend limits)
      // fires inside `evaluate()`. We do NOT bypass it.
      const outcome = await decisionMaker.evaluate(context);

      // Generate + persist the explanation for audit trail. Safety
      // Invariant #2: every action (or deliberate non-action) produces
      // an ExplanationRecord.
      try {
        await explanationGenerator.generate(decision, outcome, context);
      } catch (err) {
        // Explanation persistence failure shouldn't block the chat
        // turn — log and continue. The audit-trail loss is the lesser
        // evil vs. dropping the user's request entirely.
        log.warn('Failed to persist explanation for chat-driven decision', {
          userId,
          decisionId: decision.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // No selected action OR every candidate was denied → blocked.
      if (!outcome.selectedAction) {
        return {
          kind: 'blocked',
          reason: outcome.reasoning || 'No suitable action could be taken right now.',
        } satisfies ActionRouteOutcome;
      }

      // Auto-execute path is intentionally collapsed into requires-approval
      // for v1 (see comment at the top of this factory). The selected
      // action lands in the approval queue regardless of what
      // `outcome.autoExecute` says.
      const {
        accessToken: _omitToken,
        rawData: _omitRawData,
        ...visibleParameters
      } = (outcome.selectedAction.parameters ?? {}) as Record<string, unknown>;

      const approvalRequest = await approvalRepository.create({
        userId,
        decisionId: decision.id,
        candidateAction: {
          actionType: outcome.selectedAction.actionType,
          description: outcome.selectedAction.description,
          domain: outcome.selectedAction.domain,
          parameters: visibleParameters,
          estimatedCostCents: outcome.selectedAction.estimatedCostCents,
          reversible: outcome.selectedAction.reversible,
          confidence: outcome.selectedAction.confidence,
          reasoning: outcome.selectedAction.reasoning,
        },
        reason: outcome.reasoning,
        urgency: decision.urgency,
      });

      // Mirror the events.ts SSE emission so the existing approvals
      // page badge updates immediately when a chat creates an approval.
      sseManager.emit(userId, 'approval:new', {
        id: approvalRequest.id,
        decisionId: decision.id,
        reason: outcome.reasoning,
        urgency: decision.urgency,
      });

      return {
        kind: 'requires-approval',
        approvalRequestId: approvalRequest.id,
        summary: outcome.selectedAction.description,
        reasoning: outcome.reasoning,
      } satisfies ActionRouteOutcome;
    },
  };
}

/**
 * Compose the chat-bubble text shown when an action intent was routed
 * through the decision pipeline. Issue #148 v1.
 *
 * The text + the metadata together let the web client render either an
 * "open approval" link (for requires-approval) or a plain notice (for
 * blocked). The metadata is what `pages/assistant.js` checks before
 * choosing which footer to attach.
 */
function renderActionBubbleContent(intent: ActionIntent, outcome: ActionRouteOutcome): string {
  if (outcome.kind === 'requires-approval') {
    return [
      `${outcome.summary}.`,
      '',
      `Reason: ${outcome.reasoning}`,
      '',
      'I\'ve queued this for your approval — open the Approvals page to confirm.',
    ].join('\n');
  }
  if (outcome.kind === 'blocked') {
    return [
      `I can't do that for you right now.`,
      '',
      `Reason: ${outcome.reason}`,
    ].join('\n');
  }
  // no-action falls through to LLM chat — the route shouldn't render a
  // bubble for this case, but we cover it defensively.
  return `Got it — I heard that as: "${intent.triggerMessage}"`;
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
  // Issue #148 v1: action router that handles chat-detected intents
  // through the existing decision pipeline.
  const actionRouter = buildActionRouter();

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
      // Issue #148 v1: pass the ActionRouter so chat-detected action
      // intents route through the decision pipeline before falling
      // through to the LLM chat reply.
      const service = new AssistantService(llm, undefined, contextBuilder, actionRouter);

      // Issue #148 v1: try intent classification + routing FIRST. If the
      // user's message is an action intent, the decision pipeline
      // produces a structured outcome (requires-approval / blocked) and
      // we persist that as the assistant message — no LLM call. Falls
      // through to the LLM chat path when the message is conversational
      // (most messages) OR when the router throws (graceful degradation).
      const intentRoute = await service.routeIntent(userId, content);
      if (intentRoute && intentRoute.outcome.kind !== 'no-action') {
        const bubbleContent = renderActionBubbleContent(intentRoute.intent, intentRoute.outcome);
        // Metadata records what kind of outcome this was so the web
        // client can attach the right footer (approval link vs.
        // blocked notice). Provider/model/latency are absent because
        // no LLM was consulted — the field stays optional.
        const actionMetadata: Record<string, unknown> = {
          intentRoute: {
            kind: intentRoute.outcome.kind,
            domain: intentRoute.intent.domain,
            ...(intentRoute.outcome.kind === 'requires-approval'
              ? { approvalRequestId: intentRoute.outcome.approvalRequestId }
              : {}),
          },
        };
        const assistantMessage = await assistantRepository.appendMessage(
          threadId,
          'assistant',
          bubbleContent,
          actionMetadata,
        );

        // Both sync + SSE paths land here; for SSE we still send the
        // wire shape clients expect (thread + user + done with the
        // action message in one shot — no chunk events because there
        // was no streaming text).
        const wantsStreamSse = (req.headers['accept'] ?? '').toString().includes('text/event-stream');
        if (wantsStreamSse) {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders?.();
          res.write(`event: thread\ndata: ${JSON.stringify({ id: threadId, isNew: isNewThread })}\n\n`);
          res.write(`event: user\ndata: ${JSON.stringify(userMessage)}\n\n`);
          res.write(`event: done\ndata: ${JSON.stringify(assistantMessage)}\n\n`);
          res.end();
        } else {
          res.json({
            thread: { id: threadId, isNew: isNewThread },
            userMessage,
            assistantMessage,
          });
        }
        return;
      }

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
