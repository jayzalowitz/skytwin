export class WorkerGenerationRevokedError extends Error {
  constructor(reason = "Worker generation is no longer authorized") {
    super(reason);
    this.name = "WorkerGenerationRevokedError";
  }
}

export interface WorkerGenerationAdmission {
  readonly signal: AbortSignal;
  isActive(): boolean;
  requireActive(): void;
  revoke(reason?: string): void;
}

/**
 * Process-local capability for one desktop-managed worker generation.
 *
 * Revocation is synchronous inside the worker: request admission closes before
 * shutdown cleanup starts, and the shared signal cancels fetches already in
 * flight. The desktop still waits for child exit/close proof; sending a signal
 * alone is never treated as proof that revocation ran in the child.
 */
export function createWorkerGenerationAdmission(): WorkerGenerationAdmission {
  const controller = new AbortController();

  return {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    requireActive: () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof WorkerGenerationRevokedError
          ? reason
          : new WorkerGenerationRevokedError();
      }
    },
    revoke: (reason = "Worker generation was revoked") => {
      if (!controller.signal.aborted) {
        controller.abort(new WorkerGenerationRevokedError(reason));
      }
    },
  };
}

export function isWorkerGenerationRevoked(error: unknown): boolean {
  return error instanceof WorkerGenerationRevokedError;
}
