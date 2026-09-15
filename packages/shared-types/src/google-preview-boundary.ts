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
  'googledrive',
  'gcal',
  'youtube',
  'gcp',
]);

const GOOGLE_ACCOUNT_REGISTRY_IDS = new Set([
  '@modelcontextprotocol/server-google-drive',
  'gmail-mcp',
  'google-calendar-mcp',
  'youtube-mcp',
  'gcp-mcp',
]);

const GOOGLE_ACCOUNT_ACTION_TYPES = new Set([
  'archive_email',
  'label_email',
  'send_reply',
  'reply_email',
  'draft_email',
  'send_email',
  'delete_email',
  'delete_emails',
  'forward_email',
  'read_email',
  'read_emails',
  'search_email',
  'search_emails',
  'snooze_email',
  'unsubscribe_email',
  'create_filter',
  'move_to_folder',
  'accept_invite',
  'decline_invite',
  'decline_event',
  'propose_alternative',
  'tentative_accept',
  'respond_to_event',
  'create_event',
  'update_event',
  'delete_event',
  'schedule_meeting',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'reschedule_event',
  'set_out_of_office',
  'block_focus_time',
  'find_meeting_time',
]);

function normalizeIntegrationToken(value: string): string {
  return value.trim().toLowerCase().replace(/[._\-/\s]+/g, '');
}

function normalizeActionType(value: string): string {
  return value.trim().toLowerCase().replace(/[.\-:/\s]+/g, '_');
}

export function isGoogleIntegrationIdentifier(value: string): boolean {
  return value
    .split(':')
    .some((segment) => GOOGLE_INTEGRATION_TOKENS.has(normalizeIntegrationToken(segment)));
}

export function isGoogleAccountActionType(actionType: string): boolean {
  const normalized = normalizeActionType(actionType);
  if (GOOGLE_ACCOUNT_ACTION_TYPES.has(normalized)) return true;

  // MCP and legacy adapters are allowed to advertise action names that are
  // not in the built-in catalogs. Cover stable email/calendar write and read
  // vocabularies without relying on peer-authored labels or descriptions.
  if (/^(?:read|search|list|archive|label|send|reply|draft|delete|forward|snooze|unsubscribe|move)_(?:email|emails|mail|message|messages)$/.test(normalized)) {
    return true;
  }
  if (/^(?:create|update|modify|delete|cancel|move|schedule|reschedule|respond_to)_(?:calendar_)?(?:event|events|invite|meeting|meetings)$/.test(normalized)) {
    return true;
  }
  if (/^(?:read|get|search|list)_(?:calendar_)?(?:event|events|invite|invites|meeting|meetings)$/.test(normalized)) {
    return true;
  }
  if (/^(?:email|emails|mail|message|messages)_(?:read|search|list|archive|label|send|reply|draft|delete|trash|forward|snooze|unsubscribe|move|modify)$/.test(normalized)) {
    return true;
  }
  if (/^(?:event|events|invite|invites|meeting|meetings)_(?:read|get|search|list|insert|create|update|patch|delete|remove|move|cancel|respond)$/.test(normalized)) {
    return true;
  }
  return /^(?:rsvp|calendar|email|mail|gmail|gcal|google_calendar|google_mail)_/.test(normalized);
}

export interface AccountActionBoundaryInput {
  actionType: string;
  domain?: string;
  parameters?: Readonly<Record<string, unknown>>;
}

/**
 * Conservatively identify account-backed email/calendar work while provider
 * identity is not cryptographically bound into execution authority. Domain is
 * only an additional deny signal; known action/tool names remain independently
 * denied so a peer cannot bypass the boundary by relabeling the domain.
 */
export function isAccountBackedEmailOrCalendarAction(
  input: AccountActionBoundaryInput,
): boolean {
  if (isGoogleAccountActionType(input.actionType)) return true;
  const domain = normalizeIntegrationToken(input.domain ?? '');
  if (domain === 'email' || domain === 'mail' || domain === 'calendar' ||
      isGoogleIntegrationIdentifier(input.domain ?? '')) {
    return true;
  }
  const mcpToolName = input.parameters?.['mcpToolName'];
  return typeof mcpToolName === 'string' && isGoogleAccountActionType(mcpToolName);
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
