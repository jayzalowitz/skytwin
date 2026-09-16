import {
  classifyGmailArchiveGenericAction,
  type CandidateAction,
} from '@skytwin/shared-types';

/**
 * Prevent legacy direct-adapter workflows from bypassing the generic router
 * guard. The second classification is against a detached top-level snapshot,
 * closing the gap where a stateful object changes while it is copied.
 */
export function snapshotGenericWorkflowAction(
  action: unknown,
): CandidateAction {
  const classification = classifyGmailArchiveGenericAction(action);
  if (classification.kind !== 'other') {
    throw new Error(
      classification.kind === 'archive'
        ? 'archive_email is reserved for its dedicated execution lifecycle'
        : 'generic workflow selected an invalid action',
    );
  }
  const candidate = action as CandidateAction;
  const snapshot = Object.freeze({
    ...candidate,
    parameters: Object.freeze({ ...candidate.parameters }),
  });
  const snapshotClassification = classifyGmailArchiveGenericAction(snapshot);
  if (snapshotClassification.kind !== 'other') {
    throw new Error(
      snapshotClassification.kind === 'archive'
        ? 'archive_email is reserved for its dedicated execution lifecycle'
        : 'generic workflow selected an invalid action',
    );
  }
  return snapshot;
}
