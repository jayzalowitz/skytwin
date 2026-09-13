const LOCAL_ONLY_SAMPLE_PATHS = [
  '/api/v1/demo/info',
  '/api/v1/demo/session',
  '/api/v1/demo/simulation',
] as const;

const DEMO_TOKEN_PREFIX = 'skytwin-demo-v1';

function isSampleTokenCandidate(token: string | null | undefined): boolean {
  return Boolean(
    token === DEMO_TOKEN_PREFIX || token?.startsWith(`${DEMO_TOKEN_PREFIX}.`),
  );
}

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
  // Express routing is case-insensitive by default. Classify with the same
  // semantics so mixed-case spellings cannot bypass the local-only boundary
  // before the proxy reaches a lower-case registered API route.
  const normalizedPathname = pathname.toLowerCase();
  return LOCAL_ONLY_SAMPLE_PATHS.some(
    (path) =>
      normalizedPathname === path || normalizedPathname.startsWith(`${path}/`),
  );
}

/**
 * Detect the reserved sample principal before proxying any API route. Sample
 * credentials are accepted by the API from either Authorization or `?token=`,
 * so both transports must carry the same local-only boundary here.
 */
export function hasSampleCredential(
  authorization: string | string[] | undefined,
  requestUrl: URL,
): boolean {
  const headers = Array.isArray(authorization)
    ? authorization
    : authorization === undefined
      ? []
      : [authorization];
  return (
    headers.some((header) =>
      isSampleTokenCandidate(
        header.startsWith('Bearer ') ? header.slice(7) : undefined,
      ),
    ) ||
    isSampleTokenCandidate(requestUrl.searchParams.get('token'))
  );
}

export function requiresLocalSampleBoundary(
  pathname: string,
  authorization: string | string[] | undefined,
  requestUrl: URL,
): boolean {
  return (
    isLocalOnlySamplePath(pathname) ||
    hasSampleCredential(authorization, requestUrl)
  );
}
