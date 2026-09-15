import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isGoogleAccountIntegration,
  isGoogleIntegrationIdentifier,
} from '../google-preview-boundary.js';
import { renderDynamicIntegrations } from './setup.js';
import { renderUnmetCredentials } from './dashboard-view.js';

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
  });

  it('recognizes hostile integration aliases and account-backed skills', () => {
    for (const key of [
      'google', 'openclaw:google', 'openclaw:gmail',
      'openclaw:google_calendar', 'openclaw:google-drive',
      'openclaw:google/drive', 'openclaw:google drive',
      'openclaw:youtube', 'openclaw:gcp', 'google:calendar',
    ]) {
      expect(isGoogleIntegrationIdentifier(key)).toBe(true);
    }
    expect(isGoogleAccountIntegration({ key: 'custom:mail', skills: ['send_email'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:reader', skills: ['read_email'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['calendar.create'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['respondToEvent'] })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:calendar', skills: ['schedule_focus_block'] })).toBe(true);
    expect(isGoogleAccountIntegration({ adapter: 'gmail-mcp', integration: 'custom' })).toBe(true);
    expect(isGoogleAccountIntegration({ adapter: 'custom', integration: 'google-calendar-mcp' })).toBe(true);
    expect(isGoogleAccountIntegration({ key: 'custom:notes', skills: ['create_note'] })).toBe(false);
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
      'openclaw:github': {
        adapter: 'openclaw', integration: 'github', label: 'GitHub', skills: ['create_issue'],
        fields: [{ key: 'token', label: 'Token', secret: true }],
      },
    };

    const html = renderDynamicIntegrations(integrations, {});
    expect(html).not.toContain('openclaw:gmail');
    expect(html).not.toContain('custom:mail');
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

  it('does not render Google credential, connect, or sync controls in setup', () => {
    const source = pageSource('setup');

    expect(source).toContain('Google account connection and credential entry are disabled');
    expect(source).toContain('href="#/sample"');
    expect(source).not.toContain('id="cred-google-');
    expect(source).not.toContain('data-save-service="google"');
    expect(source).not.toContain('data-action="connect-google"');
    expect(source).not.toContain("renderIronClawSyncSummary('google'");
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
