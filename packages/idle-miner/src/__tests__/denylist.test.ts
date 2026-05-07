import { describe, it, expect } from 'vitest';
import { isDenied } from '../denylist.js';

const HOME = '/Users/testuser';

describe('isDenied', () => {
  it('returns true for ~/.ssh/id_rsa', () => {
    expect(isDenied(`${HOME}/.ssh/id_rsa`, HOME)).toBe(true);
  });

  it('returns true for ~/.aws/credentials', () => {
    expect(isDenied(`${HOME}/.aws/credentials`, HOME)).toBe(true);
  });

  it('returns true for a .pem file', () => {
    expect(isDenied(`${HOME}/Documents/server.pem`, HOME)).toBe(true);
  });

  it('returns false for ~/Documents/notes.md', () => {
    expect(isDenied(`${HOME}/Documents/notes.md`, HOME)).toBe(false);
  });

  it('returns true for ~/Documents/.env.production', () => {
    expect(isDenied(`${HOME}/Documents/.env.production`, HOME)).toBe(true);
  });

  it('returns true for symlink target inside ~/.ssh', () => {
    // Mock realpathFn: the file resolves to inside ~/.ssh
    const realpathFn = (p: string) => {
      if (p === `${HOME}/Documents/linked-key`) {
        return `${HOME}/.ssh/id_rsa`;
      }
      return p;
    };
    expect(isDenied(`${HOME}/Documents/linked-key`, HOME, { realpathFn })).toBe(true);
  });

  it('returns true for paths inside ~/.gnupg directory', () => {
    // ~/.gnupg is in the denylist, so files within it must be denied
    expect(isDenied(`${HOME}/.gnupg/pubring.kbx`, HOME)).toBe(true);
    expect(isDenied(`${HOME}/.gnupg`, HOME)).toBe(true);
  });

  it('returns true for ~/.kube/config', () => {
    expect(isDenied(`${HOME}/.kube/config`, HOME)).toBe(true);
  });

  it('returns false for a symlink whose realpath is outside denylist', () => {
    const realpathFn = (p: string) => {
      if (p === `${HOME}/Documents/safe-link`) {
        return `${HOME}/Documents/real-notes.md`;
      }
      return p;
    };
    expect(isDenied(`${HOME}/Documents/safe-link`, HOME, { realpathFn })).toBe(false);
  });

  it('returns true for a .key file in Documents', () => {
    expect(isDenied(`${HOME}/Documents/private.key`, HOME)).toBe(true);
  });

  it('returns true for a .kdbx file (KeePass)', () => {
    expect(isDenied(`${HOME}/Documents/passwords.kdbx`, HOME)).toBe(true);
  });

  it('returns true for a .gpg encrypted file', () => {
    expect(isDenied(`${HOME}/Documents/secret.gpg`, HOME)).toBe(true);
  });
});
