const GOOGLE_INTEGRATION_TOKENS = new Set([
  'google', 'gmail', 'googlemail', 'googlecalendar', 'googledrive', 'gcal',
  'youtube', 'gcp',
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
]);

const GOOGLE_ACCOUNT_REGISTRY_IDS = new Set([
  '@modelcontextprotocol/server-google-drive',
  'gmail-mcp',
  'google-calendar-mcp',
  'youtube-mcp',
  'gcp-mcp',
]);

function normalizeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[._\-/\s]+/g, '');
}

function isGoogleAccountActionType(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[.\-:/\s]+/g, '_');
  if (GOOGLE_ACCOUNT_ACTION_TYPES.has(normalized)) return true;
  if (/^(?:read|search|list|archive|label|send|reply|draft|delete|forward|snooze|unsubscribe|move)_(?:email|emails|mail|message|messages)$/.test(normalized)) return true;
  if (/^(?:create|update|modify|delete|cancel|move|schedule|reschedule|respond_to)_(?:calendar_)?(?:event|events|invite|meeting|meetings)$/.test(normalized)) return true;
  if (/^(?:read|get|search|list)_(?:calendar_)?(?:event|events|invite|invites|meeting|meetings)$/.test(normalized)) return true;
  if (/^(?:email|emails|mail|message|messages)_(?:read|search|list|archive|label|send|reply|draft|delete|trash|forward|snooze|unsubscribe|move|modify)$/.test(normalized)) return true;
  if (/^(?:event|events|invite|invites|meeting|meetings)_(?:read|get|search|list|insert|create|update|patch|delete|remove|move|cancel|respond)$/.test(normalized)) return true;
  return /^(?:rsvp|calendar|email|mail|gmail|gcal|google_calendar|google_mail)_/.test(normalized);
}

export function isGoogleIntegrationIdentifier(value) {
  return String(value ?? '').split(':')
    .some(segment => GOOGLE_INTEGRATION_TOKENS.has(normalizeToken(segment)));
}

export function isGoogleAccountIntegration(input = {}) {
  const identifiers = [input.key, input.adapter, input.integration];
  return identifiers.some(value => isGoogleIntegrationIdentifier(value)) ||
    GOOGLE_ACCOUNT_REGISTRY_IDS.has(String(input.key ?? '').trim().toLowerCase()) ||
    (input.skills ?? []).some(isGoogleAccountActionType);
}
