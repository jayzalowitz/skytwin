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

function expectInactiveBoundary(text) {
  expect(text).toContain('OAuth token encryption is not active in this build.');
  expect(text).toContain(
    'Current production OAuth write paths store access and refresh tokens in plaintext.',
  );
  expect(text).toContain('These controls manage preparatory API-local key state only.');
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
  ])('does not make the inactive production claim: %s', (_label, claimPattern) => {
    expect(source).not.toMatch(claimPattern);
  });

  it('renders the plaintext production boundary before initialization', async () => {
    mocks.fetchJSON.mockResolvedValueOnce({ initialized: false });
    const container = document.getElementById('page');

    await renderCredentialVault(container, 'user-1');
    const text = normalizedText(container);

    expectInactiveBoundary(text);
    expect(container.querySelector('strong')?.style.color).toBe('var(--danger)');
    expect(text).toContain(
      'This does not encrypt current OAuth token rows or new OAuth grants.',
    );
    expect(text).toContain('Preparatory key state: Not initialized');
  });

  it('renders unlock as API-local state rather than OAuth decryption', async () => {
    mocks.fetchJSON.mockResolvedValueOnce({
      initialized: true,
      unlocked: false,
      keyVersion: 1,
    });
    const container = document.getElementById('page');

    await renderCredentialVault(container, 'user-1');
    const text = normalizedText(container);

    expectInactiveBoundary(text);
    expect(text).toContain(
      'Unlock the preparatory API-local key cache for this session.',
    );
    expect(text).toContain(
      'This does not decrypt or migrate OAuth tokens written by current production paths.',
    );
    expect(text).toContain('Preparatory key state: Initialized Locked');
  });

  it('limits rotation claims to OAuth rows that are already encrypted', async () => {
    mocks.fetchJSON.mockResolvedValueOnce({
      initialized: true,
      unlocked: true,
      keyVersion: 2,
    });
    const container = document.getElementById('page');

    await renderCredentialVault(container, 'user-1');
    const text = normalizedText(container);

    expectInactiveBoundary(text);
    expect(text).toContain(
      'Change the key used by OAuth rows that are already encrypted, if any.',
    );
    expect(text).toContain(
      'new grants still use the current plaintext write path.',
    );
    expect(text).toContain('Preparatory key state: Initialized Unlocked');
  });
});
