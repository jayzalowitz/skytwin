import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmailConnector, type CursorStore } from '../gmail-connector.js';
import { GoogleCalendarConnector } from '../google-calendar-connector.js';
import { OutlookMailConnector } from '../outlook-mail-connector.js';
import { OutlookCalendarConnector } from '../outlook-calendar-connector.js';
import type { OAuthTokenStore } from '../oauth/token-store.js';

const SECRET_MARKER = 'provider-secret-marker-7f3c';
const tokenStore = {} as OAuthTokenStore;
const failingCursorStore: CursorStore = {
  get: async () => null,
  save: async () => {
    throw Object.assign(new Error(SECRET_MARKER), {
      stack: `stack:${SECRET_MARKER}`,
      body: SECRET_MARKER,
    });
  },
};

afterEach(() => vi.restoreAllMocks());

describe('scheduled connector failure logs', () => {
  it('keep Gmail, Google Calendar, and Outlook cursor failures content-free', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gmail = new GmailConnector('user-1', tokenStore, failingCursorStore);
    const googleCalendar = new GoogleCalendarConnector(
      'user-1', tokenStore, failingCursorStore,
    );
    const outlookMail = new OutlookMailConnector('user-1', tokenStore, failingCursorStore);
    const outlookCalendar = new OutlookCalendarConnector('user-1', tokenStore, failingCursorStore);

    await (gmail as unknown as { persistCursor(value: string): Promise<void> })
      .persistCursor('cursor');
    await (googleCalendar as unknown as { persistSyncToken(value: string): Promise<void> })
      .persistSyncToken('cursor');
    await (outlookMail as unknown as { persistCursor(value: string): Promise<void> })
      .persistCursor('cursor');
    await (outlookCalendar as unknown as { persistCursor(value: string): Promise<void> })
      .persistCursor('cursor');

    expect(warn).toHaveBeenCalledTimes(4);
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain('stack:');
    expect(warn.mock.calls.every((call) =>
      JSON.stringify(call).includes('"errorCode":"operation_failed"'))).toBe(true);
  });
});
