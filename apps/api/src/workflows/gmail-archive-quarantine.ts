import {
  classifyGmailArchiveGenericAction,
  type CandidateAction,
} from '@skytwin/shared-types';

/** Prevent legacy direct-adapter workflows from bypassing the generic router guard. */
export function assertGenericWorkflowActionAllowed(
  action: unknown,
): asserts action is CandidateAction {
  const classification = classifyGmailArchiveGenericAction(action);
  if (classification.kind !== 'other') {
    throw new Error(
      classification.kind === 'archive'
        ? 'archive_email is reserved for its dedicated execution lifecycle'
        : 'generic workflow selected an invalid action',
    );
  }
}
