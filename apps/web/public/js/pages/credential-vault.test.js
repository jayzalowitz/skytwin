// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJSON: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../api-client.js', () => ({
  fetchJSON: mocks.fetchJSON,
  escapeHtml: (value) => String(value),
}));

vi.mock('../toast.js', () => ({
  showToast: mocks.showToast,
}));

import { renderCredentialVault } from './credential-vault.js';

const source = readFileSync(new NodeURL('./credential-vault.js', import.meta.url), 'utf8');

function normalizedText(element) {
  return element.textContent.replace(/\s+/g, ' ').trim();
}

function expectSharedLimitations(text) {
  expect(text).toContain('This vault does not encrypt account identifiers, scopes, preferences');
  expect(text).toContain('Use full-disk encryption for the database as a whole.');
}

describe('credential vault truth boundary', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="page"></main>';
    window.location.hash = '#/credential-vault';
    delete window.skytwinDesktop;
    mocks.fetchJSON.mockReset();
    mocks.showToast.mockReset();
  });

  it.each([
    ['OAuth encrypted-at-rest', /OAuth tokens\s+are encrypted at rest/i],
    ['initialization encrypts OAuth', /Set a passphrase to encrypt\s+your stored OAuth tokens/i],
    ['unlock decrypts OAuth', /decrypt\s+your OAuth tokens for this session/i],
    ['passphrase is never stored', /passphrase is never stored/i],
    ['unqualified OS keychain', /stored in your operating system keychain/i],
  ])('does not make an unqualified protection claim: %s', (_label, claimPattern) => {
    expect(source).not.toMatch(claimPattern);
  });

  it('renders the plaintext boundary before initialization', async () => {
    mocks.fetchJSON.mockResolvedValueOnce({ initialized: false });
    const container = document.getElementById('page');

    await renderCredentialVault(container, 'user-1');
    const text = normalizedText(container);

    expectSharedLimitations(text);
    expect(container.querySelector('strong')?.style.color).toBe('var(--danger)');
    expect(text).toContain(
      'New OAuth grants are stored in plaintext until you initialize the vault.',
    );
    expect(text).toContain('Existing plaintext grants are not changed merely by opening this page.');
    expect(text).toContain('Vault state: Not initialized');
  });

  it('renders locked vault writes as fail-closed', async () => {
    mocks.fetchJSON.mockResolvedValueOnce({
      initialized: true,
      unlocked: false,
      keyVersion: 1,
    });
    const container = document.getElementById('page');

    await renderCredentialVault(container, 'user-1');
    const text = normalizedText(container);

    expectSharedLimitations(text);
    expect(text).toContain(
      'New and reconnected grants fail closed until you unlock it;',
    );
    expect(text).toContain(
      "The background worker does not receive the API process's key.",
    );
    expect(text).toContain('Vault state: Initialized Locked');
  });

  it('renders the encrypted API path and bounded legacy migration', async () => {
    mocks.fetchJSON.mockResolvedValueOnce({
      initialized: true,
      unlocked: true,
      keyVersion: 2,
    });
    const container = document.getElementById('page');

    await renderCredentialVault(container, 'user-1');
    const text = normalizedText(container);

    expectSharedLimitations(text);
    expect(text).toContain(
      'New and reconnected grants are encrypted with the current vault generation.',
    );
    expect(text).toContain(
      'Existing complete plaintext grants can migrate on authorized use.',
    );
    expect(text).toContain(
      "The background worker does not receive this API process's key",
    );
    expect(text).toContain('Plaintext OAuth rows are not migrated by rotation;');
    expect(text).toContain('Vault state: Initialized Unlocked');
  });
});
