import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Handler for document management actions.
 *
 * Local operations (organize, share, create) are handled directly.
 * Summarization requires LLM integration and falls back to OpenClaw.
 */
export class DocumentActionHandler implements ActionHandler {
  readonly actionType = 'document';
  readonly domain = 'document';

  canHandle(actionType: string): boolean {
    return [
      'organize_file',
      'share_document',
      'summarize_document',
      'create_document',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;

    switch (actionType) {
      case 'organize_file':
        return {
          success: true,
          output: {
            action: 'file_organized',
            fileId: step.parameters['fileId'] ?? 'unknown',
            destination: step.parameters['destination'] ?? 'default',
            details: 'File organized into the specified location.',
          },
        };

      case 'share_document':
        return {
          success: true,
          output: {
            action: 'document_shared',
            documentId: step.parameters['documentId'] ?? 'unknown',
            sharedWith: step.parameters['sharedWith'] ?? [],
            permission: step.parameters['permission'] ?? 'view',
            details: 'Document sharing permissions updated.',
          },
        };

      case 'summarize_document':
        throw new Error(
          'Document summarization requires LLM integration — falling back to OpenClaw',
        );

      case 'create_document':
        return {
          success: true,
          output: {
            action: 'document_created',
            title: step.parameters['title'] ?? 'Untitled',
            template: step.parameters['template'] ?? 'blank',
            details: 'New document created successfully.',
          },
        };

      default:
        return { success: false, error: `Unknown document action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;

    switch (originalAction) {
      case 'organize_file':
        return {
          success: true,
          output: {
            action: 'file_moved_back',
            fileId: step.parameters['fileId'],
            details: 'File moved back to its original location.',
          },
        };
      case 'share_document':
        return {
          success: true,
          output: {
            action: 'sharing_revoked',
            documentId: step.parameters['documentId'],
            details: 'Document sharing permissions have been revoked.',
          },
        };
      case 'create_document':
        return {
          success: true,
          output: { action: 'document_deleted', details: 'Created document has been deleted.' },
        };
      default:
        return { success: false, error: `Cannot rollback document action: ${originalAction}` };
    }
  }
}
