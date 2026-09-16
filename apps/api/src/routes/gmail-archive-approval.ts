import {
  classifyGmailArchiveGenericAction,
  type GmailArchiveGenericActionClassification,
} from '@skytwin/shared-types';

/**
 * Classify persisted approval actions before the generic responder runs.
 *
 * Every archive_email representation is reserved for the dedicated lifecycle,
 * including legacy and malformed parameter shapes. Invalid objects are kept
 * distinct so the route can fail closed instead of treating inspection failure
 * as an unrelated generic action.
 */
export function classifyGmailArchiveApproval(
  value: unknown,
): Readonly<GmailArchiveGenericActionClassification> {
  return classifyGmailArchiveGenericAction(value);
}
