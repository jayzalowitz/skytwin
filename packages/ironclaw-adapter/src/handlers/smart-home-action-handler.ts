import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Handler for smart home / IoT actions.
 *
 * All smart home operations require real IoT device integration that is not
 * available locally. Every action throws to trigger fallback to OpenClaw
 * which can bridge to home automation platforms.
 */
export class SmartHomeActionHandler implements ActionHandler {
  readonly actionType = 'smart_home';
  readonly domain = 'smart_home';

  canHandle(actionType: string): boolean {
    return [
      'set_thermostat',
      'toggle_lights',
      'lock_door',
      'set_alarm',
      'run_routine',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;

    switch (actionType) {
      case 'set_thermostat':
        throw new Error(
          'Smart home operation requires IoT integration — falling back to OpenClaw',
        );

      case 'toggle_lights':
        throw new Error(
          'Smart home operation requires IoT integration — falling back to OpenClaw',
        );

      case 'lock_door':
        throw new Error(
          'Smart home operation requires IoT integration — falling back to OpenClaw',
        );

      case 'set_alarm':
        throw new Error(
          'Smart home operation requires IoT integration — falling back to OpenClaw',
        );

      case 'run_routine':
        throw new Error(
          'Smart home operation requires IoT integration — falling back to OpenClaw',
        );

      default:
        return { success: false, error: `Unknown smart home action: ${actionType}` };
    }
  }

  async rollback(_step: ExecutionStep): Promise<StepResult> {
    return {
      success: false,
      error: 'Cannot rollback smart home actions — no local IoT integration available.',
    };
  }
}
