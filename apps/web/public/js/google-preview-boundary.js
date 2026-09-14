const GOOGLE_INTEGRATION_TOKENS = new Set([
  'google', 'gmail', 'googlemail', 'googlecalendar', 'gcal',
]);

const GOOGLE_ACCOUNT_ACTION_TYPES = new Set([
  'archive_email', 'label_email', 'send_reply', 'reply_email', 'draft_email',
  'send_email', 'delete_email', 'forward_email', 'snooze_email',
  'unsubscribe_email', 'create_filter', 'move_to_folder', 'accept_invite',
  'decline_invite', 'decline_event', 'propose_alternative', 'tentative_accept',
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
  return String(value ?? '').trim().toLowerCase().replace(/[._-]/g, '');
}

export function isGoogleIntegrationIdentifier(value) {
  return String(value ?? '').split(':')
    .some(segment => GOOGLE_INTEGRATION_TOKENS.has(normalizeToken(segment)));
}

export function isGoogleAccountIntegration(input = {}) {
  const identifiers = [input.key, input.adapter, input.integration];
  return identifiers.some(value => isGoogleIntegrationIdentifier(value)) ||
    GOOGLE_ACCOUNT_REGISTRY_IDS.has(String(input.key ?? '').trim().toLowerCase()) ||
    (input.skills ?? []).some(skill => GOOGLE_ACCOUNT_ACTION_TYPES.has(
      String(skill).trim().toLowerCase(),
    ));
}
