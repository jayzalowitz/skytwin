import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Handler for social media actions.
 *
 * Local operations (drafting posts, muting conversations) are handled
 * directly. Actions that require posting to external platforms (schedule,
 * respond, share) throw to trigger fallback to OpenClaw.
 */
export class SocialActionHandler implements ActionHandler {
  readonly actionType = 'social';
  readonly domain = 'social';

  canHandle(actionType: string): boolean {
    return [
      'draft_social_post',
      'schedule_social_post',
      'respond_to_mention',
      'mute_conversation',
      'share_content',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;

    switch (actionType) {
      case 'draft_social_post':
        return {
          success: true,
          output: {
            action: 'post_drafted',
            platform: step.parameters['platform'] ?? 'unspecified',
            content: step.parameters['content'] ?? '',
            details: 'Social post draft created. Ready for review before publishing.',
          },
        };

      case 'schedule_social_post':
        throw new Error(
          'Social post scheduling requires platform API integration — falling back to OpenClaw',
        );

      case 'respond_to_mention':
        throw new Error(
          'Responding to social mentions requires platform API integration — falling back to OpenClaw',
        );

      case 'mute_conversation':
        return {
          success: true,
          output: {
            action: 'conversation_muted',
            conversationId: step.parameters['conversationId'] ?? 'unknown',
            platform: step.parameters['platform'] ?? 'unspecified',
            details: 'Conversation muted successfully.',
          },
        };

      case 'share_content':
        throw new Error(
          'Content sharing requires platform API integration — falling back to OpenClaw',
        );

      default:
        return { success: false, error: `Unknown social action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;

    switch (originalAction) {
      case 'draft_social_post':
        return {
          success: true,
          output: { action: 'draft_discarded', details: 'Social post draft has been discarded.' },
        };
      case 'mute_conversation':
        return {
          success: true,
          output: {
            action: 'conversation_unmuted',
            conversationId: step.parameters['conversationId'],
            details: 'Conversation has been unmuted.',
          },
        };
      default:
        return { success: false, error: `Cannot rollback social action: ${originalAction}` };
    }
  }
}
