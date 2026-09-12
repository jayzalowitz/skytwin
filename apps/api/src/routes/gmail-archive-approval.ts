import { GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA } from '@skytwin/shared-types';

/**
 * Identify approvals reserved for the bounded Gmail Inbox workflow.
 *
 * The dedicated lifecycle is not executable yet. Matching any of its
 * authority-minimized parameter markers keeps malformed or partially migrated
 * rows out of the generic approval router as well as matching the canonical
 * schema exactly.
 */
export function isReservedGmailArchiveApproval(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (action['actionType'] !== 'archive_email') return false;

  const parameters = action['parameters'];
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return false;
  }
  const params = parameters as Record<string, unknown>;
  return params['schema'] === GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA ||
    Object.prototype.hasOwnProperty.call(params, 'schema') ||
    Object.prototype.hasOwnProperty.call(params, 'messageRefId') ||
    Object.prototype.hasOwnProperty.call(params, 'operation');
}
