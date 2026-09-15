import { randomUUID } from 'node:crypto';
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
  type MemorySource,
} from '@skytwin/assistant';
import { AllProvidersFailedError } from '@skytwin/llm-client';
import { serializeApprovalCandidate } from './approval-candidate.js';
import type { DecisionContext, DecisionObject, DecisionOutcome } from '@skytwin/shared-types';
import { SituationType, TrustTier } from '@skytwin/shared-types';
import { TwinService } from '@skytwin/twin-model';
import { DecisionMaker } from '@skytwin/decision-engine';
import { PolicyEvaluator } from '@skytwin/policy-engine';
import { ExplanationGenerator } from '@skytwin/explanations';
import {
  approvalRepository,
  assistantRepository,
  emailLabelRepository,
  mcpServerRepository,
  mempalaceRepository,
  userRepository,
  TwinRepositoryAdapter,
  PatternRepositoryAdapter,
  decisionRepositoryAdapter,
  explanationRepositoryAdapter,
  policyRepositoryAdapter,
  type AssistantMessage,
} from '@skytwin/db';
import { runPrompt } from '@skytwin/policy-prompts';
import { RegistryClient } from '@skytwin/registry-client';
import { loadConfig } from '@skytwin/config';
import { createLogger } from '@skytwin/core';

import { sseManager } from '../sse.js';
import { validateAssistantMessage } from '../validators/assistant-message.js';
import { getMemoryPortForUser } from '../memory-setup.js';
import { resolveUserLlmClient } from '../lib/user-llm-client.js';
import { readAutonomy } from '../cost-gate.js';
import { isGoogleCapabilityBlocked } from '../lib/google-capability-boundary.js';

const log = createLogger('api:assistant');

/**
 * UUID validator for path params. The `requireOwnership` middleware already
 * gates `?userId=…`; this is the per-route check on `:threadId`.
 */
import { UUID_REGEX } from '../middleware/validate-uuid.js';

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
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

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
        // Source identity for attribution (#147 follow-up). `id` is the
        // underlying record id (brain page / episode); `source` is the
        // origin label shown next to the cited memory in chat. Both were
        // previously discarded — the retrieval knew them, the chat threw
        // them away.
        id: string | undefined;
        source: string | undefined;
      }
      // Convert both shapes into the renderer-friendly contract.
      const fromSemantic: MergedHit[] = semanticHits.map((h) => {
        const meta = (h.metadata ?? {}) as Record<string, unknown>;
        return {
          // Coalesce to a string at the backend boundary — `content` is typed
          // `string`, but a non-conforming pluggable backend must not crash
          // the dedup loop's `.trim()` below.
          summary: typeof h.content === 'string' ? h.content : '',
          domain: typeof meta['domain'] === 'string' ? (meta['domain'] as string) : 'memory',
          actionTaken:
            typeof meta['actionType'] === 'string' ? (meta['actionType'] as string) : undefined,
          outcome: undefined,
          occurredAt: undefined,
          // gbrain `SemanticHit` carries the page id + its origin (e.g.
          // `gmail`, `calendar`). Fall back to the metadata domain only
          // when the backend left `source` blank.
          id: typeof h.id === 'string' && h.id.length > 0 ? h.id : undefined,
          source:
            typeof h.source === 'string' && h.source.length > 0
              ? h.source
              : typeof meta['domain'] === 'string'
                ? (meta['domain'] as string)
                : undefined,
        };
      });
      const fromMempalace: MergedHit[] = mempalaceRows.map((r) => ({
        summary: typeof r.situation_summary === 'string' ? r.situation_summary : '',
        domain: r.domain,
        actionTaken: r.action_taken ?? undefined,
        outcome: r.outcome ? renderOutcomeHint(r.outcome) : undefined,
        occurredAt: r.created_at instanceof Date ? r.created_at.toISOString() : undefined,
        // Episodes are past decisions the twin recorded. The episode id is
        // the citable record; label the origin `decision` so the chip reads
        // "from a past decision" rather than a connector name.
        id: typeof r.id === 'string' && r.id.length > 0 ? r.id : undefined,
        source: 'decision',
      }));

      // Dedupe by summary text — the same episode may surface from both
      // sources. On a collision, enrich the kept record with any richer
      // fields the duplicate carries instead of dropping it: the mempalace
      // side has occurredAt / actionTaken / outcome (and the `decision`
      // origin) that the gbrain side leaves undefined. Without this merge a
      // full semantic result set fills the cap first and every mempalace hit
      // — the richer one — is discarded, so the `decision` provenance never
      // surfaces for an episode that also has a brain page.
      const byKey = new Map<string, MergedHit>();
      const order: string[] = [];
      for (const item of [...fromSemantic, ...fromMempalace]) {
        const key = item.summary.trim().toLowerCase();
        // Skip empty-summary hits: they can't be rendered or cited, and an
        // empty key would collapse unrelated rows together.
        if (!key) continue;
        const existing = byKey.get(key);
        if (!existing) {
          if (order.length >= limit) continue;
          byKey.set(key, item);
          order.push(key);
          continue;
        }
        existing.occurredAt ??= item.occurredAt;
        existing.actionTaken ??= item.actionTaken;
        existing.outcome ??= item.outcome;
        existing.id ??= item.id;
        // Prefer a specific origin over the generic gbrain fallback.
        if ((!existing.source || existing.source === 'memory') && item.source) {
          existing.source = item.source;
        }
      }
      return order.map((k) => byKey.get(k)!);
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
 * Chat never executes directly. Normalize the engine result before its first
 * durable outcome write so both the audit row and explanation describe the
 * approval that will actually be created, including when ordinary policy
 * evaluation would otherwise allow automatic execution.
 */
