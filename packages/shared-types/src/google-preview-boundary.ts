/**
 * Account-backed Google integrations are outside the supported preview.
 *
 * Identifiers are deliberately matched by stable adapter/integration tokens,
 * never by peer-authored labels or descriptions. Separators are ignored so a
 * dynamic adapter cannot expose the same integration as `google_calendar`,
 * `google-calendar`, or `google.calendar` and bypass the boundary.
 */
const GOOGLE_INTEGRATION_TOKENS = new Set([
  'google',
  'gmail',
  'googlemail',
  'googlecalendar',
  'gcal',
]);

const GOOGLE_ACCOUNT_REGISTRY_IDS = new Set([
  '@modelcontextprotocol/server-google-drive',
  'gmail-mcp',
  'google-calendar-mcp',
  'youtube-mcp',
  'gcp-mcp',
]);

export const GOOGLE_ACCOUNT_ACTION_TYPES = new Set([
  'archive_email',
  'label_email',
  'send_reply',
  'reply_email',
  'draft_email',
  'send_email',
  'delete_email',
  'forward_email',
  'snooze_email',
  'unsubscribe_email',
  'create_filter',
  'move_to_folder',
  'accept_invite',
  'decline_invite',
  'decline_event',
  'propose_alternative',
  'tentative_accept',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'reschedule_event',
  'set_out_of_office',
  'block_focus_time',
  'find_meeting_time',
]);

function normalizeIntegrationToken(value: string): string {
  return value.trim().toLowerCase().replace(/[._-]/g, '');
}

export function isGoogleIntegrationIdentifier(value: string): boolean {
  return value
    .split(':')
    .some((segment) => GOOGLE_INTEGRATION_TOKENS.has(normalizeIntegrationToken(segment)));
}

export function isGoogleAccountActionType(actionType: string): boolean {
  return GOOGLE_ACCOUNT_ACTION_TYPES.has(actionType.trim().toLowerCase());
}

export function isGoogleAccountRegistryIdentifier(registryId: string): boolean {
  return GOOGLE_ACCOUNT_REGISTRY_IDS.has(registryId.trim().toLowerCase());
}

export interface IntegrationBoundaryInput {
  key?: string;
  adapter?: string;
  integration?: string;
  skills?: readonly string[];
}

export function isGoogleAccountIntegration(input: IntegrationBoundaryInput): boolean {
  return [input.key, input.adapter, input.integration]
    .some((value) => typeof value === 'string' && isGoogleIntegrationIdentifier(value)) ||
    (typeof input.key === 'string' && isGoogleAccountRegistryIdentifier(input.key)) ||
    (input.skills?.some(isGoogleAccountActionType) ?? false);
}
