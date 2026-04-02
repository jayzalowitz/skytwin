import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Handler for task management actions.
 *
 * Most task operations are handled locally (create, complete, set reminder,
 * update priority). Assigning tasks to other users requires external service
 * integration and falls back to OpenClaw.
 */
export class TaskActionHandler implements ActionHandler {
  readonly actionType = 'task';
  readonly domain = 'task';

  canHandle(actionType: string): boolean {
    return [
      'create_task',
      'complete_task',
      'assign_task',
      'set_reminder',
      'update_task_priority',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;

    switch (actionType) {
      case 'create_task':
        return {
          success: true,
          output: {
            action: 'task_created',
            title: step.parameters['title'] ?? 'Untitled task',
            priority: step.parameters['priority'] ?? 'medium',
            details: 'Task created successfully.',
          },
        };

      case 'complete_task':
        return {
          success: true,
          output: {
            action: 'task_completed',
            taskId: step.parameters['taskId'] ?? 'unknown',
            details: 'Task marked as completed.',
          },
        };

      case 'assign_task':
        throw new Error(
          'Task assignment requires external service integration — falling back to OpenClaw',
        );

      case 'set_reminder':
        return {
          success: true,
          output: {
            action: 'reminder_set',
            taskId: step.parameters['taskId'] ?? 'unknown',
            remindAt: step.parameters['remindAt'] ?? 'unspecified',
            details: 'Reminder set successfully.',
          },
        };

      case 'update_task_priority':
        return {
          success: true,
          output: {
            action: 'priority_updated',
            taskId: step.parameters['taskId'] ?? 'unknown',
            priority: step.parameters['priority'] ?? 'medium',
            details: 'Task priority updated.',
          },
        };

      default:
        return { success: false, error: `Unknown task action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;

    switch (originalAction) {
      case 'create_task':
        return {
          success: true,
          output: { action: 'task_deleted', details: 'Created task has been removed.' },
        };
      case 'complete_task':
        return {
          success: true,
          output: {
            action: 'task_reopened',
            taskId: step.parameters['taskId'],
            details: 'Task marked as incomplete.',
          },
        };
      case 'set_reminder':
        return {
          success: true,
          output: { action: 'reminder_cleared', details: 'Reminder has been cleared.' },
        };
      case 'update_task_priority':
        return {
          success: true,
          output: {
            action: 'priority_reverted',
            taskId: step.parameters['taskId'],
            previousPriority: step.parameters['previousPriority'] ?? 'unknown',
          },
        };
      default:
        return { success: false, error: `Cannot rollback task action: ${originalAction}` };
    }
  }
}