export function normalizeAssistantOutcomeForApproval(outcome: DecisionOutcome): DecisionOutcome {
  if (!outcome.selectedAction) return outcome;
  const wasAlreadyApproval = outcome.requiresApproval && !outcome.autoExecute;
  return {
    ...outcome,
    autoExecute: false,
    requiresApproval: true,
    reasoning: wasAlreadyApproval
      ? outcome.reasoning
      : `${outcome.reasoning} Assistant actions require explicit approval.`,
    policyVerdicts: {
      ...(outcome.policyVerdicts ?? {}),
      [outcome.selectedAction.id]: 'requires-approval',
    },
  };
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
export function buildActionRouter(): ActionRouter {
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());
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

  const assistantDecisionRepository = {
    ...decisionRepositoryAdapter,
    async saveOutcome(outcome: DecisionOutcome): Promise<DecisionOutcome> {
      const normalized = normalizeAssistantOutcomeForApproval(outcome);
      Object.assign(outcome, normalized);
      return decisionRepositoryAdapter.saveOutcome(normalized);
    },
  };

  const decisionMaker = new DecisionMaker(
    twinService,
    policyEvaluator,
    assistantDecisionRepository,
    undefined,
    labelInferencePort,
  );

  return {
    async route(userId, intent, routeContext) {
      // Build a synthetic DecisionObject from the chat intent. Mirrors
      // the shape `SituationInterpreter` produces for real signals so
      // downstream code (DecisionMaker + ExplanationGenerator) can't
      // tell the difference.
      //
      // Provenance is `user_originated`: a chat intent is the user
      // directly instructing the twin in their own words. This is the
      // one path where the instruction genuinely comes from the user,
      // so the injection guard does not escalate it on provenance
      // grounds (it still escalates on action severity — a chat request
      // to "delete everything" is still destructive-shaped).
      const decision: DecisionObject = {
        id: randomUUID(),
        situationType: intent.situationType as SituationType,
        domain: intent.domain,
        urgency: 'medium',
        summary: intent.summary,
        rawData: {
          ...intent.rawData,
          triggerMessage: intent.triggerMessage,
          userId,
          ...(routeContext?.idempotencyKey
            ? { signalId: `assistant-message:${routeContext.idempotencyKey}` }
            : {}),
        },
        interpretedAt: new Date(),
        provenance: 'user_originated',
      };

      // Persist the decision so downstream foreign keys (outcomes,
      // candidates, approvals) resolve. The `created` flag from the new
      // return shape isn't consumed here — assistant flows don't emit
      // `decision:blocked-by-policy`, and the `approval:new` emit is
      // already gated separately on the approval-row creation (#292). A
      // future side-effect on this path (briefing pings, capability
      // suggestions on assistant intent) should destructure and gate.
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
        autonomySettings: readAutonomy(user),
      };

      // Run the full decision pipeline. This is the load-bearing call —
      // every Safety Invariant gate (policy, trust tier, spend limits)
      // fires inside `evaluate()`. We do NOT bypass it.
      const outcome = await decisionMaker.evaluate(context);

      // No selected action OR every candidate was denied → blocked.
      if (!outcome.selectedAction) {
        // Deliberate non-actions still require a durable explanation before
        // their blocked result is returned to the user.
        await explanationGenerator.generate(decision, outcome, context);
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

      // Hard pre-effect boundary: an approval is externally visible execution
      // authority. Never create it unless its explanation is already durable.
      await explanationGenerator.generate(decision, outcome, context);

      const approvalInput = {
        userId,
        decisionId: decision.id,
        candidateAction: serializeApprovalCandidate(outcome.selectedAction, visibleParameters),
        reason: outcome.reasoning,
        urgency: decision.urgency,
        // The injection guard sets `dual` for extreme-severity actions —
        // even a chat-originated request to do something catastrophic takes
        // two token-gated confirmations.
        confirmationLevel: outcome.confirmationLevel === 'dual' ? 'dual' : 'single',
      } as const;
      let approvalRequest: Awaited<ReturnType<typeof approvalRepository.findByDecisionId>>;
      let approvalNewlyCreated = false;
      let approvalCreateReconciled = false;
      try {
        const createdApproval = await approvalRepository.create(approvalInput);
        approvalRequest = createdApproval.row;
        approvalNewlyCreated = createdApproval.created;
      } catch {
        // The insert may have committed even if its response was lost. The
        // stable decision id is the recovery key; never invite a retry until
        // that durable state has been checked.
        try {
          approvalRequest = await approvalRepository.findByDecisionId(decision.id, userId);
        } catch {
          approvalRequest = null;
        }
        if (!approvalRequest) {
          log.error('Assistant approval create outcome is unknown', {
            userId,
            decisionId: decision.id,
            errorCode: 'assistant_approval_create_unknown',
          });
          return {
            kind: 'failed',
            reason:
              'I could not confirm whether the approval was queued. Check Approvals before retrying.',
          } satisfies ActionRouteOutcome;
        }
        approvalCreateReconciled = true;
        log.warn('Recovered assistant approval after an uncertain create response', {
          userId,
          decisionId: decision.id,
          approvalId: approvalRequest.id,
          errorCode: 'assistant_approval_create_reconciled',
        });
      }

      // Mirror the events.ts SSE emission so the existing approvals page
      // badge updates immediately when a chat creates an approval — but
      // ONLY when this call actually wrote the row. A chat that re-routes
      // an identical intent (or that lands on the same decision_id from a
      // signal already in flight on the events path) would otherwise
      // double-fire `approval:new` for an approval the user is already
      // looking at. Suppression leaves an audit breadcrumb for the same
      // reason as events.ts — operators investigating "why no
      // notification?" can confirm it was recognised and silenced.
      if (approvalNewlyCreated || approvalCreateReconciled) {
        try {
          sseManager.emit(userId, 'approval:new', {
            id: approvalRequest.id,
            decisionId: decision.id,
            reason: outcome.reasoning,
            urgency: decision.urgency,
          });
        } catch {
          // Notification delivery is secondary to the durable approval.
          log.warn('Assistant approval notification needs reconciliation', {
            userId,
            decisionId: decision.id,
            approvalId: approvalRequest.id,
            errorCode: 'assistant_approval_sse_failed',
          });
        }
      } else {
        log.info('Suppressed approval:new SSE for re-routed assistant intent', {
          userId,
          decisionId: decision.id,
          approvalId: approvalRequest.id,
        });
      }

      return {
        kind: 'requires-approval',
        approvalRequestId: approvalRequest.id,
        summary: outcome.selectedAction.description,
        reasoning: approvalCreateReconciled
          ? `${outcome.reasoning} The approval is queued and its uncertain create response was reconciled.`
          : outcome.reasoning,
      } satisfies ActionRouteOutcome;
    },
  };
}

