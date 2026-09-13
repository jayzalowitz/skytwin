import { describe, expect, it } from 'vitest';
import {
  hasSampleCredential,
  isLocalOnlySamplePath,
  isLoopbackApiBase,
  isLoopbackPeer,
  requiresLocalSampleBoundary,
} from './proxy-safety.js';

describe('sample proxy boundary', () => {
  it('recognizes only actual loopback peers', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('192.168.1.10')).toBe(false);
    expect(isLoopbackPeer('127.0.0.1.example')).toBe(false);
  });

  it('covers the local-only sample entry and command surfaces', () => {
    expect(isLocalOnlySamplePath('/api/v1/demo/info')).toBe(true);
    expect(isLocalOnlySamplePath('/api/v1/demo/session')).toBe(true);
    expect(isLocalOnlySamplePath('/api/v1/demo/simulation/commands')).toBe(true);
    expect(isLocalOnlySamplePath('/api/v1/demo/recipes')).toBe(false);
    expect(isLocalOnlySamplePath('/api/v1/demo/preview')).toBe(false);
    expect(isLocalOnlySamplePath('/API/V1/DEMO/INFO')).toBe(true);
    expect(isLocalOnlySamplePath('/Api/V1/Demo/Session')).toBe(true);
    expect(
      isLocalOnlySamplePath('/aPi/v1/dEmO/sImUlAtIoN/commands'),
    ).toBe(true);
  });

  it('accepts only credential-free HTTP loopback API origins for sample forwarding', () => {
    expect(isLoopbackApiBase('http://localhost:3100')).toBe(true);
    expect(isLoopbackApiBase('http://127.0.0.1:3100')).toBe(true);
    expect(isLoopbackApiBase('http://[::1]:3100')).toBe(true);
    for (const hostile of [
      'https://api.example.com',
      'http://127.0.0.1.example.com',
      'http://user:secret@127.0.0.1:3100',
      'https://127.0.0.1:3100',
      'http://127.0.0.1:3100/forward',
      'not a URL',
    ]) {
      expect(isLoopbackApiBase(hostile)).toBe(false);
    }
  });

  it('detects sample credentials on every proxied path and transport', () => {
    const token = 'skytwin-demo-v1.1234567890123.abcdefghijklmnopqrstuvwx.signature';
    expect(
      hasSampleCredential(
        ['Bearer ordinary-session', `Bearer ${token}`],
        new URL('/api/decisions/sample', 'http://localhost'),
      ),
    ).toBe(true);
    expect(
      hasSampleCredential(
        undefined,
        new URL(`/api/twin/sample?token=${encodeURIComponent(token)}`, 'http://localhost'),
      ),
    ).toBe(true);
    expect(
      hasSampleCredential(
        'Bearer ordinary-session',
        new URL('/api/decisions/ordinary', 'http://localhost'),
      ),
    ).toBe(false);

    const ordinaryRead = new URL('/api/decisions/sample', 'http://localhost');
    expect(
      requiresLocalSampleBoundary(
        ordinaryRead.pathname,
        `Bearer ${token}`,
        ordinaryRead,
      ),
    ).toBe(true);
    expect(
      requiresLocalSampleBoundary(
        ordinaryRead.pathname,
        'Bearer ordinary-session',
        ordinaryRead,
      ),
    ).toBe(false);
  });
});
