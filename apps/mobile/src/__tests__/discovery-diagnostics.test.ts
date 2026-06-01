import { describe, it, expect } from 'vitest';
import {
  classifyTimeout,
  normalizeManualAddress,
  troubleshootingMessage,
} from '../services/discovery-diagnostics';

describe('classifyTimeout', () => {
  it('no services found → no-mdns (multicast likely blocked)', () => {
    expect(
      classifyTimeout({ servicesFound: false, connectAttempted: true, connectFailed: true }),
    ).toBe('no-mdns');
    // Even if no connect was attempted, no services ⇒ no-mdns.
    expect(
      classifyTimeout({ servicesFound: false, connectAttempted: false, connectFailed: false }),
    ).toBe('no-mdns');
  });

  it('service found but connect failed → mdns-but-no-connect', () => {
    expect(
      classifyTimeout({ servicesFound: true, connectAttempted: true, connectFailed: true }),
    ).toBe('mdns-but-no-connect');
  });

  it('service found and connect did not fail → unknown', () => {
    expect(
      classifyTimeout({ servicesFound: true, connectAttempted: true, connectFailed: false }),
    ).toBe('unknown');
    expect(
      classifyTimeout({ servicesFound: true, connectAttempted: false, connectFailed: false }),
    ).toBe('unknown');
  });

  it('every cause has non-empty troubleshooting copy', () => {
    for (const cause of ['no-mdns', 'mdns-but-no-connect', 'unknown'] as const) {
      expect(troubleshootingMessage(cause).length).toBeGreaterThan(20);
    }
  });
});

describe('normalizeManualAddress', () => {
  it('bare IPv4 → default port 3100', () => {
    expect(normalizeManualAddress('192.168.1.42')).toBe('http://192.168.1.42:3100');
  });

  it('IPv4 with explicit port', () => {
    expect(normalizeManualAddress('192.168.1.42:8080')).toBe('http://192.168.1.42:8080');
  });

  it('hostname → default port', () => {
    expect(normalizeManualAddress('my-mac.local')).toBe('http://my-mac.local:3100');
  });

  it('full http(s) URL passes through, trailing slash trimmed', () => {
    expect(normalizeManualAddress('http://10.0.0.5:3100/')).toBe('http://10.0.0.5:3100');
    expect(normalizeManualAddress('https://host.example')).toBe('https://host.example');
  });

  it('bracketed IPv6 with + without port', () => {
    expect(normalizeManualAddress('[fe80::1]:3100')).toBe('http://[fe80::1]:3100');
    expect(normalizeManualAddress('[fe80::1]')).toBe('http://[fe80::1]:3100');
  });

  it('bare IPv6 gets bracketed', () => {
    expect(normalizeManualAddress('fe80::1')).toBe('http://[fe80::1]:3100');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeManualAddress('  192.168.1.42  ')).toBe('http://192.168.1.42:3100');
  });

  it('rejects empty / whitespace-only / interior-whitespace input', () => {
    expect(normalizeManualAddress('')).toBeNull();
    expect(normalizeManualAddress('   ')).toBeNull();
    expect(normalizeManualAddress('192.168 .1.42')).toBeNull();
  });

  it('rejects an out-of-range port', () => {
    expect(normalizeManualAddress('192.168.1.42:0')).toBeNull();
    expect(normalizeManualAddress('192.168.1.42:99999')).toBeNull();
  });

  it('rejects malformed hosts', () => {
    expect(normalizeManualAddress('.')).toBeNull();
    expect(normalizeManualAddress('.foo')).toBeNull();
    expect(normalizeManualAddress('foo.')).toBeNull();
    expect(normalizeManualAddress('http://')).toBeNull();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — exercising the runtime guard.
    expect(normalizeManualAddress(null)).toBeNull();
    // @ts-expect-error — exercising the runtime guard.
    expect(normalizeManualAddress(42)).toBeNull();
  });

  it('honours a custom default port', () => {
    expect(normalizeManualAddress('192.168.1.42', 9000)).toBe('http://192.168.1.42:9000');
  });
});
