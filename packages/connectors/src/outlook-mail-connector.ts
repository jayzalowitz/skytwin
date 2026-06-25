import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';
import type { OAuthTokenStore } from './oauth/token-store.js';
import { parseListId, type CursorStore } from './gmail-connector.js';
import { withRetry, RetryableHttpError, parseRetryAfter } from '@skytwin/core';
import { classifyEmailAuthoringTier, type AuthoringTier } from './authoring-tier.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

/**
 * Cursor kind for the Microsoft Graph delta link. The same `CursorStore` the
 * Gmail connector uses (wired to `connectorCursorRepository` by the worker);
 * we store the opaque Graph continuation token — a `@odata.nextLink` while the
 * initial sync is still draining, then a `@odata.deltaLink` once caught up.
 */
const DELTA_LINK_KIND = 'delta_link';

/**
 * Pages drained per `poll()`. Graph's initial delta returns the whole inbox
 * across paginated `@odata.nextLink`s; capping per poll spreads the first sync
 * over a few cycles instead of pulling everything at once, then settles into
 * change-only deltas. `$top` bounds each page.
 */
const MAX_PAGES_PER_POLL = 5;
const PAGE_SIZE = 25;

// Only the fields the signal + authoring-tier classifier need. `bodyPreview`
// is Graph's snippet; `internetMessageHeaders` carries In-Reply-To /
// List-Unsubscribe / List-Id (the inbound-tier signals Gmail reads from
// headers).
const MSG_SELECT =
  'id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,internetMessageHeaders';

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}
interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  /** Present on delta *tombstones* (a deleted message) — never a real message. */
  '@removed'?: { reason?: string };
}
interface GraphDeltaPage {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/**
 * Outlook (Microsoft Graph) mail connector — the Microsoft counterpart to
 * `GmailConnector`. Polls the inbox with Graph's delta query and emits one
 * `RawSignal` per message, stamped with the same `AuthoringTier` the Gmail
 * path produces so downstream tier-weighted retrieval treats Outlook and
 * Gmail mail identically.
 *
 * Cursor model (delta vs Gmail's historyId): first poll starts a fresh delta
 * on the inbox and stores the continuation token; subsequent polls follow it.
 * Graph returns **410 Gone** when a deltaLink has aged out — we detect that
 * and re-bootstrap rather than hard-failing (mirrors Gmail's 404 path).
 *
 * Scope note (v1): inbound inbox mail only. Sent-mail capture (the
 * `user_sent_*` tiers — Gmail bootstraps sent-first per #251 Layer 3) is a
 * follow-up; it needs a parallel delta on the Sent Items folder.
 */
export class OutlookMailConnector implements SignalConnector {
  readonly name = 'outlook_mail';

  private handlers: SignalHandler[] = [];
  private connected = false;
  private readonly userId: string;
  private readonly tokenStore: OAuthTokenStore;
  private readonly cursorStore: CursorStore | null;
  /** In-memory mirror of the persisted delta/continuation link for this session. */
  private deltaLink: string | null = null;

  constructor(userId: string, tokenStore: OAuthTokenStore, cursorStore: CursorStore | null = null) {
    this.userId = userId;
    this.tokenStore = tokenStore;
    this.cursorStore = cursorStore;
  }

