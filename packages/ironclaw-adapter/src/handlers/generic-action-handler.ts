import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Fallback handler for action types without a specific handler.
 * Logs the action but does not execute anything in the real world.
 */
export class GenericActionHandler implements ActionHandler {
  readonly actionType = 'generic';
  readonly domain = 'generic';

  canHandle(_actionType: string): boolean {
    // This is the catch-all — returns true for anything
    return true;
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    console.warn(
      `[generic-handler] No handler for action type "${step.type}" — failing explicitly`,
    );

    return {
      success: false,
      error: `No handler registered for action type "${step.type}". ` +
        `Register a specific handler or configure an external adapter (IronClaw/OpenClaw).`,
      output: {
        actionType: step.type,
        description: step.description,
      },
    };
  }

  async rollback(_step: ExecutionStep): Promise<StepResult> {
    return {
      success: false,
      error: 'Cannot rollback — no handler was registered for this action type.',
    };
  }
}
