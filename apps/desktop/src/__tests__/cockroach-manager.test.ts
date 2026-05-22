import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock electron BEFORE importing CockroachManager so app.* doesn't blow up in node.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (key: string) => `/tmp/electron-userdata-${key}`,
  },
}));

const { CockroachManager } = await import('../cockroach-manager.js');

describe('CockroachManager', () => {
  beforeEach(() => {
    delete process.env['SKYTWIN_DB_PORT'];
    delete process.env['SKYTWIN_DB_HTTP_PORT'];
  });

  it('honors SKYTWIN_DB_PORT for the connection string', () => {
    process.env['SKYTWIN_DB_PORT'] = '29257';
    const mgr = new CockroachManager();
    // Default listen host is 127.0.0.1 (not 'localhost') so we never
    // accidentally bind IPv6 :: on systems whose /etc/hosts maps
    // localhost to the unspecified address — that would expose the
    // --insecure CRDB to the LAN.
    expect(mgr.getConnectionString()).toBe(
      'postgresql://root@127.0.0.1:29257/skytwin?sslmode=disable',
    );
  });

  it('defaults to port 26257 when no env override', () => {
    const mgr = new CockroachManager();
    expect(mgr.getConnectionString()).toContain(':26257/');
  });

  it('binds 127.0.0.1 by default, not localhost', () => {
    const mgr = new CockroachManager();
    expect(mgr.getConnectionString()).toContain('@127.0.0.1:');
    expect(mgr.getConnectionString()).not.toContain('@localhost:');
  });

  it('resolves a per-platform binary path under userData in dev (unpackaged)', () => {
    const mgr = new CockroachManager();
    const bin = mgr.getBinaryPath();
    // In dev (mocked app.isPackaged=false), we fall back to ~/.local/share/skytwin/bin.
    expect(bin).toMatch(/\.local\/share\/skytwin\/bin\/cockroach(\.exe)?$/);
  });

  it('keeps the data dir under app.getPath(userData)', () => {
    const mgr = new CockroachManager();
    expect(mgr.getDataDir()).toBe('/tmp/electron-userdata-userData/crdb-data');
  });

  it('allows explicit port overrides via constructor', () => {
    const mgr = new CockroachManager({ sqlPort: 31000 });
    expect(mgr.getConnectionString()).toContain(':31000/');
  });
});
