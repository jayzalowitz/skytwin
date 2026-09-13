const LOCAL_ONLY_SAMPLE_PATHS = [
  '/api/v1/demo/info',
  '/api/v1/demo/session',
  '/api/v1/demo/simulation',
] as const;

export function isLoopbackPeer(address: string | undefined): boolean {
  const normalized = address?.split('%')[0]?.toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === '::ffff:7f00:1'
    || normalized === '0:0:0:0:0:ffff:7f00:1';
}

/**
 * Sample credentials must never be forwarded to an operator-configured remote
 * API. Require a plain HTTP loopback origin with no embedded credentials,
 * path, query, or fragment before the proxy handles a local-only sample path.
 */
export function isLoopbackApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.username === '' &&
      url.password === '' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]') &&
      (url.pathname === '/' || url.pathname === '') &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export function isLocalOnlySamplePath(pathname: string): boolean {
  return LOCAL_ONLY_SAMPLE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
