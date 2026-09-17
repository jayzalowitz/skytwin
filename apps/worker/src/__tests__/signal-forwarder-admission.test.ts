import {
  GmailConnector,
  type CursorStore,
  type OAuthTokenStore,
  type RawSignal,
} from "@skytwin/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerGenerationAdmission,
  WorkerGenerationRevokedError,
} from "../generation-admission.js";
import { forwardSignalToApi } from "../signal-forwarder.js";
import { createWorkerLifecycle } from "../worker-lifecycle.js";

const signal: RawSignal = {
  id: "signal-1",
  source: "test",
  type: "test.received",
  data: { subject: "hello" },
  timestamp: new Date("2026-09-12T00:00:00.000Z"),
};

function options(
  admission: ReturnType<typeof createWorkerGenerationAdmission>,
  fetchImpl: typeof fetch,
) {
  return {
    apiBaseUrl: "http://127.0.0.1:3100",
    admission,
    headers: () => ({
      "Content-Type": "application/json",
      "X-SkyTwin-Service-Token": "generation-token",
    }),
    fetchImpl,
    baseDelayMs: 1,
  };
}

describe("worker generation request admission", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["SIGTERM", "SIGINT"])(
    "%s aborts an in-flight ingest before it can write",
    async (name) => {
      const admission = createWorkerGenerationAdmission();
      const lifecycle = createWorkerLifecycle(admission);
      let writes = 0;
      const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
        return new Promise<Response>((resolve, reject) => {
          const requestSignal = init?.signal;
          expect(requestSignal).toBe(admission.signal);
          requestSignal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              ),
            { once: true },
          );
          setImmediate(() => {
            if (!requestSignal?.aborted) {
              writes++;
              resolve(new Response(null, { status: 204 }));
            }
          });
        });
      });

      const forwarding = forwardSignalToApi(
        signal,
        "user-1",
        options(admission, fetchImpl),
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
      const rejected = expect(forwarding).rejects.toBeInstanceOf(
        WorkerGenerationRevokedError,
      );
      lifecycle.beginShutdown(`Worker received ${name}`);

      await rejected;
      await new Promise((resolve) => setImmediate(resolve));
      expect(lifecycle.isRunning()).toBe(false);
      expect(writes).toBe(0);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("revocation during retry backoff prevents the next send", async () => {
    vi.useFakeTimers();
    const admission = createWorkerGenerationAdmission();
    const lifecycle = createWorkerLifecycle(admission);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));

    const forwarding = forwardSignalToApi(
      signal,
      "user-1",
      options(admission, fetchImpl),
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    const rejected = expect(forwarding).rejects.toBeInstanceOf(
      WorkerGenerationRevokedError,
    );
    lifecycle.beginShutdown("Worker received SIGTERM");
    await vi.runAllTimersAsync();

    await rejected;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not send when the generation was already revoked", async () => {
    const admission = createWorkerGenerationAdmission();
    admission.revoke("generation replaced");
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      forwardSignalToApi(signal, "user-1", options(admission, fetchImpl)),
    ).rejects.toBeInstanceOf(WorkerGenerationRevokedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "status %s revokes the generation and prevents later sends",
    async (status) => {
      const admission = createWorkerGenerationAdmission();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status }));

      await expect(
        forwardSignalToApi(signal, "user-1", options(admission, fetchImpl)),
      ).rejects.toBeInstanceOf(WorkerGenerationRevokedError);
      await expect(
        forwardSignalToApi(signal, "user-1", options(admission, fetchImpl)),
      ).rejects.toBeInstanceOf(WorkerGenerationRevokedError);
      expect(admission.isActive()).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 403])(
    "replays Gmail mail and its cursor in a new generation after ingest status %s",
    async (status) => {
      const cursors = new Map<string, string>([
        ["user-1:gmail:history_id", "1000"],
      ]);
      const cursorStore: CursorStore = {
        get: async (userId, connector, kind) =>
          cursors.get(`${userId}:${connector}:${kind}`) ?? null,
        save: async (userId, connector, kind, value) => {
          cursors.set(`${userId}:${connector}:${kind}`, value);
        },
      };
      const tokenStore = {
        refreshIfExpired: async () => ({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      } as unknown as OAuthTokenStore;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = String(input);
          if (url.includes("/users/me/history")) {
            return new Response(
              JSON.stringify({
                history: [
                  { messagesAdded: [{ message: { id: "replay-me" } }] },
                ],
                historyId: "2050",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              id: "replay-me",
              threadId: "thread-replay",
              labelIds: ["INBOX"],
              snippet: "replay",
              payload: { headers: [] },
              internalDate: "1735689600000",
              historyId: "2040",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }),
      );

      const firstAdmission = createWorkerGenerationAdmission();
      const first = new GmailConnector("user-1", tokenStore, cursorStore);
      await first.connect(firstAdmission.signal);
      const firstBatch = await first.poll(firstAdmission.signal);
      const rejectedIngest = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status }));
      await expect(
        forwardSignalToApi(
          firstBatch[0]!,
          "user-1",
          options(firstAdmission, rejectedIngest),
        ),
      ).rejects.toBeInstanceOf(WorkerGenerationRevokedError);
      expect(cursors.get("user-1:gmail:history_id")).toBe("1000");
      await first.disconnect();

      const nextAdmission = createWorkerGenerationAdmission();
      const next = new GmailConnector("user-1", tokenStore, cursorStore);
      await next.connect(nextAdmission.signal);
      const replay = await next.poll(nextAdmission.signal);
      const acceptedIngest = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      await forwardSignalToApi(
        replay[0]!,
        "user-1",
        options(nextAdmission, acceptedIngest),
      );
      await next.commitCursor();

      expect(firstBatch.map((item) => item.id)).toEqual([
        "sig_gmail_replay-me",
      ]);
      expect(replay.map((item) => item.id)).toEqual(["sig_gmail_replay-me"]);
      expect(rejectedIngest).toHaveBeenCalledOnce();
      expect(acceptedIngest).toHaveBeenCalledOnce();
      expect(cursors.get("user-1:gmail:history_id")).toBe("2050");
    },
  );
});
