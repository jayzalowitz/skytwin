import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';
import type { OAuthTokenStore } from './oauth/token-store.js';
import { withRetry, RetryableHttpError, parseRetryAfter, normalizeSenderAddress } from '@skytwin/core';
import {
  classifyEmailAuthoringTier,
  splitAddressList,
  type AuthoringTier,
} from './authoring-tier.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
  internalDate: string;
  /** Present on full-format message detail responses. */
  historyId?: string;
}

/**
 * Persistent cursor store. Wired to `@skytwin/db.connectorCursorRepository`
 * by the worker; tests pass an in-memory stub. The connector package itself
 * stays free of any DB dependency.
 */
export interface CursorStore {
  get(userId: string, provider: string, kind: string): Promise<string | null>;
  save(userId: string, provider: string, kind: string, value: string): Promise<void>;
}

/**
 * Sink for `(sender, label)` evidence drawn from each fetched message.
 *
 * Issue #122: every Gmail message we observe contributes one row per
 * `(user_id, sender, label)` to the per-user label model that
 * `inferLabels()` consults. Wired to
 * `@skytwin/db.emailLabelRepository.recordObservations` in production; tests
 * pass an in-memory stub or omit it entirely. The connector stays free of
 * any DB dependency.
 *
 * `sender` arrives normalized (display name stripped, lowercased, must
 * contain `@`) — both sides of the lookup must agree on the normalization
 * or the decision-engine's per-sender query misses.
 */
export interface LabelObserver {
  recordObservations(
    userId: string,
    observations: Array<{ sender: string; label: string; listId?: string | null }>,
  ): Promise<void>;
}

const HISTORY_ID_KIND = 'history_id';

/**
 * Gmail connector backed by the History API.
 *
 * On first poll for a user (no stored cursor), we list a recent batch of
 * unread messages and store the latest historyId we observe. On every
 * subsequent poll we hit `users/me/history?startHistoryId=<stored>` to get
 * only the deltas — typically 0 or a handful of message ids per minute,
 * versus "every still-unread message in the inbox" with the previous
 * `is:unread` query.
 *
 * If the stored historyId is older than ~7 days Gmail returns 404 — we
 * detect that and re-bootstrap rather than hard-failing.
 */
export class GmailConnector implements SignalConnector {
  readonly name = 'gmail';

  private handlers: SignalHandler[] = [];
  private connected = false;
  private readonly userId: string;
  private readonly tokenStore: OAuthTokenStore;
  private readonly cursorStore: CursorStore | null;
  private readonly labelObserver: LabelObserver | null;
  /** In-memory mirror of the persisted cursor for the current session. */
  private historyId: string | null = null;

  constructor(
    userId: string,
    tokenStore: OAuthTokenStore,
    cursorStore: CursorStore | null = null,
    labelObserver: LabelObserver | null = null,
  ) {
    this.userId = userId;
    this.tokenStore = tokenStore;
    this.cursorStore = cursorStore;
    this.labelObserver = labelObserver;
  }

