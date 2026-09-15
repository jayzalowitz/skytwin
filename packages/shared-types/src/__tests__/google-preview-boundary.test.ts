import { describe, expect, it } from 'vitest';
import {
  isAccountBackedActionType,
  isAccountBackedEmailOrCalendarAction,
  isAccountBackedIntegration,
  isAccountBackedIntegrationIdentifier,
  isAccountBackedRegistryIdentifier,
  isGoogleAccountActionType,
  isGoogleAccountIntegration,
  isGoogleAccountRegistryIdentifier,
  isGoogleIntegrationIdentifier,
  isMicrosoftAccountRegistryIdentifier,
  isMicrosoftIntegrationIdentifier,
} from '../google-preview-boundary.js';

describe('Google preview boundary', () => {
  it.each([
    'google',
    'openclaw:google',
    'openclaw:gmail',
    'openclaw:google_calendar',
    'openclaw:google-calendar',
    'openclaw:google-drive',
    'openclaw:google/drive',
    'openclaw:google drive',
    'openclaw:youtube',
    'openclaw:gcp',
    'google:calendar',
    'GCAL',
  ])('recognizes the account integration alias %s', (identifier) => {
    expect(isGoogleIntegrationIdentifier(identifier)).toBe(true);
  });

  it.each(['github', 'openclaw:outlook', 'calendar-tools', 'google-drive-proxy'])
    ('does not infer Google account access from the unrelated identifier %s', (identifier) => {
      expect(isGoogleIntegrationIdentifier(identifier)).toBe(false);
    });

  it.each([
    'microsoft', 'openclaw:outlook', 'openclaw:outlook_calendar',
    'openclaw:microsoft-graph', 'm365', 'ms365', 'office365', 'o365',
    'outlook365', 'azure', 'azuread', 'azure-ad', 'entra', 'entraid', 'entra-id',
  ])('recognizes the Microsoft account integration alias %s', (identifier) => {
    expect(isMicrosoftIntegrationIdentifier(identifier)).toBe(true);
    expect(isAccountBackedIntegrationIdentifier(identifier)).toBe(true);
  });

  it.each(['github', 'calendar-tools', 'microsoft-proxy'])
    ('does not infer Microsoft account access from the unrelated identifier %s', (identifier) => {
      expect(isMicrosoftIntegrationIdentifier(identifier)).toBe(false);
    });

  it('recognizes Microsoft account metadata and cached skills', () => {
    expect(isAccountBackedIntegration({ integration: 'outlook' })).toBe(true);
    expect(isAccountBackedIntegration({ integration: 'microsoft' })).toBe(true);
    expect(isAccountBackedIntegration({ key: 'azure-mcp' })).toBe(true);
    expect(isAccountBackedIntegration({ key: 'custom', skills: ['outlook.send_mail'] })).toBe(true);
    expect(isAccountBackedIntegration({ key: 'custom', skills: ['create_note'] })).toBe(false);
  });

  it('recognizes dynamic requirements by stable identifiers or account-backed skills', () => {
    expect(isGoogleAccountIntegration({ adapter: 'openclaw', integration: 'gmail' })).toBe(true);
    expect(isGoogleAccountIntegration({ adapter: 'gmail-mcp', integration: 'custom' })).toBe(true);
    expect(isGoogleAccountIntegration({ adapter: 'custom', integration: 'google-calendar-mcp' })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:mail', skills: ['send_email'] })).toBe(true);
    expect(isGoogleAccountIntegration({
      key: 'custom:notes',
      adapter: 'custom',
      integration: 'notes',
      skills: ['create_note'],
    })).toBe(false);
  });

  it.each([
    'send_email', 'forward_email', 'accept_invite', 'create_calendar_event',
    'respond_to_event', 'delete_emails', 'read_email', 'search_emails',
    'create_event', 'update_event', 'schedule_meeting', 'calendar.create',
    'calendar_update', 'rsvp_yes', 'get_calendar_events', 'email.search',
    'gmail.batch_modify', 'messages.trash', 'events.insert', 'sendEmail',
    'readEmail', 'respondToEvent', 'deleteEmails', 'schedule_focus_block',
    'readGmail', 'sendGoogleMail', 'getGoogleCalendarEvents',
    'getMessage', 'get_message', 'fetchEmail', 'modifyMessage', 'trashMessage',
    'createDraft', 'sendDraft', 'sendCalendarInvite',
  ])
    ('recognizes the account-backed action %s', (actionType) => {
      expect(isGoogleAccountActionType(actionType)).toBe(true);
    });

  it.each(['acknowledge', 'dismiss', 'create_note'])
    ('keeps the local action %s outside the account boundary', (actionType) => {
      expect(isGoogleAccountActionType(actionType)).toBe(false);
    });

  it.each([
    'outlook.send_mail', 'read_outlook_mail', 'microsoft_graph.list_events',
    'm365.list_messages', 'o365.get_events', 'azure.list_storage',
    'azure-ad.list_users', 'entra-id.get_user',
  ])
    ('recognizes the provider-qualified account-backed action %s', (actionType) => {
      expect(isAccountBackedActionType(actionType)).toBe(true);
    });

  it.each([
    '@modelcontextprotocol/server-google-drive',
    'gmail-mcp',
    'google-calendar-mcp',
    'youtube-mcp',
    'gcp-mcp',
  ])('recognizes the Google account registry entry %s', (registryId) => {
    expect(isGoogleAccountRegistryIdentifier(registryId)).toBe(true);
  });

  it.each([
    'azure-mcp', 'microsoft-365-mcp', 'm365-mcp', 'ms365-mcp',
    'microsoft-graph-mcp', 'office365-mcp', 'o365-mcp', 'outlook-mcp',
    'outlook365-mcp', 'azure-ad-mcp', 'azuread-mcp', 'entra-id-mcp',
    'entraid-mcp',
  ])
    ('recognizes the Microsoft account registry entry %s', (registryId) => {
      expect(isMicrosoftAccountRegistryIdentifier(registryId)).toBe(true);
      expect(isAccountBackedRegistryIdentifier(registryId)).toBe(true);
    });

  it('uses provider-agnostic account domains and MCP tool identity as deny signals', () => {
    expect(isAccountBackedEmailOrCalendarAction({ actionType: 'accept', domain: 'calendar' })).toBe(true);
    expect(isAccountBackedEmailOrCalendarAction({ actionType: 'accept', domain: 'google:calendar' })).toBe(true);
    expect(isAccountBackedEmailOrCalendarAction({ actionType: 'invoke_tool', domain: 'outlook' })).toBe(true);
    expect(isAccountBackedEmailOrCalendarAction({
      actionType: 'invoke_tool',
      domain: 'developer',
      parameters: { mcpToolName: 'read_email' },
    })).toBe(true);
    expect(isAccountBackedEmailOrCalendarAction({ actionType: 'create_issue', domain: 'developer' })).toBe(false);
  });

  it('keeps a neighboring registry entry available', () => {
    expect(isGoogleAccountRegistryIdentifier('@modelcontextprotocol/server-github')).toBe(false);
  });
});
