import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerGenerationAdmission,
  WorkerGenerationRevokedError,
} from "../generation-admission.js";
import { installGenerationFetch } from "../generation-fetch.js";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
  vi.restoreAllMocks();
});

describe("generation-bound fetch admission", () => {
  it("rejects without starting a request after generation revocation", async () => {
    const admission = createWorkerGenerationAdmission();
    const transport = vi.fn<typeof fetch>();
    installGenerationFetch(admission, transport);
    admission.revoke();

    await expect(fetch("https://example.test")).rejects.toBeInstanceOf(
      WorkerGenerationRevokedError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request when the generation is revoked", async () => {
    const admission = createWorkerGenerationAdmission();
    let observedSignal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(observedSignal?.reason),
          {
            once: true,
          },
        );
      });
    });
    installGenerationFetch(admission, transport);

    const pending = fetch("https://example.test");
    admission.revoke("replacement started");

    await expect(pending).rejects.toBeInstanceOf(WorkerGenerationRevokedError);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("combines a caller cancellation signal with generation revocation", async () => {
    const admission = createWorkerGenerationAdmission();
    let observedSignal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(observedSignal?.reason),
          {
            once: true,
          },
        );
      });
    });
    installGenerationFetch(admission, transport);
    const caller = new AbortController();

    const pending = fetch("https://example.test", { signal: caller.signal });
    caller.abort(new Error("caller stopped"));

    await expect(pending).rejects.toThrow("caller stopped");
    expect(admission.isActive()).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
  });
});
