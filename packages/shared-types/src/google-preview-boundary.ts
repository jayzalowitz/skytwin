/**
 * Account-backed integrations are outside the supported preview.
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

const MICROSOFT_INTEGRATION_TOKENS = new Set([
  'microsoft',
  'microsoft365',
  'm365',
  'ms365',
  'microsoftgraph',
  'msgraph',
  'office365',
  'o365',
  'outlook',
  'outlook365',
  'outlookcalendar',
  'outlookmail',
  'azure',
  'azuread',
  'entra',
  'entraid',
]);

const MICROSOFT_ACCOUNT_REGISTRY_IDS = new Set([
  'azure-mcp',
  'microsoft-365-mcp',
  'm365-mcp',
  'ms365-mcp',
  'microsoft-graph-mcp',
  'office365-mcp',
  'o365-mcp',
  'outlook-mcp',
  'outlook365-mcp',
  'azure-ad-mcp',
  'azuread-mcp',
  'entra-id-mcp',
  'entraid-mcp',
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
  'schedule_focus_block',
  'find_meeting_time',
  'get_message',
  'fetch_email',
  'modify_message',
  'trash_message',
  'create_draft',
  'send_draft',
  'send_calendar_invite',
]);

function normalizeIntegrationToken(value: string): string {
  return value.trim().toLowerCase().replace(/[._\-/\s]+/g, '');
}

function normalizeActionType(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[.\-:/\s]+/g, '_');
}

export function isGoogleIntegrationIdentifier(value: string): boolean {
  return value
    .split(':')
    .some((segment) => GOOGLE_INTEGRATION_TOKENS.has(normalizeIntegrationToken(segment)));
}

export function isMicrosoftIntegrationIdentifier(value: string): boolean {
  return value
    .split(':')
    .some((segment) => MICROSOFT_INTEGRATION_TOKENS.has(normalizeIntegrationToken(segment)));
}

export function isAccountBackedIntegrationIdentifier(value: string): boolean {
  return isGoogleIntegrationIdentifier(value) || isMicrosoftIntegrationIdentifier(value);
}

export function isGoogleAccountActionType(actionType: string): boolean {
  const normalized = normalizeActionType(actionType);
  if (GOOGLE_ACCOUNT_ACTION_TYPES.has(normalized)) return true;

  // Provider APIs commonly expose resource-qualified method names rather
  // than SkyTwin's verb-first action vocabulary. Deny the stable Gmail /
  // Microsoft Graph mailbox roots and explicit Google Drive namespace before
  // an adapter can treat them as generic remote actions.
  if (/^(?:users?|me)_(?:messages?|threads?|drafts?|labels?|history|settings|profile|watch|stop)(?:_|$)/.test(normalized)) {
    return true;
  }
  if (/^google_drive_(?:files?|folders?|permissions?|drives?|changes?|comments?|replies?|revisions?)(?:_|$)/.test(normalized)) {
    return true;
  }

  // MCP and legacy adapters are allowed to advertise action names that are
  // not in the built-in catalogs. Cover stable email/calendar write and read
  // vocabularies without relying on peer-authored labels or descriptions.
  if (/^(?:read|search|list|archive|label|send|reply|draft|delete|forward|snooze|unsubscribe|move)_(?:email|emails|mail|gmail|google_email|google_mail|message|messages)$/.test(normalized)) {
    return true;
  }
  if (/^(?:create|update|modify|delete|cancel|move|schedule|reschedule|respond_to)_(?:(?:google_)?calendar_)?(?:event|events|invite|meeting|meetings)$/.test(normalized)) {
    return true;
  }
  if (/^(?:read|get|search|list)_(?:(?:google_)?calendar_)?(?:event|events|invite|invites|meeting|meetings)$/.test(normalized)) {
    return true;
  }
  if (/^(?:email|emails|mail|gmail|google_email|google_mail|message|messages)_(?:read|search|list|archive|label|send|reply|draft|delete|trash|forward|snooze|unsubscribe|move|modify)$/.test(normalized)) {
    return true;
  }
  if (/^(?:event|events|invite|invites|meeting|meetings)_(?:read|get|search|list|insert|create|update|patch|delete|remove|move|cancel|respond)$/.test(normalized)) {
    return true;
  }
  return /^(?:rsvp|calendar|email|mail|gmail|gcal|google_calendar|google_mail)_/.test(normalized);
}

/** Provider-neutral name for the account-backed action vocabulary. */
export function isAccountBackedActionType(actionType: string): boolean {
  if (isGoogleAccountActionType(actionType)) return true;
  const normalized = normalizeActionType(actionType);
  return /(?:^|_)(?:microsoft|microsoft_graph|ms_graph|m365|ms365|office_?365|o365|outlook|outlook365|azure|azure_?ad|entra|entra_?id)(?:_|$)/
    .test(normalized);
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
  if (isAccountBackedActionType(input.actionType)) return true;
  const domain = normalizeIntegrationToken(input.domain ?? '');
  if (domain === 'email' || domain === 'mail' || domain === 'calendar' ||
      isAccountBackedIntegrationIdentifier(input.domain ?? '')) {
    return true;
  }
  const mcpToolName = input.parameters?.['mcpToolName'];
  return typeof mcpToolName === 'string' && isAccountBackedActionType(mcpToolName);
}

function isGoogleAccountRegistryIdentifierOnly(registryId: string): boolean {
  return GOOGLE_ACCOUNT_REGISTRY_IDS.has(registryId.trim().toLowerCase());
}

export function isMicrosoftAccountRegistryIdentifier(registryId: string): boolean {
  return MICROSOFT_ACCOUNT_REGISTRY_IDS.has(registryId.trim().toLowerCase());
}

export function isAccountBackedRegistryIdentifier(registryId: string): boolean {
  return isGoogleAccountRegistryIdentifierOnly(registryId) ||
    isMicrosoftAccountRegistryIdentifier(registryId);
}

/** @deprecated Use the provider-neutral account-backed classifier. */
export function isGoogleAccountRegistryIdentifier(registryId: string): boolean {
  return isAccountBackedRegistryIdentifier(registryId);
}

export interface IntegrationBoundaryInput {
  key?: string;
  adapter?: string;
  integration?: string;
  skills?: readonly string[];
}

export function isGoogleAccountIntegration(input: IntegrationBoundaryInput): boolean {
  return isAccountBackedIntegration(input);
}

export function isAccountBackedIntegration(input: IntegrationBoundaryInput): boolean {
  return [input.key, input.adapter, input.integration]
    .some((value) => typeof value === 'string' && (
      isAccountBackedIntegrationIdentifier(value) || isAccountBackedRegistryIdentifier(value)
    )) ||
    (input.skills?.some(isAccountBackedActionType) ?? false);
}
