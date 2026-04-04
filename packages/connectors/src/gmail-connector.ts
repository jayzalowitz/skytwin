import type { SignalConnector, RawSignal, SignalHandler } from './connector-interface.js';
import type { OAuthTokenStore } from './oauth/token-store.js';
import { withRetry, RetryableHttpError, parseRetryAfter } from '@skytwin/core';

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
}

/**
 * Gmail connector that polls for new messages via the Gmail API.
 * Implements SignalConnector for the SkyTwin decision pipeline.
 */
export class GmailConnector implements SignalConnector {
  readonly name = 'gmail';

  private handlers: SignalHandler[] = [];
  private connected = false;
  private lastHistoryId: string | null = null;
  private readonly userId: string;
  private readonly tokenStore: OAuthTokenStore;

  constructor(userId: string, tokenStore: OAuthTokenStore) {
    this.userId = userId;
    this.tokenStore = tokenStore;
  }

  async connect(): Promise<void> {
    // Validate that we have a token and it's not expired
    const token = await this.tokenStore.refreshIfExpired(this.userId, 'google');
    if (!token) {
      throw new Error('No Google OAuth token available. User must authorize first.');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers = [];
    this.lastHistoryId = null;
  }

  async poll(): Promise<RawSignal[]> {
    if (!this.connected) {
      throw new Error('GmailConnector is not connected. Call connect() first.');
    }

    // List recent unread messages
    const query = this.lastHistoryId
      ? `is:unread`
      : `is:unread newer_than:1d`;

    const listUrl = `${GMAIL_API}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=10`;

    const listResponse = await withRetry(async () => {
      const currentToken = await this.tokenStore.refreshIfExpired(this.userId, 'google');
      const response = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${currentToken.accessToken}` },
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Token expired — refresh will happen on next attempt
          throw new RetryableHttpError(401, 'Gmail token expired', null);
        }
        if ([429, 500, 502, 503].includes(response.status)) {
          const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
          throw new RetryableHttpError(response.status, `Gmail API list failed: ${response.status}`, retryAfterMs);
        }
        throw new Error(`Gmail API list failed: ${response.status}`);
      }

      return response;
    }, { maxRetries: 3, baseDelayMs: 1000 });

    const currentToken = await this.tokenStore.refreshIfExpired(this.userId, 'google');
    return this.processListResponse(listResponse, currentToken.accessToken);
  }

  onSignal(handler: SignalHandler): void {
    this.handlers.push(handler);
  }

  private async processListResponse(
    response: Response,
    accessToken: string,
  ): Promise<RawSignal[]> {
    const data = await response.json() as {
      messages?: Array<{ id: string; threadId: string }>;
      resultSizeEstimate?: number;
    };

    if (!data.messages || data.messages.length === 0) {
      return [];
    }

    const signals: RawSignal[] = [];

    for (const msg of data.messages) {
      const detail = await this.fetchMessageDetail(msg.id, accessToken);
      if (!detail) continue;

      const signal = this.messageToSignal(detail);
      signals.push(signal);

      for (const handler of this.handlers) {
        handler(signal);
      }
    }

    return signals;
  }

  private async fetchMessageDetail(
    messageId: string,
    accessToken: string,
  ): Promise<GmailMessage | null> {
    const url = `${GMAIL_API}/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;

    try {
      const response = await withRetry(async () => {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok && [429, 500, 502, 503].includes(resp.status)) {
          const retryAfterMs = parseRetryAfter(resp.headers.get('Retry-After'));
          throw new RetryableHttpError(resp.status, `Gmail detail failed: ${resp.status}`, retryAfterMs);
        }
        return resp;
      }, { maxRetries: 2, baseDelayMs: 500 });

      if (!response.ok) return null;
      return response.json() as Promise<GmailMessage>;
    } catch {
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
    const type = this.inferEmailType(from, subject, message.labelIds);

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
        receivedAt: new Date(parseInt(message.internalDate, 10)).toISOString(),
        requiresResponse: type === 'work_email' || type === 'meeting_invite',
      },
      timestamp: new Date(parseInt(message.internalDate, 10)),
    };
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
