import type { WorkerGenerationAdmission } from "./generation-admission.js";

export interface WorkerLifecycle {
  isRunning(): boolean;
  beginShutdown(reason: string): void;
}

/** Shared shutdown state used by both process-signal handlers and poll gates. */
export function createWorkerLifecycle(
  admission: WorkerGenerationAdmission,
): WorkerLifecycle {
  let running = true;
  return {
    isRunning: () => running && admission.isActive(),
    beginShutdown: (reason) => {
      running = false;
      admission.revoke(reason);
    },
  };
}
