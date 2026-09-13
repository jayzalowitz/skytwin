import type { RawSignal } from "@skytwin/connectors";
import { RetryableHttpError, withRetry } from "@skytwin/core";
import type { WorkerGenerationAdmission } from "./generation-admission.js";

export interface SignalForwarderOptions {
  readonly apiBaseUrl: string;
  readonly admission: WorkerGenerationAdmission;
  readonly headers: () => Record<string, string>;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
}

/**
 * Forward one signal under the current worker-generation capability.
 *
 * Admission is checked before every attempt and after every await. Revoking the
 * generation aborts an active request; an AbortError caused by that revocation
 * is converted to a non-retryable typed error before `withRetry` can classify
 * it as a transient network failure. A 401/403 means this generation's
 * credential is no longer accepted and closes admission for all later work.
 */
export async function forwardSignalToApi(
  signal: RawSignal,
  userId: string,
  options: SignalForwarderOptions,
): Promise<void> {
  const { admission } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.apiBaseUrl}/api/events/ingest`;
  const body = JSON.stringify({
    ...signal.data,
    source: signal.source,
    type: signal.type,
    signalId: signal.id,
    userId,
  });

  admission.requireActive();
  await withRetry(
    async () => {
      admission.requireActive();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: options.headers(),
          body,
          signal: admission.signal,
        });
      } catch (error) {
        // Revocation must not enter `withRetry`'s AbortError/network retry path.
        admission.requireActive();
        throw error;
      }
      admission.requireActive();

      if (response.status === 401 || response.status === 403) {
        admission.revoke(
          `API rejected worker generation credential (${response.status})`,
        );
        admission.requireActive();
      }
      if (!response.ok) {
        if ([429, 500, 502, 503].includes(response.status)) {
          throw new RetryableHttpError(
            response.status,
            `API ingest failed: ${response.status}`,
            null,
          );
        }
        throw new Error(`API ingest failed: ${response.status}`);
      }
    },
    {
      maxRetries: options.maxRetries ?? 2,
      baseDelayMs: options.baseDelayMs ?? 500,
    },
  );
  admission.requireActive();
}
