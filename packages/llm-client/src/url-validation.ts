/**
 * Validate that a base URL is safe for use with external API providers.
 * Blocks private/internal IP ranges to prevent SSRF attacks.
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

  const hostname = parsed.hostname.toLowerCase();

  // Block cloud metadata endpoints
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    throw new Error(`Blocked metadata endpoint for ${provider}: ${hostname}`);
  }

  // Block private IP ranges (RFC 1918, loopback, link-local)
  // Exception: localhost/127.0.0.1 is allowed for Ollama
  if (provider !== 'ollama') {
    if (isPrivateHost(hostname)) {
      throw new Error(`Private/internal URL not allowed for ${provider}: ${hostname}`);
    }
  } else {
    // Even Ollama blocks cloud metadata and non-loopback private ranges
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      throw new Error(`Blocked metadata endpoint for ${provider}: ${hostname}`);
    }
  }
}

function isPrivateHost(hostname: string): boolean {
  // Loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  // Try to parse as IP
  const parts = hostname.split('.').map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
  }

  return false;
}
