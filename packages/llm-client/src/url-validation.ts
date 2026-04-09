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

  // URL parser keeps brackets around IPv6: [::1] → strip them for matching
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Block cloud metadata endpoints (all providers, including Ollama)
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    throw new Error(`Blocked metadata endpoint for ${provider}: ${hostname}`);
  }

  if (provider === 'ollama') {
    // Ollama: only allow loopback addresses, block all other private ranges
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLoopback && isPrivateHost(hostname)) {
      throw new Error(`Private/internal URL not allowed for ${provider}: ${hostname} (only localhost is allowed)`);
    }
  } else {
    // All other providers: block all private/internal addresses
    if (isPrivateHost(hostname)) {
      throw new Error(`Private/internal URL not allowed for ${provider}: ${hostname}`);
    }
  }

}

/**
 * Extended validation that also resolves DNS to catch rebinding attacks
 * (e.g. 127.0.0.1.nip.io resolving to a private IP). Use at save time.
 */
export async function validateBaseUrlWithDns(baseUrl: string, provider: string): Promise<void> {
  // Run all synchronous checks first
  validateBaseUrl(baseUrl, provider);

  const { lookup } = await import('node:dns/promises');
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Skip literal IPs and localhost — already validated above
  if (hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    return;
  }

  try {
    const { address } = await lookup(hostname);
    if (isPrivateHost(address)) {
      if (provider === 'ollama') {
        const isLoopback = address === '127.0.0.1' || address === '::1';
        if (!isLoopback) {
          throw new Error(`DNS for ${hostname} resolves to private address ${address}, not allowed for ${provider}`);
        }
      } else {
        throw new Error(`DNS for ${hostname} resolves to private address ${address}, not allowed for ${provider}`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('not allowed')) throw err;
    // DNS resolution failure — allow through (may be unresolvable at save time)
  }
}

function isPrivateHost(hostname: string): boolean {
  // Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // 0.0.0.0 binds to all interfaces on many systems
  if (hostname === '0.0.0.0') {
    return true;
  }

  // Try to parse as IPv4. Only accept strict decimal dotted-quad to reject
  // octal (0177.0.0.1) and hex (0x7f000001) encodings that bypass checks.
  const parts = hostname.split('.');
  if (parts.length === 4) {
    const nums = parts.map((p) => {
      // Reject octal (leading zero) and hex (0x) notation
      if (/^0[0-9]/.test(p) || /^0x/i.test(p)) return NaN;
      return Number(p);
    });
    if (nums.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
      // 10.0.0.0/8
      if (nums[0] === 10) return true;
      // 172.16.0.0/12
      if (nums[0] === 172 && nums[1]! >= 16 && nums[1]! <= 31) return true;
      // 192.168.0.0/16
      if (nums[0] === 192 && nums[1] === 168) return true;
      // 169.254.0.0/16 (link-local)
      if (nums[0] === 169 && nums[1] === 254) return true;
      // 127.0.0.0/8 (loopback)
      if (nums[0] === 127) return true;
      // 0.0.0.0/8
      if (nums[0] === 0) return true;
    }
  }

  // IPv6 private ranges (stripped brackets by URL parser)
  // ::1 handled above; also catch IPv6-mapped IPv4
  if (hostname.startsWith('::ffff:')) {
    const mapped = hostname.slice(7); // strip ::ffff:
    return isPrivateHost(mapped);
  }

  // IPv6 unique local addresses (fc00::/7 → fc.. and fd..)
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) {
    if (/^f[cd][0-9a-f]{0,2}:/.test(hostname)) return true;
  }

  // IPv6 link-local (fe80::/10)
  if (/^fe[89ab][0-9a-f]?:/.test(hostname)) return true;

  return false;
}
