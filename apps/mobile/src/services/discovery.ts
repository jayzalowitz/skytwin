import Zeroconf from 'react-native-zeroconf';

interface DiscoveredService {
  host: string;
  port: number;
}

const DEFAULT_FALLBACK: DiscoveredService = {
  host: 'skytwin.local',
  port: 3100,
};

/**
 * Discover a SkyTwin API instance on the local network via mDNS.
 *
 * Scans for `_skytwin._tcp` services published by the desktop API.
 * Returns the first service found, or null if discovery times out.
 *
 * Falls back to `skytwin.local:3100` if `useFallback` is true (default).
 */
export async function discoverSkyTwin(
  timeoutMs: number = 5000,
  useFallback: boolean = true,
): Promise<DiscoveredService | null> {
  return new Promise((resolve) => {
    const zeroconf = new Zeroconf();
    let resolved = false;

    const cleanup = (): void => {
      if (!resolved) {
        resolved = true;
        try {
          zeroconf.stop();
          zeroconf.removeAllListeners();
        } catch {
          // Zeroconf cleanup can throw if already stopped; ignore.
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(useFallback ? DEFAULT_FALLBACK : null);
    }, timeoutMs);

    zeroconf.on('resolved', (service: { host: string; port: number }) => {
      if (resolved) return;
      clearTimeout(timer);
      cleanup();
      resolve({
        host: service.host,
        port: service.port,
      });
    });

    zeroconf.on('error', (err: unknown) => {
      console.warn('[discovery] mDNS error:', err);
      if (!resolved) {
        clearTimeout(timer);
        cleanup();
        resolve(useFallback ? DEFAULT_FALLBACK : null);
      }
    });

    try {
      zeroconf.scan('skytwin', 'tcp', 'local.');
    } catch (err: unknown) {
      console.warn('[discovery] Failed to start mDNS scan:', err);
      clearTimeout(timer);
      cleanup();
      resolve(useFallback ? DEFAULT_FALLBACK : null);
    }
  });
}

/**
 * Build a base URL from a discovered service.
 */
export function buildBaseUrl(service: DiscoveredService): string {
  return `http://${service.host}:${service.port}`;
}
