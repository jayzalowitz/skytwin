import type { WorkerGenerationAdmission } from "./generation-admission.js";

/**
 * Bind every worker HTTP request, including requests issued by background-job
 * dependencies, to the current generation. This is intentionally installed at
 * process startup instead of relying on each job to remember a signal.
 */
export function installGenerationFetch(
  admission: WorkerGenerationAdmission,
  originalFetch: typeof fetch = globalThis.fetch,
): void {
  globalThis.fetch = async (input, init) => {
    admission.requireActive();
    const signal = init?.signal
      ? AbortSignal.any([admission.signal, init.signal])
      : admission.signal;
    try {
      const response = await originalFetch(input, { ...init, signal });
      admission.requireActive();
      return response;
    } catch (error) {
      admission.requireActive();
      throw error;
    }
  };
}
