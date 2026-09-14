import { describe, expect, it } from 'vitest';
import {
  isGoogleAccountActionType,
  isGoogleAccountIntegration,
  isGoogleAccountRegistryIdentifier,
  isGoogleIntegrationIdentifier,
} from '../google-preview-boundary.js';

describe('Google preview boundary', () => {
  it.each([
    'google',
    'openclaw:google',
    'openclaw:gmail',
    'openclaw:google_calendar',
    'openclaw:google-calendar',
    'google:calendar',
    'GCAL',
  ])('recognizes the account integration alias %s', (identifier) => {
    expect(isGoogleIntegrationIdentifier(identifier)).toBe(true);
  });

  it.each(['github', 'openclaw:outlook', 'calendar-tools', 'google-drive-proxy'])
    ('does not infer Google account access from the unrelated identifier %s', (identifier) => {
      expect(isGoogleIntegrationIdentifier(identifier)).toBe(false);
    });

  it('recognizes dynamic requirements by stable identifiers or account-backed skills', () => {
    expect(isGoogleAccountIntegration({ adapter: 'openclaw', integration: 'gmail' })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:mail', skills: ['send_email'] })).toBe(true);
    expect(isGoogleAccountIntegration({
      key: 'custom:notes',
      adapter: 'custom',
      integration: 'notes',
      skills: ['create_note'],
    })).toBe(false);
  });

  it.each(['send_email', 'forward_email', 'accept_invite', 'create_calendar_event'])
    ('recognizes the account-backed action %s', (actionType) => {
      expect(isGoogleAccountActionType(actionType)).toBe(true);
    });

  it.each(['acknowledge', 'dismiss', 'create_note'])
    ('keeps the local action %s outside the account boundary', (actionType) => {
      expect(isGoogleAccountActionType(actionType)).toBe(false);
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

  it('keeps a neighboring registry entry available', () => {
    expect(isGoogleAccountRegistryIdentifier('@modelcontextprotocol/server-github')).toBe(false);
  });
});
