import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isAccountBackedIntegration,
  isAccountBackedIntegrationIdentifier,
  isGoogleAccountIntegration,
  isGoogleIntegrationIdentifier,
} from '../google-preview-boundary.js';
import { renderDynamicIntegrations } from './setup.js';
import { renderUnmetCredentials } from './dashboard-view.js';
import { isVisiblePreviewCapability } from './capabilities.js';

function pageSource(name) {
  return readFileSync(resolve(process.cwd(), `public/js/pages/${name}.js`), 'utf8');
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Google preview UI boundary', () => {
  it('keeps the isolated onboarding sample primary and Google neutral', () => {
    const source = pageSource('onboarding');
    const welcome = between(source, 'function renderWelcome()', 'function renderEmailChoice()');
    const staleEmailStep = between(source, 'function renderEmailChoice()', 'function renderComputerChoice()');

    expect(welcome).toContain('id="onb-tour-button" class="btn btn-primary');
    expect(welcome).toContain('Unavailable in this preview');
    expect(welcome).not.toContain('data-action="onb-choose-email"');
    expect(welcome).not.toContain('data-action="onb-choose-about-me"');
    expect(staleEmailStep).toContain('Gmail and Google Calendar are unavailable');
    expect(staleEmailStep).not.toContain('data-action="onb-email-google"');
    expect(source).not.toContain("description: 'Gmail, Google Calendar");
    expect(source).toContain("description: 'Notion and Slack capabilities available in this preview.'");
  });

  it('recognizes hostile integration aliases and account-backed skills', () => {
    for (const key of [
      'google', 'openclaw:google', 'openclaw:gmail',
      'openclaw:google_calendar', 'openclaw:google-drive',
      'openclaw:google/drive', 'openclaw:google drive',
      'openclaw:gdrive',
      'openclaw:youtube', 'openclaw:gcp', 'google:calendar',
    ]) {
      expect(isGoogleIntegrationIdentifier(key)).toBe(true);
    }
    expect(isGoogleAccountIntegration({ key: 'custom:mail', skills: ['send_email'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:reader', skills: ['read_email'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['calendar.create'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['respondToEvent'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['schedule_focus_block'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:reader', skills: ['readGmail'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['getGoogleCalendarEvents'] })).toBe(true);
    for (const skill of [
      'getMessage', 'get_message', 'fetchEmail', 'modifyMessage', 'trashMessage',
      'createDraft', 'sendDraft', 'sendCalendarInvite',
    ]) {
      expect(isAccountBackedIntegration({ key: 'custom', skills: [skill] })).toBe(true);
    }
    expect(isGoogleAccountIntegration({ adapter: 'gmail-mcp', integration: 'custom' })).toBe(true);
    expect(isGoogleAccountIntegration({ adapter: 'custom', integration: 'google-calendar-mcp' })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:notes', skills: ['create_note'] })).toBe(false);
    for (const key of [
      'microsoft', 'openclaw:outlook', 'openclaw:outlook_calendar',
      'openclaw:microsoft-graph', 'office365', 'm365', 'o365', 'outlook365',
      'azure-ad', 'entra-id', 'azure-mcp', 'm365-mcp', 'o365-mcp',
      'azure-ad-mcp', 'entra-id-mcp', 'openclaw:onedrive',
      'openclaw:sharepoint', 'openclaw:exchange', 'openclaw:teams',
      'google-drive-mcp', 'onedrive-mcp', 'sharepoint-mcp', 'exchange-mcp',
      'teams-mcp',
    ]) {
      expect(isAccountBackedIntegrationIdentifier(key) ||
        isAccountBackedIntegration({ key })).toBe(true);
    }
    expect(isAccountBackedIntegration({ key: 'custom', skills: ['outlook.send_mail'] })).toBe(true);
    for (const skill of [
      'users.messages.send', 'me.messages.send', 'google.drive.files.list',
      'onedrive.files.list', 'sharepoint.sites.get', 'exchange.messages.send',
      'teams.messages.send', 'gdrive.files.list', 'youtube.videos.upload',
      'gcp.compute.instances.list', 'google.youtube.videos.list',
      'me.events.list', 'me.drive.root.children', 'me.mail.read',
      'me.calendar.get', 'users.list',
      'groups.events.list', 'groups.calendar.get', 'groups.threads.list',
      'groups.conversations.list', 'group.members.list',
      'users.byUserId.messages.list', 'users/123/messages/list',
      'groups.byGroupId.events.list', 'groups/123/threads/list', 'groups.list',
      'me.sendMail', 'users.sendMail', 'me.contacts.list', 'me.people.list',
      'me.todo.lists', 'me.memberOf', 'me.photo.get', 'me.mailboxSettings.get',
      'get_me_messages', 'list_users_messages', 'me__messages_list',
      'get_me', 'list_users', 'users/123', 'users.byUserId.get',
      'groups/123', 'groups.byGroupId.get', 'users.delta', 'groups.delta',
      'me.manager.get', 'me.presence.get', 'me.planner.tasks.list',
      'me.authentication.methods.list', 'me.onenote.notebooks.list',
      'users.byUserId.authentication.methods.list', 'users.byUserId.manager.get',
      'groups.byGroupId.owners.list',
      'send_user_mail', 'sendUserMail', 'add_group_member', 'addGroupMember',
      'invite_user', 'assign_user_license', 'revoke_user_sessions', 'export_users',
      'user_preferences_update', 'users_export', 'me_profile_update',
      'group_project_create', 'user', 'group',
    ]) {
      expect(isAccountBackedIntegration({ key: 'custom', skills: [skill] })).toBe(true);
    }
  });

  it('does not render credential controls for aliased or skill-shaped Google requirements', () => {
    const integrations = {
      'openclaw:gmail': {
        adapter: 'openclaw', integration: 'gmail', label: 'Mail', skills: [],
        fields: [{ key: 'token', label: 'Token', secret: true }],
      },
      'custom:mail': {
        adapter: 'custom', integration: 'mail', label: 'Peer mail', skills: ['send_email'],
        fields: [{ key: 'token', label: 'Token', secret: true }],
      },
      'openclaw:outlook': {
        adapter: 'openclaw', integration: 'outlook', label: 'Outlook', skills: [],
        fields: [{ key: 'token', label: 'Token', secret: true }],
      },
      'openclaw:github': {
        adapter: 'openclaw', integration: 'github', label: 'GitHub', skills: ['create_issue'],
        fields: [{ key: 'token', label: 'Token', secret: true }],
      },
    };

    const html = renderDynamicIntegrations(integrations, {});
    expect(html).not.toContain('openclaw:gmail');
    expect(html).not.toContain('custom:mail');
    expect(html).not.toContain('openclaw:outlook');
    expect(html).toContain('openclaw:github');
    expect(html).toContain('data-save-service="openclaw:github"');
  });

  it('filters stale Google requirements from the dashboard while preserving neighbors', () => {
    const html = renderUnmetCredentials({
      status: 'fulfilled',
      value: {
        unmet: [
          { key: 'openclaw:gmail', adapter: 'openclaw', integration: 'gmail', label: 'Mail', missingFields: ['token'], skills: [] },
          { key: 'openclaw:github', adapter: 'openclaw', integration: 'github', label: 'GitHub', missingFields: ['token'], skills: ['create_issue'] },
        ],
      },
    });
    expect(html).not.toContain('Mail');
    expect(html).toContain('GitHub');
  });

  it('filters stale capability payloads by registry, provider, and skill', () => {
    expect(isVisiblePreviewCapability({ registry_id: 'gmail-mcp' })).toBe(false);
    expect(isVisiblePreviewCapability({
      registry_id: 'custom-drive',
      oauth_provider: 'google',
    })).toBe(false);
    expect(isVisiblePreviewCapability({
      server_registry_id: 'custom-productivity',
      skill_name: 'sendEmail',
    })).toBe(false);
    expect(isVisiblePreviewCapability({
      registry_id: '@modelcontextprotocol/server-github',
      oauth_provider: 'github',
    })).toBe(true);
  });

  it('does not render Google credential, connect, or sync controls in setup', () => {
    const source = pageSource('setup');

    expect(source).toContain('Google account connection and credential entry are disabled');
    expect(source).toContain('Account-backed email and calendar actions are unavailable');
    expect(source).toContain('href="#/sample"');
    expect(source).not.toContain('id="cred-google-');
    expect(source).not.toContain('data-save-service="google"');
    expect(source).not.toContain('data-action="connect-google"');
    expect(source).not.toContain("renderIronClawSyncSummary('google'");
  });

  it('uses provider-neutral copy for blocked capability actions', () => {
    const assistant = pageSource('assistant');
    const capabilities = pageSource('capabilities');

    expect(assistant).toContain('Account-backed capabilities are unavailable in this preview.');
    expect(capabilities).toContain('Account-backed capabilities are unavailable in this preview.');
    expect(assistant).not.toContain('Google account capabilities are unavailable');
    expect(capabilities).not.toContain('Google account capabilities are unavailable');
  });

  it('does not expose Google account actions in settings', () => {
    const source = pageSource('settings');

    expect(source).toContain('Real-account connections are outside this preview');
    expect(source).toContain('No account access');
    expect(source).not.toContain('data-action="connect-google"');
    expect(source).not.toContain('data-action="disconnect-google"');
  });

  it('suppresses stale Google callback success and offers only the sample on dashboard', () => {
    const source = pageSource('dashboard-view');
    const celebration = between(
      source,
      'export function renderJustConnectedCelebration',
      'export function renderConnectGoogleHero',
    );
    const googleHero = between(
      source,
      'export function renderConnectGoogleHero',
      'export function renderConnectGmailHero',
    );

    expect(celebration).toContain("justConnectedProvider === 'google'");
    expect(googleHero).toContain('Unavailable in preview');
    expect(googleHero).toContain('href="#/sample"');
    expect(googleHero).not.toContain('data-action="connect-google"');
    expect(source).not.toContain('href="#/connect-gmail"');
  });
});
