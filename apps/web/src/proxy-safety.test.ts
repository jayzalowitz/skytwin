import { describe, expect, it } from 'vitest';
import { isLocalOnlySamplePath, isLoopbackPeer } from './proxy-safety.js';

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
  });
});
