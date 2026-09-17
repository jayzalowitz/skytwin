import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalConnector } from "../connector-interface.js";
import { GmailConnector } from "../gmail-connector.js";
import { GoogleCalendarConnector } from "../google-calendar-connector.js";
import type { OAuthTokenStore } from "../oauth/token-store.js";
import { OutlookCalendarConnector } from "../outlook-calendar-connector.js";
import { OutlookMailConnector } from "../outlook-mail-connector.js";

const token = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
};

function tokenStore(): OAuthTokenStore {
  return {
    save: async () => undefined,
    get: async () => token,
    delete: async () => undefined,
    refreshIfExpired: async () => token,
  } as unknown as OAuthTokenStore;
}

function connectorFactories(): Array<[string, () => SignalConnector]> {
  return [
    ["gmail", () => new GmailConnector("user-1", tokenStore())],
    [
      "google calendar",
      () => new GoogleCalendarConnector("user-1", tokenStore()),
    ],
    ["outlook mail", () => new OutlookMailConnector("user-1", tokenStore())],
    [
      "outlook calendar",
      () => new OutlookCalendarConnector("user-1", tokenStore()),
    ],
  ];
}

afterEach(() => vi.unstubAllGlobals());

describe("connector poll cancellation", () => {
  it.each(connectorFactories())(
    "%s aborts its active fetch without retrying",
    async (_name, make) => {
      const fetchMock = vi.fn<typeof fetch>((_input, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const connector = make();
      await connector.connect();
      const controller = new AbortController();
      const poll = connector.poll(controller.signal);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const revoked = new Error("worker generation revoked");
      const rejection = expect(poll).rejects.toBe(revoked);

      controller.abort(revoked);

      await rejection;
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});
