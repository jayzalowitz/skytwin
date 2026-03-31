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
    console.info(
      `[generic-handler] Action logged but not executed: ${step.type} — ${step.description}`,
    );

    return {
      success: true,
      output: {
        note: 'Action logged but not executed — no specific handler registered',
        actionType: step.type,
        description: step.description,
        parameters: step.parameters,
      },
    };
  }

  async rollback(_step: ExecutionStep): Promise<StepResult> {
    // Nothing to undo for a logged-only action
    return { success: true, output: { note: 'Nothing to rollback — action was only logged' } };
  }
}