/**
 * Persist the assistant bubble after a durable approval is known to exist.
 * If the write response is lost, reconcile by the request key. If both the
 * write and read are unavailable, fail ambiguously: the caller must retain the
 * request key because only a durable assistant row is safe to report as done.
 */
export async function appendKnownApprovalMessage(
  userId: string,
  threadId: string,
  approvalRequestId: string,
  content: string,
  metadata: Record<string, unknown>,
  requestId: string,
): Promise<AssistantMessage> {
  try {
    return await assistantRepository.appendOrGetAssistantMessage(
      userId,
      threadId,
      content,
      requestId,
      metadata,
    );
  } catch {
    try {
      const recovered = await assistantRepository.findAssistantMessageByRequestId(
        userId,
        requestId,
      );
      if (recovered?.threadId === threadId) return recovered;
    } catch {
      // The approval remains durable even if this secondary read is unavailable.
    }
    log.error('Assistant approval message needs reconciliation', {
      userId,
      threadId,
      approvalId: approvalRequestId,
      errorCode: 'assistant_message_persistence_unknown',
    });
    throw new Error('assistant_message_persistence_unknown');
  }
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
      "I've queued this for your approval — open the Approvals page to confirm.",
    ].join('\n');
  }
  if (outcome.kind === 'blocked') {
    return [`I can't do that for you right now.`, '', `Reason: ${outcome.reason}`].join('\n');
  }
  if (outcome.kind === 'failed') {
    return ['I stopped before taking any action.', '', `Reason: ${outcome.reason}`].join('\n');
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
 * The assistant message is persisted after generation completes, using the
 * accumulated full content. A lost write response is reconciled by request
 * identity before `done`; if durability remains unknown, the stream terminates
 * with a recovery-required error and the client retains that identity.
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
  requestId: string;
}): Promise<void> {
  const {
    service,
    history,
    enrichment,
    threadId,
    isNewThread,
    userMessage,
    res,
    log: logger,
    requestId,
  } = args;

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
  // `sources` rides along in the done-event metadata (#147 source attribution);
  // type it explicitly so a future refactor that rebuilds the persisted payload
  // from this local can't silently drop the citations.
  let metadata: {
    provider: string;
    model: string;
    latencyMs: number;
    sources?: MemorySource[];
  } | null = null;

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
          const assistantMessage = await assistantRepository.appendOrGetAssistantMessage(
            enrichment.userId,
            threadId,
            collectedFullContent,
            requestId,
            metadata,
          );
          send('done', assistantMessage);
        } catch {
          let reconciled: AssistantMessage | null = null;
          try {
            reconciled = await assistantRepository.findAssistantMessageByRequestId(
              enrichment.userId,
              requestId,
            );
          } catch {
            // The read is best-effort; an unavailable read leaves durability
            // ambiguous and must not be represented as terminal success.
          }
          if (reconciled?.threadId === threadId) {
            send('done', reconciled);
            res.end();
            return;
          }
          logger.warn('Assistant message durability unresolved after stream complete', {
            threadId,
            userId: enrichment.userId,
            errorCode: 'assistant_response_reconciliation_required',
          });
          send('error', {
            message: 'assistant_response_reconciliation_required',
            partialContent: collectedFullContent,
          });
        }
        res.end();
        return;
      } else if (event.type === 'error') {
        // Mid-stream failure with partial content already on screen.
        send('error', {
          message: 'assistant_stream_failed',
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
        errorCode: 'assistant_providers_failed',
      });
      send('error', {
        message: 'assistant_providers_failed',
        partialContent: '',
      });
    } else {
      logger.error('Unexpected error during assistant stream', {
        userId: enrichment.userId,
        threadId,
        errorCode: 'assistant_stream_failed',
      });
      send('error', {
        message: 'assistant_stream_failed',
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
   * Body: { userId, content, requestId, threadId? }
   *
   * If `threadId` is omitted, a new thread is created and `content` becomes
   * the first user message. The response includes the thread (so the
   * client can update its URL) and the assistant's reply message.
   *
   * Completed retries replay normally; unresolved request identities return
   * 202. Request-identity conflicts and unavailable provider configuration
   * return 409, provider generation failures return 502, and an approval whose
   * chat response cannot be reconciled returns 503.
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
      const { userId, content, threadId: providedThreadId, requestId } = validation;

      // The client request id owns one logical turn. A completed retry can be
      // replayed without invoking a provider or the decision pipeline again.
      const retriedUserMessage = await assistantRepository.findUserMessageByRequestId(
        userId,
        requestId,
      );
      if (
        retriedUserMessage &&
        (retriedUserMessage.content !== content ||
          (providedThreadId !== null && retriedUserMessage.threadId !== providedThreadId))
      ) {
        res.status(409).json({
          error: 'requestId was already used for a different message',
          code: 'assistant_request_id_conflict',
        });
        return;
      }
      if (retriedUserMessage) {
        const priorAssistant = await assistantRepository.findAssistantMessageByRequestId(
          userId,
          requestId,
        );
        if (priorAssistant) {
          if (priorAssistant.threadId !== retriedUserMessage.threadId) {
            res.status(409).json({
              error: 'requestId was already used for a different thread',
              code: 'assistant_request_id_conflict',
            });
            return;
          }
          const replayThread = {
            id: retriedUserMessage.threadId,
            isNew: false,
          };
          if ((req.headers['accept'] ?? '').toString().includes('text/event-stream')) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders?.();
            res.write(`event: thread\ndata: ${JSON.stringify(replayThread)}\n\n`);
            res.write(`event: user\ndata: ${JSON.stringify(retriedUserMessage)}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify(priorAssistant)}\n\n`);
            res.end();
          } else {
            res.json({
              thread: replayThread,
              userMessage: retriedUserMessage,
              assistantMessage: priorAssistant,
            });
          }
          return;
        }

        // Provider requests do not have a remote idempotency guarantee. Never
        // infer from elapsed time that a prior owner died and launch a second
        // provider call; a fresh attempt must use a fresh request id.
        res.status(202).json({
          status: 'unresolved',
          code: 'assistant_request_recovery_required',
          thread: { id: retriedUserMessage.threadId, isNew: false },
          userMessage: retriedUserMessage,
        });
        return;
      }

      const llmResolution = await resolveUserLlmClient(userId);
      const llm = llmResolution.client;
      if (!llm) {
        const blocked = llmResolution.state !== 'no_provider';
        res.status(409).json({
          error: blocked
            ? 'AI provider blocked by reasoning-location policy'
            : 'No AI provider configured',
          code: llmResolution.state,
          message: blocked
            ? `${llmResolution.reason}. Review Settings → AI brain.`
            : 'Configure at least one provider in Settings → AI brain before chatting with the assistant.',
        });
        return;
      }

      // Atomically establish the user message as the one owner of this
      // logical request. A concurrent loser observes created=false and never
      // enters the provider or action pipeline.
      let threadId: string;
      let isNewThread = false;
      let appended: { message: AssistantMessage; created: boolean };
      if (providedThreadId) {
        const existing = await assistantRepository.getThread(userId, providedThreadId);
        if (!existing) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }
        threadId = existing.thread.id;
        appended = await assistantRepository.appendOrGetUserMessage(
          userId,
          threadId,
          content,
          requestId,
        );
      } else {
        const created = await assistantRepository.createThreadWithUserMessage(
          userId,
          content,
          requestId,
        );
        threadId = created.thread.id;
        isNewThread = created.created;
        appended = { message: created.message, created: created.created };
      }

      const userMessage = appended.message;
      if (!appended.created) {
        if (
          userMessage.content !== content ||
          (providedThreadId !== null && userMessage.threadId !== providedThreadId)
        ) {
          res.status(409).json({
            error: 'requestId was already used for a different message',
            code: 'assistant_request_id_conflict',
          });
          return;
        }
        const priorAssistant = await assistantRepository.findAssistantMessageByRequestId(
          userId,
          requestId,
        );
        if (priorAssistant?.threadId === userMessage.threadId) {
          const replayThread = { id: userMessage.threadId, isNew: false };
          if ((req.headers['accept'] ?? '').toString().includes('text/event-stream')) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders?.();
            res.write(`event: thread\ndata: ${JSON.stringify(replayThread)}\n\n`);
            res.write(`event: user\ndata: ${JSON.stringify(userMessage)}\n\n`);
            res.write(`event: done\ndata: ${JSON.stringify(priorAssistant)}\n\n`);
            res.end();
          } else {
            res.json({
              thread: replayThread,
              userMessage,
              assistantMessage: priorAssistant,
            });
          }
          return;
        }
        res.status(202).json({
          status: 'unresolved',
          code: 'assistant_request_recovery_required',
          thread: { id: userMessage.threadId, isNew: false },
          userMessage,
        });
        return;
      }

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
      // produces a structured requires-approval, blocked, or visible failed
      // outcome, which is persisted without an LLM call. Only an unmatched or
      // explicit no-action result falls through to ordinary chat; safety-path
      // failures do not.
      const intentRoute = await service.routeIntent(userId, content, {
        idempotencyKey: userMessage.id,
      });
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
        let assistantMessage: AssistantMessage;
        if (intentRoute.outcome.kind === 'requires-approval') {
          try {
            assistantMessage = await appendKnownApprovalMessage(
              userId,
              threadId,
              intentRoute.outcome.approvalRequestId,
              bubbleContent,
              actionMetadata,
              requestId,
            );
          } catch {
            res.status(503).json({
              error:
                'The approval is queued, but its chat response needs reconciliation. Check Approvals before retrying.',
              code: 'assistant_response_reconciliation_required',
              approvalRequestId: intentRoute.outcome.approvalRequestId,
            });
            return;
          }
        } else {
          assistantMessage = await assistantRepository.appendOrGetAssistantMessage(
            userId,
            threadId,
            bubbleContent,
            requestId,
            actionMetadata,
          );
        }

        // Both sync + SSE paths land here; for SSE we still send the
        // wire shape clients expect (thread + user + done with the
        // action message in one shot — no chunk events because there
        // was no streaming text).
        const wantsStreamSse = (req.headers['accept'] ?? '')
          .toString()
          .includes('text/event-stream');
        if (wantsStreamSse) {
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders?.();
          res.write(
            `event: thread\ndata: ${JSON.stringify({ id: threadId, isNew: isNewThread })}\n\n`,
          );
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
          requestId,
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
            errorCode: 'assistant_providers_failed',
          });
          res.status(502).json({
            error: 'Assistant generation failed',
            code: 'assistant_providers_failed',
          });
          return;
        }
        log.error('Unexpected assistant generation failure', {
          userId,
          threadId,
          errorCode: 'assistant_generation_failed',
        });
        res.status(502).json({
          error: 'Assistant generation failed',
          code: 'assistant_generation_failed',
        });
        return;
      }

      const assistantMessage = await assistantRepository.appendOrGetAssistantMessage(
        userId,
        threadId,
        reply.content,
        requestId,
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

  /**
   * POST /api/assistant/install-suggestion
   *
   * Issue #322. The mirror of `/api/capabilities/reverse-capability-intent`:
   * given a user message + the assistant's reply that just refused to act
   * because a tool isn't installed, suggest which UNINSTALLED registry
   * capabilities would unblock the next attempt. The chat UI calls this
   * after an assistant reply to render "Connect X" affordances inline.
   *
   * Body: { userMessage: string, assistantReply: string }
   * Returns: { intentDetected: boolean, suggestions: Array<{
   *   registryId: string, displayName: string, reason: string, confidence: number
   * }>, reason?: string }
   *
   * Adaptive path: runs the `capability-install-suggestion` prompt with the
   * user's installed-capability list (excluded from suggestions) plus the
   * full registry (allowed candidate set).
   * Deterministic fallback: `{ intentDetected: false, suggestions: [],
   * reason: 'no_llm_configured' }` — the browser falls through to its
   * existing keyword heuristic when the response signals no LLM.
   */
  router.post('/install-suggestion', async (req, res, next) => {
    try {
      const userId: string | undefined =
        (req as unknown as { user?: { id?: string } }).user?.id ??
        (req.query['userId'] as string | undefined);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { userMessage?: unknown; assistantReply?: unknown } | undefined;
      if (
        typeof body?.userMessage !== 'string' ||
        !body.userMessage.trim() ||
        typeof body?.assistantReply !== 'string' ||
        !body.assistantReply.trim()
      ) {
        res.status(400).json({
          error: 'userMessage and assistantReply must be non-empty strings',
        });
        return;
      }
      // Cap input size — protect the prompt budget from a direct API
      // client posting megabytes of text. Mirrors the 16KB cap that
      // `validateAssistantMessage` enforces on the chat path.
      // Copilot caught the unbounded version.
      const MAX_INPUT_BYTES = 16 * 1024;
      if (
        Buffer.byteLength(body.userMessage, 'utf8') > MAX_INPUT_BYTES ||
        Buffer.byteLength(body.assistantReply, 'utf8') > MAX_INPUT_BYTES
      ) {
        res.status(413).json({
          error: `userMessage and assistantReply each must be <= ${MAX_INPUT_BYTES} bytes`,
        });
        return;
      }

      const llmResolution = await resolveUserLlmClient(userId);
      const llmClient = llmResolution.client;
      if (!llmClient) {
        // No LLM configured — browser falls through to its heuristic.
        res.json({
          intentDetected: false,
          suggestions: [],
          reason: llmResolution.state === 'no_provider' ? 'no_llm_configured' : llmResolution.state,
        });
        return;
      }

      // Build the prompt inputs:
      //   - installed_capabilities: user's CURRENTLY-INSTALLED MCP
      //     servers — anything they could actually use right now. Excludes
      //     status='uninstalled' / 'failed' / 'discovered' (never wired
      //     up). Those are eligible for a re-suggest if the prompt
      //     decides they fit. Copilot caught the prior all-rows filter
      //     as excluding previously-uninstalled capabilities forever.
      //   - available_capabilities: the curated registry (the allowed
      //     candidate set the prompt picks from)
      // RegistryClient is a tiny in-process JSON read — no I/O cost.
      const registry = new RegistryClient();
      const [allRows, registryEntries] = await Promise.all([
        mcpServerRepository.listForUser(userId),
        registry.getAll(),
      ]);
      const googleConnectionMode = loadConfig().googleConnectionMode;
      const visibleRows = allRows.filter((row) => !isGoogleCapabilityBlocked(
        googleConnectionMode,
        { registryId: row.registry_id, oauthProvider: row.oauth_provider },
      ));
      const visibleRegistryEntries = registryEntries.filter((entry) => !isGoogleCapabilityBlocked(
        googleConnectionMode,
        { registryId: entry.id, oauthProvider: entry.oauthProvider },
      ));

      // "Installed" for the purpose of the prompt = the user could
      // actually invoke the tool right now. Anything paused/dormant
      // counts (they configured it; pausing is reversible). Anything
      // explicitly uninstalled / never installed / failed does NOT
      // count — the user might want to re-try those.
      const NON_INSTALLED_STATUSES = new Set(['uninstalled', 'failed', 'discovered']);
      const installedRows = visibleRows.filter((row) => !NON_INSTALLED_STATUSES.has(row.status));
      const installedRegistryIds = new Set(
        installedRows
          .map((row) => row.registry_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      );

      // Project to the minimum shape the prompt needs.
      const installed = installedRows.map((row) => ({
        id: row.registry_id ?? '',
        name: row.display_name,
      }));
      const available = visibleRegistryEntries
        // Don't include already-installed in the available set — the
        // prompt's constraints already say "don't suggest installed"
        // but giving the LLM only the eligible set keeps it focused
        // and reduces the chance it hallucinates a no-installed reason.
        .filter((entry) => !installedRegistryIds.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          name: entry.displayName,
          description: entry.description ?? '',
        }));
      // Build a lookup set of the registry-allowed IDs so the response
      // can drop any suggestion id the model hallucinated or that came
      // from a prompt-injection attempt. Copilot caught the original
      // version as trusting any schema-valid id.
      const allowedSuggestionIds = new Set(available.map((entry) => entry.id));

      // Template expects {{installed_capabilities}}, {{available_capabilities}},
      // {{user_message}}, {{assistant_reply}}.
      try {
        const result = await runPrompt<{
          intent_detected: boolean;
          suggestions: Array<{
            id: string;
            name: string;
            reason: string;
            confidence: number;
          }>;
          reason?: string;
        }>({
          promptName: 'capability-install-suggestion',
          inputs: {
            installed_capabilities: installed,
            available_capabilities: available,
            user_message: body.userMessage,
            assistant_reply: body.assistantReply,
          },
          user: { userId },
          llmClient,
          invocationKind: 'interactive',
        });

        if (result.fellBackToDeterministic) {
          res.json({
            intentDetected: false,
            suggestions: [],
            reason: 'provider_unavailable',
          });
          return;
        }

        const out = result.output;
        // Translate snake_case → camelCase at the boundary. The browser
        // contract uses camelCase (matches the existing assistant.js
        // patterns); the prompt's schema is snake_case to match the
        // other prompts in this package.
        res.json({
          intentDetected: out.intent_detected === true,
          suggestions: out.suggestions
            // Drop anything the LLM hallucinated or that doesn't match
            // a real registry entry. Suggestions whose id isn't in
            // `allowedSuggestionIds` (the uninstalled-registry candidate
            // set) cannot lead to a working install — render only the
            // ones the install flow will actually accept. Also drops
            // already-installed leakage (those ids never make it into
            // `allowedSuggestionIds`).
            .filter((s) => allowedSuggestionIds.has(s.id))
            .map((s) => ({
              registryId: s.id,
              displayName: s.name,
              reason: s.reason,
              confidence: s.confidence,
            })),
          ...(typeof out.reason === 'string' ? { reason: out.reason } : {}),
        });
      } catch (err) {
        log.warn('capability-install-suggestion prompt failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Fail-soft to the no-suggestion branch while preserving the actual
        // failure class; the browser heuristic covers user-visible UX.
        res.json({
          intentDetected: false,
          suggestions: [],
          reason: 'prompt_failed',
        });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
