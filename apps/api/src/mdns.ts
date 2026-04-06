import { Bonjour } from 'bonjour-service';

let bonjourInstance: Bonjour | null = null;

/**
 * Start advertising the SkyTwin API via mDNS/Bonjour so that
 * mobile devices on the local network can discover it automatically
 * (instead of relying on the hardcoded `skytwin.local` hostname).
 *
 * This is non-blocking: mDNS failures are logged but never crash the server.
 */
export function startMdnsAdvertisement(port: number): void {
  try {
    bonjourInstance = new Bonjour(undefined, (err: unknown) => {
      console.warn('[mdns] Bonjour error (non-fatal):', err);
    });

    bonjourInstance.publish({
      name: 'SkyTwin API',
      type: 'skytwin',
      protocol: 'tcp',
      port,
      txt: {
        path: '/',
        version: '0.4',
      },
    });

    console.info(`[mdns] Advertising _skytwin._tcp on port ${port}`);
  } catch (err: unknown) {
    console.warn('[mdns] Failed to start mDNS advertisement (non-fatal):', err);
    bonjourInstance = null;
  }
}

/**
 * Stop mDNS advertisement and release resources.
 * Safe to call even if advertisement was never started.
 */
export function stopMdnsAdvertisement(): void {
  try {
    if (bonjourInstance) {
      bonjourInstance.unpublishAll(() => {
        bonjourInstance?.destroy();
        bonjourInstance = null;
        console.info('[mdns] mDNS advertisement stopped');
      });
    }
  } catch (err: unknown) {
    console.warn('[mdns] Error stopping mDNS advertisement (non-fatal):', err);
    bonjourInstance = null;
  }
}
