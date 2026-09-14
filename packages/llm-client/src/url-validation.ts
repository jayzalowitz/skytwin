import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';
import { canonicalizeProviderBaseUrl } from '@skytwin/shared-types';

type DnsLookup = typeof dnsLookup;

function signalAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function lookupWithAbort(
  hostname: string,
  lookup: DnsLookup,
  signal: AbortSignal | null | undefined,
): Promise<Array<{ address: string; family: number }>> {
  if (!signal) return lookup(hostname, { all: true, verbatim: true });
  if (signal.aborted) return Promise.reject(signalAbortReason(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(signalAbortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(
      (addresses) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(addresses);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Validate that a base URL is safe for use with external API providers.
 * Blocks private/internal IP ranges to prevent SSRF attacks.
 *
 * Ollama gets a loopback-only exemption (localhost, 127.0.0.1, ::1).
 * All other private ranges are blocked for every provider.
 *
 * Note: This checks literal hostnames/IPs only. For DNS rebinding protection,
 * use validateBaseUrlWithDns() at save time.
 */
export function validateBaseUrl(baseUrl: string, provider: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid base URL for ${provider}: ${baseUrl}`);
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol for ${provider}: ${parsed.protocol}`);
  }

  try {
    // Keep every admission path aligned with the canonical form used for
    // persistence. In particular, query strings, fragments, and embedded
    // credentials must be rejected before an adapter appends its API path.
    parsed = new URL(canonicalizeProviderBaseUrl(baseUrl)!);
  } catch {
    throw new Error(`Invalid base URL for ${provider}: ${baseUrl}`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

  // Block cloud metadata endpoints (all providers, including Ollama)
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    throw new Error(`Blocked metadata endpoint for ${provider}: ${hostname}`);
  }

  if (provider === 'ollama') {
    // Ollama: only allow loopback addresses, block all other private ranges
    if (!isLoopback && isPrivateHost(hostname)) {
      throw new Error(`Private/internal URL not allowed for ${provider}: ${hostname} (only loopback addresses are allowed: localhost, 127.0.0.1, ::1)`);
    }
  } else {
    // All other providers: block all private/internal addresses
    if (isPrivateHost(hostname)) {
      throw new Error(`Private/internal URL not allowed for ${provider}: ${hostname}`);
    }
  }

  // Credentials and prompt content must never cross a plaintext network
  // boundary. Local Ollama is the sole HTTP exception because loopback does
  // not leave the device and is Ollama's standard transport. Run this after
  // internal-address checks so callers retain the more specific SSRF error.
  if (parsed.protocol !== 'https:' && !(provider === 'ollama' && isLoopback)) {
    throw new Error(`HTTPS is required for non-loopback ${provider} endpoints`);
  }

}

/**
 * Extended validation that also resolves DNS to catch rebinding attacks
 * (e.g. 127.0.0.1.nip.io resolving to a private IP). Use at save time.
 */
export async function validateBaseUrlWithDns(
  baseUrl: string,
  provider: string,
  lookup: DnsLookup = dnsLookup,
): Promise<void> {
  // Run all synchronous checks first
  validateBaseUrl(baseUrl, provider);

  const hostname = normalizeHostname(new URL(baseUrl).hostname);

  // Literal IPs were completely validated above. Hostnames, including
  // localhost, must resolve now so a modified hosts file cannot turn a local
  // endpoint into an external one.
  if (isIP(hostname) !== 0) {
    return;
  }

  let results;
  try {
    results = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(
      `DNS lookup failed for ${provider} endpoint ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (results.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${provider} endpoint ${hostname}`);
  }
  for (const { address } of results) {
    assertResolvedAddressAllowed(address, hostname, provider);
  }
}

export interface SafeProviderFetch {
  response: Response;
  close: () => Promise<void>;
}

/**
 * Fetch a user-configured provider URL through a dispatcher whose DNS lookup is
 * pinned to the exact addresses validated immediately before the connection.
 * Redirects are disabled because every redirect target would otherwise need a
 * fresh validation-and-pin cycle.
 *
 * The caller must invoke `close()` after consuming the response body. Provider
 * adapters do so in `finally` blocks, including streaming responses.
 */
export async function fetchCustomProviderUrl(
  url: string,
  provider: string,
  init: RequestInit,
  lookup: DnsLookup = dnsLookup,
): Promise<SafeProviderFetch> {
  validateBaseUrl(url, provider);
  const parsed = new URL(url);
  const hostname = normalizeHostname(parsed.hostname);
  const family = isIP(hostname);
  let addresses: Array<{ address: string; family: number }>;

  if (family !== 0) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = await lookupWithAbort(hostname, lookup, init.signal);
    } catch (error) {
      if (init.signal?.aborted) throw signalAbortReason(init.signal);
      throw new Error(
        `DNS lookup failed for ${provider} endpoint ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${provider} endpoint ${hostname}`);
  }
  for (const { address } of addresses) {
    assertResolvedAddressAllowed(address, hostname, provider);
  }

  const pinnedLookup: LookupFunction = (_requestedHostname, options, callback) => {
    const requestedFamily = typeof options.family === 'number' ? options.family : 0;
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    if (eligible.length === 0) {
      const error = new Error(`No validated address matches requested family ${requestedFamily}`);
      Object.assign(error, { code: 'ENOTFOUND' });
      callback(error as NodeJS.ErrnoException, '', 0);
      return;
    }
    if (options.all) {
      callback(null, eligible);
      return;
    }
    const selected = eligible[0]!;
    callback(null, selected.address, selected.family);
  };
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await dispatcher.close();
  };

  try {
    const requestInit = {
      ...init,
      redirect: 'manual',
      dispatcher,
    };
    // Node's native fetch accepts an Undici dispatcher at runtime, but the
    // DOM RequestInit declaration does not expose that extension. Keep the
    // assertion at this one transport boundary; the dispatcher itself remains
    // the pinned Agent constructed above.
    const response = await fetch(url, requestInit as unknown as RequestInit);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      await close();
      throw new Error(`Redirects are not allowed for custom ${provider} endpoints`);
    }
    return { response, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Normalize a hostname for safe matching:
 * - lowercase
 * - strip surrounding [] (URL parser leaves brackets on IPv6)
 * - strip trailing dot (DNS root marker — `localhost.` should match `localhost`)
 * - strip IPv6 zone id (`fe80::1%eth0` → `fe80::1`)
 *
 * Bypasses we are guarding against:
 * - `LOCALHOST` (case): caught by lowercase
 * - `localhost.` (trailing dot): caught by dot strip
 * - `[fe80::1%eth0]` (IPv6 link-local with zone): caught by zone strip + bracket strip
 */
export function normalizeHostname(raw: string): string {
  let h = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.endsWith('.')) h = h.slice(0, -1);
  const zoneIdx = h.indexOf('%');
  if (zoneIdx >= 0) h = h.slice(0, zoneIdx);
  return h;
}

function assertResolvedAddressAllowed(address: string, hostname: string, provider: string): void {
  if (provider === 'ollama' && isLoopbackHostname(hostname)) {
    if (address === '127.0.0.1' || address === '::1') return;
    throw new Error(
      `DNS for local ${provider} endpoint ${hostname} must resolve only to a loopback address`,
    );
  }
  if (!isPrivateHost(address)) return;
  throw new Error(`DNS for ${hostname} resolves to private address ${address}, not allowed for ${provider}`);
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (isIP(hostname) === 0) return false;
  try {
    // ipaddr.js tracks IPv4/IPv6 special-purpose registries, including
    // benchmark, documentation, NAT64 local-use, ORCHID, site-local,
    // multicast, mapped, and reserved space. A custom provider may receive
    // credentials and prompt content, so only ordinary global unicast is
    // eligible; the explicit Ollama loopback exception is handled by callers.
    return ipaddr.parse(hostname).range() !== 'unicast';
  } catch {
    // A value Node classified as an IP but the stricter parser cannot consume
    // is not a safe network destination.
    return true;
  }
}