  async connect(): Promise<void> {
    const token = await this.tokenStore.refreshIfExpired(this.userId, 'microsoft');
    if (!token) {
      throw new Error('No Microsoft OAuth token available. User must authorize first.');
    }
    if (this.cursorStore) {
      this.deltaLink = await this.cursorStore.get(this.userId, 'outlook', DELTA_LINK_KIND);
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers = [];
    this.deltaLink = null;
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('OutlookMailConnector is not connected. Call connect() first.');
    }
    const accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'microsoft')).accessToken;
    // Start a fresh delta when we have no cursor, else resume the stored one.
    return this.drainDelta(this.deltaLink ?? this.freshDeltaUrl(), accessToken);
  }

  private freshDeltaUrl(): string {
    return `${GRAPH_API}/me/mailFolders/inbox/messages/delta?$select=${MSG_SELECT}&$top=${PAGE_SIZE}`;
  }

  /**
   * Follow a delta chain for up to `MAX_PAGES_PER_POLL` pages, emitting a
   * signal per message. Persists the last continuation token seen (a
   * `@odata.nextLink` if the sync is still draining, otherwise the
   * `@odata.deltaLink`) so the next poll resumes exactly where this one left
   * off. Stops early at the page cap to bound a single poll's work.
   *
   * 410 handling lives here so it can't double-emit: a 410 on the FIRST
   * request means the stored delta link is stale → reset and restart once from
   * a fresh delta. A 410 *after* we've already emitted earlier pages does NOT
   * restart (that would re-fire handlers for those messages) — we stop and
   * return what we have; the next poll resumes from the last persisted cursor.
   */
  private async drainDelta(startUrl: string, accessToken: string): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];
    let url: string | undefined = startUrl;
    let pages = 0;
    let nextCursor: string | undefined;
    let rebootstrapped = false;

    while (url && pages < MAX_PAGES_PER_POLL) {
      let resp: Response;
      try {
        resp = await this.graphGet(url, accessToken, 'delta');
      } catch (err) {
        if (err instanceof Error && err.message.includes('410')) {
          if (signals.length === 0 && !rebootstrapped) {
            console.warn(`[outlook] delta link expired for user ${this.userId} — re-bootstrapping`);
            this.deltaLink = null;
            rebootstrapped = true;
            url = this.freshDeltaUrl();
            continue;
          }
          console.warn(`[outlook] delta link expired mid-sync for user ${this.userId} — returning partial`);
          break;
        }
        throw err;
      }

      const body = (await resp.json()) as GraphDeltaPage;
      for (const msg of body.value ?? []) {
        if (!msg || typeof msg.id !== 'string') continue;
        // Skip deletion tombstones (carry `@removed`, no real body) and any
        // message with no `receivedDateTime` — fabricating "now" would
        // mis-rank it as just-arrived.
        if ('@removed' in msg) continue;
        if (!msg.receivedDateTime) continue;
        const signal = this.messageToSignal(msg);
        signals.push(signal);
        for (const handler of this.handlers) handler(signal);
      }

      pages += 1;
      if (body['@odata.deltaLink']) {
        nextCursor = body['@odata.deltaLink'];
        url = undefined; // caught up — stop
      } else if (body['@odata.nextLink']) {
        nextCursor = body['@odata.nextLink'];
        url = body['@odata.nextLink']; // more pages this poll (up to the cap)
      } else {
        url = undefined;
      }
    }

    if (nextCursor) await this.persistCursor(nextCursor);
    return signals;
  }

  private async persistCursor(link: string): Promise<void> {
    this.deltaLink = link;
    if (this.cursorStore) {
      try {
        await this.cursorStore.save(this.userId, 'outlook', DELTA_LINK_KIND, link);
      } catch (err) {
        console.warn(
          `[outlook] Failed to persist delta cursor for ${this.userId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private headerValue(headers: GraphMessage['internetMessageHeaders'], name: string): string {
    if (!headers) return '';
    const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
    return h?.value?.trim() ?? '';
  }

  private addressOf(r: GraphRecipient | undefined): string {
    const ea = r?.emailAddress;
    if (!ea) return '';
    if (ea.name && ea.address) return `${ea.name} <${ea.address}>`;
    return ea.address ?? ea.name ?? '';
  }

  private bareAddresses(rs: GraphRecipient[] | undefined): string[] {
    return (rs ?? []).map((r) => r.emailAddress?.address ?? '').filter((a) => a.length > 0);
  }

  /**
   * Convert a Graph message into a `RawSignal`, matching the Gmail connector's
   * data shape so the decision pipeline + tier-backfill treat both identically.
   */
  private messageToSignal(msg: GraphMessage): RawSignal {
    const from = this.addressOf(msg.from);
    const subject = msg.subject ?? '';
    const toBare = this.bareAddresses(msg.toRecipients);
    const ccBare = this.bareAddresses(msg.ccRecipients);
    const inReplyTo = this.headerValue(msg.internetMessageHeaders, 'In-Reply-To');
    const listUnsubscribe = this.headerValue(msg.internetMessageHeaders, 'List-Unsubscribe');
    // Normalize the raw `List-Id` header to the bare identifier, matching the
    // Gmail connector (e.g. `<rangers.lists.example.org>` → `rangers.lists.example.org`)
    // so the signal shape + downstream listId comparisons line up across both.
    const listId = parseListId(this.headerValue(msg.internetMessageHeaders, 'List-Id'));
    const type = this.inferEmailType(from, subject);

    // Inbox mail is inbound, so we hand the classifier an `INBOX` label (no
    // `SENT`); the inbound tier (personal / broadcast / newsletter / automated)
    // is then driven by the same header signals Gmail uses.
    const authoringTier: AuthoringTier = classifyEmailAuthoringTier({
      labels: ['INBOX'],
      fromAddress: from,
      toAddresses: toBare,
      ccAddresses: ccBare,
      hasInReplyTo: inReplyTo.length > 0,
      hasListUnsubscribe: listUnsubscribe.length > 0,
      listId,
    });

    const receivedAt = msg.receivedDateTime ?? new Date().toISOString();
    return {
      id: `sig_outlook_${msg.id}`,
      source: 'outlook',
      type,
      data: {
        messageId: msg.id,
        conversationId: msg.conversationId ?? null,
        from,
        to: toBare.join(', '),
        cc: ccBare.join(', '),
        inReplyTo,
        listUnsubscribe,
        subject,
        snippet: msg.bodyPreview ?? '',
        listId,
        authoringTier,
        receivedAt,
        requiresResponse: type === 'work_email' || type === 'meeting_invite',
      },
      timestamp: new Date(receivedAt),
    };
  }

  /**
   * Heuristic message type, mirroring the Gmail connector's `inferEmailType`
   * (minus the Gmail-only category labels — Outlook has no `CATEGORY_*`).
   */
  private inferEmailType(from: string, subject: string): string {
    const s = subject.toLowerCase();
    const f = from.toLowerCase();
    if (s.includes('newsletter') || s.includes('digest')) return 'newsletter';
    if (s.includes('subscription') || s.includes('renewal') || s.includes('billing')) return 'subscription_renewal';
    if (s.includes('meeting') || s.includes('invite') || s.includes('calendar')) return 'meeting_invite';
    if (s.includes('order') || s.includes('delivery') || s.includes('grocery')) return 'grocery_reorder';
    if (s.includes('flight') || s.includes('hotel') || s.includes('travel') || s.includes('booking')) return 'travel_alert';
    if (f.includes('noreply') || f.includes('no-reply')) return 'notification';
    return 'work_email';
  }

  /**
   * GET a Graph URL with token-refresh + transient-retry handling. 401 →
   * refresh the token and retry; 429/5xx → retryable with the server's
   * Retry-After; 410 (delta expired) and other 4xx → a plain Error the caller
   * inspects (poll() re-bootstraps on 410).
   */
  private async graphGet(url: string, initialToken: string, label: string): Promise<Response> {
    let accessToken = initialToken;
    return withRetry(
      async () => {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (response.ok) return response;
        if (response.status === 401) {
          accessToken = (await this.tokenStore.refreshIfExpired(this.userId, 'microsoft')).accessToken;
          throw new RetryableHttpError(401, `Graph ${label}: token expired`, null);
        }
        if ([429, 500, 502, 503, 504].includes(response.status)) {
          // Graph prefers `Retry-After`; fall back to its RateLimit reset hint.
          const retryAfterMs =
            parseRetryAfter(response.headers.get('Retry-After')) ??
            parseRetryAfter(response.headers.get('RateLimit-Reset-After'));
          throw new RetryableHttpError(response.status, `Graph ${label} failed: ${response.status}`, retryAfterMs);
        }
        throw new Error(`Graph ${label} failed: ${response.status}`);
      },
      { maxRetries: 3, baseDelayMs: 1000 },
    );
  }
}
