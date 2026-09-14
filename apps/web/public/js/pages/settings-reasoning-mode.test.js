// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const webApi = vi.hoisted(() => ({
  fetchJSON: vi.fn(),
}));

vi.mock('../api-client.js', () => ({
  escapeHtml: (value) => {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  fetchJSON: webApi.fetchJSON,
}));

import { renderConnectGmail } from './connect-gmail.js';

const source = readFileSync(resolve(process.cwd(), 'public/js/pages/settings.js'), 'utf8');
const connectGmailSource = readFileSync(
  resolve(process.cwd(), 'public/js/pages/connect-gmail.js'),
  'utf8',
);
const apiSource = readFileSync(resolve(process.cwd(), 'public/js/api-client.js'), 'utf8');

describe('reasoning-location settings boundary', () => {
  it('renders local, explicit-provider, unavailable-private, confirmation, and error states', () => {
    expect(source).toContain('Where reasoning runs');
    expect(source).toContain('On this device');
    expect(source).toContain('My configured provider');
    expect(source).toContain('Verified private cloud — unavailable');
    expect(source).toContain('Your earlier provider chain was ambiguous');
    expect(source).toContain('Could not load the reasoning-location boundary');
    expect(source).toContain('Draft only — this selection is not active until you press Save');
  });

  it('invalidates server-derived privacy metadata when its mode or model changes', () => {
    expect(source).toContain('_aiChain.forEach((provider) => { provider.privacy = null; })');
    expect(source).toContain("field !== 'baseUrl' && field !== 'model'");
  });

  it('sends the explicit mode with provider saves and connection tests', () => {
    expect(apiSource).toMatch(/JSON\.stringify\(\{ providers, reasoningMode \}\)/);
    expect(source).toMatch(/reasoningMode: _reasoningMode/);
    expect(source).toMatch(/\}\)\), _reasoningMode\)/);
  });

  it('does not activate a draft mode through tests or priority autosaves', () => {
    expect(source).toContain(
      '_reasoningModeRequiresConfirmation || _reasoningMode !== _persistedReasoningMode',
    );
    expect(source).toContain('Save where reasoning runs before testing a provider.');
    expect(source).toContain('Save where reasoning runs before changing provider priority.');
  });

  it('uses delegated actions rather than inline event handlers', () => {
    const start = source.indexOf('function renderReasoningLocation');
    const end = source.indexOf('function renderModeToggle');
    const locationRenderer = source.slice(start, end);
    expect(locationRenderer).toContain('data-action="ai-reasoning-mode"');
    expect(locationRenderer).not.toMatch(/on(?:click|change|input|keydown)\s*=/i);
  });
});

describe('credential transfer disclosures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const entries = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => entries.get(key) ?? null),
      setItem: vi.fn((key, value) => entries.set(key, String(value))),
      removeItem: vi.fn((key) => entries.delete(key)),
    });
    document.body.innerHTML = '<main id="page-content"></main>';
    window.location.hash = '#/connect-gmail';
    webApi.fetchJSON.mockResolvedValue({ credentials: [] });
  });

  it('renders Google as unavailable without credential or connection controls', async () => {
    localStorage.setItem('skytwin_connect_gmail_step', '5');
    const container = document.getElementById('page-content');
    await renderConnectGmail(container);

    expect(container.textContent).toContain('Google accounts are unavailable in this preview');
    expect(container.textContent).toContain('isolated sample');
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[data-action]')).toBeNull();
    expect(container.querySelector('a[href="#/sample"]')).toBeInstanceOf(HTMLAnchorElement);
    expect(webApi.fetchJSON).not.toHaveBeenCalled();
    expect(connectGmailSource).toContain('legacy account-connection wizard retained below');
  });

  it('includes conditional IronClaw credential transfer in the Settings network summary', () => {
    expect(source).toContain('configured CockroachDB database');
    expect(source).toContain('server and self-hosted configurations can point it elsewhere');
    expect(source).not.toContain('persistent application database is stored on this computer');
    expect(source).toContain('When an IronClaw execution adapter is configured');
    expect(source).toContain('stored service credentials are also registered');
    expect(source).toContain('with that configured server, which may be remote');
  });

  it('renders Settings Google status as unavailable without account actions', () => {
    expect(source).toContain('Google (Gmail + Calendar)');
    expect(source).toContain('Unavailable in this preview');
    expect(source).toContain('No account access');
    expect(source).not.toContain('data-action="connect-google"');
    expect(source).not.toContain('data-action="disconnect-google"');
  });

  it('states the limit of pattern-based crash-report scrubbing', () => {
    expect(source).not.toContain('No personal data, email, or twin content is ever included');
    expect(source).toContain('recognized email addresses, credential patterns, and user-home paths');
    expect(source).toContain('no dedicated account, message, calendar, memory, or twin-profile fields');
    expect(source).toContain('may still contain incidental content or unknown secret formats');
    expect(source).not.toContain('URLs, and request content before upload');
    expect(source).toContain('Off by default');
  });
});
