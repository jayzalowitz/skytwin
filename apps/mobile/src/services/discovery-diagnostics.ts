/**
 * Pairing discovery diagnostics (#384 P2.4).
 *
 * mDNS pairing is LAN-multicast — most enterprise / corporate WiFi
 * blocks multicast, so `discoverSkyTwin` times out and the user got a
 * generic "not reachable" error with no way forward. This module turns
 * the signals the pairing flow already has into (a) a cause the UI can
 * branch on to show targeted troubleshooting, and (b) a validated
 * base URL for the manual-IP fallback.
 *
 * Both functions are pure + dependency-free so they unit-test without a
 * device, a network, or React Native.
 */

export type DiscoveryFailureCause =
  | 'no-mdns' // discovery found nothing — multicast likely blocked
  | 'mdns-but-no-connect' // found a host but couldn't reach the API (firewall / wrong port)
  | 'unknown';

export interface DiscoverySignals {
  /** Did mDNS resolve at least one `_skytwin._tcp` service? */
  servicesFound: boolean;
  /** Did we attempt an HTTP health check against a candidate host? */
  connectAttempted: boolean;
  /** Did that health check fail? (Only meaningful when connectAttempted.) */
  connectFailed: boolean;
}

/**
 * Classify why pairing failed, to pick the troubleshooting copy:
 *
 *   - servicesFound=false                  → 'no-mdns' (offer manual IP — the
 *                                             common office-WiFi case)
 *   - servicesFound=true + connectFailed   → 'mdns-but-no-connect' (host seen
 *                                             but unreachable — firewall / port)
 *   - anything else                        → 'unknown'
 */
export function classifyTimeout(signals: DiscoverySignals): DiscoveryFailureCause {
  if (!signals.servicesFound) return 'no-mdns';
  if (signals.connectAttempted && signals.connectFailed) return 'mdns-but-no-connect';
  return 'unknown';
}

const TROUBLESHOOTING: Record<DiscoveryFailureCause, string> = {
  'no-mdns':
    "Your phone couldn't find SkyTwin automatically. This is common on office or " +
    'public WiFi that blocks device discovery. Enter your computer’s IP address ' +
    'manually — you’ll find it in SkyTwin desktop Settings.',
  'mdns-but-no-connect':
    'SkyTwin was found on the network but your phone couldn’t connect to it. ' +
    'A firewall may be blocking the connection. Try entering the address manually, ' +
    'or check that SkyTwin is allowed through your computer’s firewall.',
  unknown:
    "Couldn't reach SkyTwin. Make sure your phone and computer are on the same " +
    'network, then try again or enter the address manually.',
};

/** Human-facing troubleshooting copy for a failure cause. */
export function troubleshootingMessage(cause: DiscoveryFailureCause): string {
  return TROUBLESHOOTING[cause];
}

/**
 * Validate + normalize a user-typed address into a base URL, or null if
 * it can't be a host. Accepts:
 *   - bare IPv4            192.168.1.42        → http://192.168.1.42:3100
 *   - IPv4 with port       192.168.1.42:3100   → http://192.168.1.42:3100
 *   - bracketed IPv6       [fe80::1]:3100      → http://[fe80::1]:3100
 *   - bare IPv6            fe80::1             → http://[fe80::1]:3100
 *   - hostname             my-mac.local        → http://my-mac.local:3100
 *   - full URL             http(s)://host[:p]  → as-is (trailing slash trimmed)
 *
 * The default port is 3100 (the desktop API). Anything with whitespace,
 * an empty host, or characters illegal in a host returns null so the UI
 * can show "enter a valid address" rather than build a broken URL.
 */
export function normalizeManualAddress(input: string, defaultPort = 3100): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Full URL — accept http/https only, trim trailing slashes.
  if (/^https?:\/\//i.test(trimmed)) {
    // Check the host BEFORE stripping trailing slashes — otherwise
    // 'http://' would collapse to 'http:' and slip through.
    const afterScheme = trimmed.replace(/^https?:\/\//i, '');
    const host = afterScheme.replace(/\/.*$/, ''); // drop any path
    if (host.length === 0 || /\s/.test(host)) return null;
    return trimmed.replace(/\/+$/, '');
  }

  if (/\s/.test(trimmed)) return null;

  // Bracketed IPv6 (optionally with :port) — pass through, default port.
  const bracketed = /^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/.exec(trimmed);
  if (bracketed) {
    const port = bracketed[2] ?? String(defaultPort);
    return `http://[${bracketed[1]}]:${port}`;
  }

  // Bare IPv6 (has 2+ colons and only hex/colons) — bracket it.
  if ((trimmed.match(/:/g) ?? []).length >= 2 && /^[0-9a-fA-F:]+$/.test(trimmed)) {
    return `http://[${trimmed}]:${defaultPort}`;
  }

  // host[:port] for IPv4 / hostname (single optional colon).
  const hostPort = /^([a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/.exec(trimmed);
  if (hostPort) {
    const host = hostPort[1]!;
    // A host can't be empty, start/end with a dot, or be all dots.
    if (host.length === 0 || host.startsWith('.') || host.endsWith('.') || /^\.+$/.test(host)) {
      return null;
    }
    const port = hostPort[2];
    if (port !== undefined) {
      const n = Number(port);
      if (n < 1 || n > 65535) return null;
      return `http://${host}:${port}`;
    }
    return `http://${host}:${defaultPort}`;
  }

  return null;
}