  async connect(): Promise<void> {
    const token = await this.tokenStore.refreshIfExpired(this.userId, 'google');
    if (!token) {
      throw new Error('No Google OAuth token available. User must authorize first.');
    }
    if (this.cursorStore) {
      this.historyId = await this.cursorStore.get(this.userId, 'gmail', HISTORY_ID_KIND);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers = [];
    this.historyId = null;
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('GmailConnector is not connected. Call connect() first.');
    }

    const accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'google')).accessToken;

    if (this.historyId === null) {
      // First poll for this user: bootstrap the cursor from a small batch
      // of recent unread mail. We surface those messages as signals on
      // first run so the user sees something immediately, then advance the
      // cursor to the latest historyId observed.
      return this.bootstrapAndEmit(accessToken);
    }

    return this.pollHistorySince(accessToken, this.historyId);
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  // ── First-run bootstrap ───────────────────────────────────────────────

  /**
   * No cursor yet — bootstrap by listing recent sent + unread mail, emit
   * them as signals, then store the highest historyId we observed so the
   * next poll switches to incremental mode.
   *
   * #251 Layer 3 (minimal): sent mail is fetched FIRST so the user's first-
   * impression brain pages lead with things they wrote themselves rather
   * than with whatever happened to be unread in the inbox. The two batches
   * are deduped by message id, sent ids are processed first, and
   * historyId-derived cursor advancement is unchanged (the cursor still
   * picks the max across all observed messages).
   */
  private async bootstrapAndEmit(accessToken: string): Promise<RawSignal[]> {
    const sentUrl = `${GMAIL_API}/users/me/messages?q=${encodeURIComponent('in:sent newer_than:7d')}&maxResults=10`;
    const unreadUrl = `${GMAIL_API}/users/me/messages?q=${encodeURIComponent('is:unread newer_than:1d')}&maxResults=10`;

    const sentIds = await this.listMessageIds(sentUrl, accessToken);
    const unreadIds = await this.listMessageIds(unreadUrl, accessToken);

    // Dedupe while preserving sent-first ordering.
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of [...sentIds, ...unreadIds]) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    if (ids.length === 0) {
      // Even with no messages we want a cursor for next poll. Use the
      // mailbox's current historyId from /users/me/profile.
      const profile = await this.fetchProfileHistoryId(accessToken);
      if (profile) await this.persistCursor(profile);
      return [];
    }

    const { signals, maxHistoryId } = await this.fetchAndConvert(ids, accessToken);
    if (maxHistoryId) await this.persistCursor(maxHistoryId);
    return signals;
  }

  /**
   * Helper: GET a `users/me/messages?q=...` listing and return the message
   * ids. Only transient failures (rate-limit / 5xx after retries) degrade
   * to `[]` so Layer 3 bootstrap can still serve the first-impression need
   * from the other batch. Non-transient failures (persistent auth, 4xx
   * other than 404, malformed account state) propagate so the worker
   * surfaces "your Google connection has a problem" instead of silently
   * doing nothing forever — Copilot caught this on PR #252.
   */
  private async listMessageIds(url: string, accessToken: string): Promise<string[]> {
    try {
      const resp = await this.gmailGet(url, accessToken, 'list');
      const body = await resp.json() as { messages?: Array<{ id: string }> };
      return (body.messages ?? []).map((m) => m.id);
    } catch (err) {
      if (err instanceof RetryableHttpError) {
        console.warn(
          `[gmail] Transient bootstrap list failure (${url}): ${err.message}`,
        );
        return [];
      }
      throw err;
    }
  }

  // ── Incremental polling ───────────────────────────────────────────────

  /**
   * Get all `messageAdded` deltas since `startHistoryId`. Gmail returns
   * 404 if the cursor is older than its retention window (~7 days) — in
   * that case we treat the cursor as lost and re-bootstrap.
   */
  private async pollHistorySince(accessToken: string, startHistoryId: string): Promise<RawSignal[]> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: '100',
    });
    const historyUrl = `${GMAIL_API}/users/me/history?${params.toString()}`;

    let resp: Response;
    try {
      resp = await this.gmailGet(historyUrl, accessToken, 'history');
    } catch (err) {
      // history.list returns 404 when startHistoryId is too old. We don't
      // throw a retryable error for 404 (it'd just keep failing), so the
      // gmailGet wrapper passes it through as a regular error message.
      if (err instanceof Error && err.message.includes('404')) {
        console.warn(`[gmail] History cursor too old for user ${this.userId} — re-bootstrapping`);
        this.historyId = null;
        return this.bootstrapAndEmit(accessToken);
      }
      throw err;
    }

    const body = await resp.json() as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      historyId?: string;
    };

    // Collect new message ids (deduped — a single thread can show up in
    // multiple history records as labels change).
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const entry of body.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (!seen.has(added.message.id)) {
          seen.add(added.message.id);
          ids.push(added.message.id);
        }
      }
    }

    let maxHistoryId = body.historyId ?? startHistoryId;
    let signals: RawSignal[] = [];
    if (ids.length > 0) {
      const result = await this.fetchAndConvert(ids, accessToken);
      signals = result.signals;
      // Prefer the larger of (response historyId, max observed message historyId).
      // Both are strings of monotonically-increasing integers; compare numerically.
      if (result.maxHistoryId && Number(result.maxHistoryId) > Number(maxHistoryId)) {
        maxHistoryId = result.maxHistoryId;
      }
    }

    if (maxHistoryId !== startHistoryId) {
      await this.persistCursor(maxHistoryId);
    }
    return signals;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async fetchAndConvert(
    ids: string[],
    accessToken: string,
  ): Promise<{ signals: RawSignal[]; maxHistoryId: string | null }> {
    const signals: RawSignal[] = [];
    let maxHistoryId: string | null = null;

    for (const id of ids) {
      const detail = await this.fetchMessageDetail(id, accessToken);
      if (!detail) continue;

      if (detail.historyId) {
        if (!maxHistoryId || Number(detail.historyId) > Number(maxHistoryId)) {
          maxHistoryId = detail.historyId;
        }
      }

      const signal = this.messageToSignal(detail);
      signals.push(signal);

      // Issue #122: record (sender, label) evidence for the per-user label
      // model. Awaited so the writes are ordered relative to the signal
      // emission, but the call is exception-safe — observer failure must
      // not silence handlers.
      await this.recordLabelObservations(detail);

      for (const handler of this.handlers) {
        handler(signal);
      }
    }
    return { signals, maxHistoryId };
  }

  private async fetchProfileHistoryId(accessToken: string): Promise<string | null> {
    try {
      const resp = await this.gmailGet(`${GMAIL_API}/users/me/profile`, accessToken, 'profile');
      const body = await resp.json() as { historyId?: string };
      return body.historyId ?? null;
    } catch {
      return null;
    }
  }

  private async persistCursor(historyId: string): Promise<void> {
    this.historyId = historyId;
    if (this.cursorStore) {
      try {
        await this.cursorStore.save(this.userId, 'gmail', HISTORY_ID_KIND, historyId);
      } catch (err) {
        console.warn(
          `[gmail] Failed to persist history cursor for ${this.userId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Wrap a Gmail GET with token-refresh handling and retry on the usual
   * transient codes. 404 is *not* retried — the caller decides what 404
   * means (history.list uses it for "cursor expired").
   */
  private async gmailGet(url: string, initialToken: string, label: string): Promise<Response> {
    let accessToken = initialToken;
    return withRetry(async () => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.ok) return response;
      if (response.status === 401) {
        accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'google')).accessToken;
        throw new RetryableHttpError(401, `Gmail ${label}: token expired`, null);
      }
      if ([429, 500, 502, 503].includes(response.status)) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        throw new RetryableHttpError(
          response.status,
          `Gmail ${label} failed: ${response.status}`,
          retryAfterMs,
        );
      }
      throw new Error(`Gmail ${label} failed: ${response.status}`);
    }, { maxRetries: 3, baseDelayMs: 1000 });
  }

  private async fetchMessageDetail(
    messageId: string,
    accessToken: string,
  ): Promise<GmailMessage | null> {
    // #251 Layer 1: classifier reads To/Cc (recipient count → broadcast vs.
    // personal), In-Reply-To (originated vs. reply for SENT mail), and
    // List-Unsubscribe (newsletter detection beyond CATEGORY_PROMOTIONS).
    // Adding these to metadataHeaders is cheap — Gmail returns one extra
    // header value per requested name and we only fetch when present.
    const url = `${GMAIL_API}/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Id&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=In-Reply-To&metadataHeaders=List-Unsubscribe`;
    try {
      const response = await this.gmailGet(url, accessToken, 'detail');
      return response.json() as Promise<GmailMessage>;
    } catch (error) {
      console.warn(
        `[gmail] Error fetching message ${messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  private messageToSignal(message: GmailMessage): RawSignal {
    const getHeader = (name: string): string => {
      const header = message.payload.headers.find(
        (h) => h.name.toLowerCase() === name.toLowerCase(),
      );
      return header?.value ?? '';
    };

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const listId = parseListId(getHeader('List-Id'));
    const type = this.inferEmailType(from, subject, message.labelIds);
    const authoringTier: AuthoringTier = classifyEmailAuthoringTier({
      labels: message.labelIds ?? [],
      fromAddress: from,
      toAddresses: splitAddressList(getHeader('To')),
      ccAddresses: splitAddressList(getHeader('Cc')),
      hasInReplyTo: getHeader('In-Reply-To').trim().length > 0,
      hasListUnsubscribe: getHeader('List-Unsubscribe').trim().length > 0,
      listId,
    });

    return {
      id: `sig_gmail_${message.id}`,
      source: 'gmail',
      type,
      data: {
        messageId: message.id,
        threadId: message.threadId,
        from,
        subject,
        snippet: message.snippet,
        labels: message.labelIds,
        listId,
        authoringTier,
        receivedAt: new Date(parseInt(message.internalDate, 10)).toISOString(),
        requiresResponse: type === 'work_email' || type === 'meeting_invite',
      },
      timestamp: new Date(parseInt(message.internalDate, 10)),
    };
  }

  /**
   * Push every observed `(sender, label)` tuple from this message into the
   * label model. Issue #122 — this is the layer-2 mining step. We swallow
   * errors (the observer is best-effort: a label-store outage must not stop
   * signal ingestion). Returns silently when no observer is wired.
   *
   * Sender is normalized here to match the lookup-side normalization in
   * `decision-maker.ts:normalizeSender`. Both sides must agree.
   */
  private async recordLabelObservations(message: GmailMessage): Promise<void> {
    if (!this.labelObserver) return;
    if (!message.labelIds || message.labelIds.length === 0) return;

    const fromHeader = message.payload.headers.find(
      (h) => h.name.toLowerCase() === 'from',
    )?.value ?? '';
    const sender = normalizeSenderAddress(fromHeader);
    if (!sender) return;

    const listId = parseListId(
      message.payload.headers.find((h) => h.name.toLowerCase() === 'list-id')?.value ?? '',
    );

    const observations = message.labelIds.map((label) => ({
      sender,
      label,
      listId: listId || null,
    }));

    try {
      await this.labelObserver.recordObservations(this.userId, observations);
    } catch (err) {
      console.warn(
        `[gmail] Failed to record label observations for ${this.userId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private inferEmailType(from: string, subject: string, labels: string[]): string {
    const lowerSubject = subject.toLowerCase();
    const lowerFrom = from.toLowerCase();

    if (labels.includes('CATEGORY_PROMOTIONS') || lowerSubject.includes('newsletter') || lowerSubject.includes('digest')) {
      return 'newsletter';
    }
    if (lowerSubject.includes('subscription') || lowerSubject.includes('renewal') || lowerSubject.includes('billing')) {
      return 'subscription_renewal';
    }
    if (lowerSubject.includes('meeting') || lowerSubject.includes('invite') || lowerSubject.includes('calendar')) {
      return 'meeting_invite';
    }
    if (lowerSubject.includes('order') || lowerSubject.includes('delivery') || lowerSubject.includes('grocery')) {
      return 'grocery_reorder';
    }
    if (lowerSubject.includes('flight') || lowerSubject.includes('hotel') || lowerSubject.includes('travel') || lowerSubject.includes('booking')) {
      return 'travel_alert';
    }
    if (lowerFrom.includes('noreply') || lowerFrom.includes('no-reply') || labels.includes('CATEGORY_UPDATES')) {
      return 'notification';
    }
    return 'work_email';
  }
}

// `normalizeSenderAddress` previously lived here as a local function and was
// duplicated in `decision-maker.ts:normalizeSender`. Both copies had to stay
// in sync (write side here, read side there), and any divergence silently
// broke every per-sender label lookup. Issue #122 follow-up moved the single
// implementation to `@skytwin/core` — re-exported here so existing imports
// from `@skytwin/connectors` keep working.
export { normalizeSenderAddress } from '@skytwin/core';

/**
 * Parse the RFC 2919 `List-Id` header down to its bare identifier.
 *
 * `List-Id: "Black Rock Rangers" <rangers.lists.example.org>` →
 * `rangers.lists.example.org`. When the header is missing or malformed
 * we return `''` so callers can skip storing a list_id.
 */
export function parseListId(raw: string): string {
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  // Some senders ship the bare identifier with no angle brackets.
  return raw.trim().toLowerCase();
}

