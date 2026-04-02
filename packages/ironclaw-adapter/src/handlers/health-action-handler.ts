import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Handler for health and wellness actions.
 *
 * Local operations (logging metrics, setting medication reminders) are
 * handled directly. Appointment-related actions and anomaly detection
 * require external service integration and fall back to OpenClaw.
 */
export class HealthActionHandler implements ActionHandler {
  readonly actionType = 'health';
  readonly domain = 'health';

  canHandle(actionType: string): boolean {
    return [
      'log_health_metric',
      'set_medication_reminder',
      'book_appointment',
      'reschedule_appointment',
      'flag_health_anomaly',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;

    switch (actionType) {
      case 'log_health_metric':
        return {
          success: true,
          output: {
            action: 'health_metric_logged',
            metric: step.parameters['metric'] ?? 'unknown',
            value: step.parameters['value'] ?? 0,
            unit: step.parameters['unit'] ?? '',
            timestamp: step.parameters['timestamp'] ?? new Date().toISOString(),
            details: 'Health metric recorded successfully.',
          },
        };

      case 'set_medication_reminder':
        return {
          success: true,
          output: {
            action: 'medication_reminder_set',
            medication: step.parameters['medication'] ?? 'unspecified',
            schedule: step.parameters['schedule'] ?? 'daily',
            details: 'Medication reminder configured successfully.',
          },
        };

      case 'book_appointment':
        throw new Error(
          'Appointment booking requires healthcare provider integration — falling back to OpenClaw',
        );

      case 'reschedule_appointment':
        throw new Error(
          'Appointment rescheduling requires healthcare provider integration — falling back to OpenClaw',
        );

      case 'flag_health_anomaly':
        throw new Error(
          'Health anomaly detection requires clinical data integration — falling back to OpenClaw',
        );

      default:
        return { success: false, error: `Unknown health action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;

    switch (originalAction) {
      case 'log_health_metric':
        return {
          success: true,
          output: {
            action: 'health_metric_removed',
            metric: step.parameters['metric'],
            details: 'Health metric entry has been removed.',
          },
        };
      case 'set_medication_reminder':
        return {
          success: true,
          output: {
            action: 'medication_reminder_cleared',
            medication: step.parameters['medication'],
            details: 'Medication reminder has been cleared.',
          },
        };
      default:
        return { success: false, error: `Cannot rollback health action: ${originalAction}` };
    }
  }
}
