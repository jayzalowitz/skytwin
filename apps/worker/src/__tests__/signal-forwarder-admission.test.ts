import type { RawSignal } from "@skytwin/connectors";
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
});
