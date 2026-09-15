const GOOGLE_INTEGRATION_TOKENS = new Set([
  'google', 'gmail', 'googlemail', 'googlecalendar', 'googledrive', 'gdrive', 'gcal',
  'youtube', 'gcp',
]);

const MICROSOFT_INTEGRATION_TOKENS = new Set([
  'microsoft', 'microsoft365', 'm365', 'ms365', 'microsoftgraph', 'msgraph',
  'office365', 'o365', 'outlook', 'outlook365', 'outlookcalendar',
  'outlookmail', 'azure', 'azuread', 'entra', 'entraid', 'onedrive',
  'sharepoint', 'exchange', 'microsoftteams', 'msteams', 'teams',
]);

const GOOGLE_ACCOUNT_ACTION_TYPES = new Set([
  'archive_email', 'label_email', 'send_reply', 'reply_email', 'draft_email',
  'send_email', 'delete_email', 'delete_emails', 'forward_email', 'read_email',
  'read_emails', 'search_email', 'search_emails', 'snooze_email',
  'unsubscribe_email', 'create_filter', 'move_to_folder', 'accept_invite',
  'decline_invite', 'decline_event', 'propose_alternative', 'tentative_accept',
  'respond_to_event', 'create_event', 'update_event', 'delete_event', 'schedule_meeting',
  'create_calendar_event', 'update_calendar_event', 'delete_calendar_event',
  'reschedule_event', 'set_out_of_office', 'block_focus_time', 'find_meeting_time',
  'schedule_focus_block',
  'get_message', 'fetch_email', 'modify_message', 'trash_message',
  'create_draft', 'send_draft', 'send_calendar_invite',
]);

const GOOGLE_ACCOUNT_REGISTRY_IDS = new Set([
  '@modelcontextprotocol/server-google-drive',
  'google-drive-mcp',
  'gmail-mcp',
  'google-calendar-mcp',
  'youtube-mcp',
  'gcp-mcp',
]);

const MICROSOFT_ACCOUNT_REGISTRY_IDS = new Set([
  'azure-mcp', 'microsoft-365-mcp', 'm365-mcp', 'ms365-mcp',
  'microsoft-graph-mcp', 'office365-mcp', 'o365-mcp', 'outlook-mcp',
  'outlook365-mcp', 'azure-ad-mcp', 'azuread-mcp', 'entra-id-mcp',
  'entraid-mcp', 'onedrive-mcp', 'sharepoint-mcp', 'exchange-mcp',
  'microsoft-teams-mcp', 'ms-teams-mcp', 'teams-mcp',
]);

function normalizeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[._\-/\s]+/g, '');
}

function actionContainsIntegrationToken(normalizedAction, tokens) {
  const segments = normalizedAction.split('_').filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    for (let length = 1; length <= 3 && start + length <= segments.length; length += 1) {
      if (tokens.has(segments.slice(start, start + length).join(''))) return true;
    }
  }
  return false;
}

function normalizeActionType(value) {
  return String(value ?? '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[._\-:/\s]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isGoogleAccountActionType(value) {
  const normalized = normalizeActionType(value);
  if (GOOGLE_ACCOUNT_ACTION_TYPES.has(normalized)) return true;
  if (/(?:^|_)(?:users?|me|groups?)(?:_|$)/.test(normalized)) return true;
  if (actionContainsIntegrationToken(normalized, GOOGLE_INTEGRATION_TOKENS)) return true;
  if (/^(?:read|search|list|archive|label|send|reply|draft|delete|forward|snooze|unsubscribe|move)_(?:email|emails|mail|gmail|google_email|google_mail|message|messages)$/.test(normalized)) return true;
  if (/^(?:create|update|modify|delete|cancel|move|schedule|reschedule|respond_to)_(?:(?:google_)?calendar_)?(?:event|events|invite|meeting|meetings)$/.test(normalized)) return true;
  if (/^(?:read|get|search|list)_(?:(?:google_)?calendar_)?(?:event|events|invite|invites|meeting|meetings)$/.test(normalized)) return true;
  if (/^(?:email|emails|mail|gmail|google_email|google_mail|message|messages)_(?:read|search|list|archive|label|send|reply|draft|delete|trash|forward|snooze|unsubscribe|move|modify)$/.test(normalized)) return true;
  if (/^(?:event|events|invite|invites|meeting|meetings)_(?:read|get|search|list|insert|create|update|patch|delete|remove|move|cancel|respond)$/.test(normalized)) return true;
  return /^(?:rsvp|calendar|email|mail|gmail|gcal|google_calendar|google_mail)_/.test(normalized);
}

function isAccountBackedActionType(value) {
  if (isGoogleAccountActionType(value)) return true;
  const normalized = normalizeActionType(value);
  return actionContainsIntegrationToken(normalized, MICROSOFT_INTEGRATION_TOKENS);
}

export function isGoogleIntegrationIdentifier(value) {
  return String(value ?? '').split(':')
    .some(segment => GOOGLE_INTEGRATION_TOKENS.has(normalizeToken(segment)));
}

export function isMicrosoftIntegrationIdentifier(value) {
  return String(value ?? '').split(':')
    .some(segment => MICROSOFT_INTEGRATION_TOKENS.has(normalizeToken(segment)));
}

export function isAccountBackedIntegrationIdentifier(value) {
  return isGoogleIntegrationIdentifier(value) || isMicrosoftIntegrationIdentifier(value);
}

export function isAccountBackedIntegration(input = {}) {
  const identifiers = [input.key, input.adapter, input.integration];
  return identifiers.some(value =>
    isAccountBackedIntegrationIdentifier(value) ||
    GOOGLE_ACCOUNT_REGISTRY_IDS.has(String(value ?? '').trim().toLowerCase()) ||
    MICROSOFT_ACCOUNT_REGISTRY_IDS.has(String(value ?? '').trim().toLowerCase())) ||
    (input.skills ?? []).some(isAccountBackedActionType);
}

export function isGoogleAccountIntegration(input = {}) {
  return isAccountBackedIntegration(input);
}
