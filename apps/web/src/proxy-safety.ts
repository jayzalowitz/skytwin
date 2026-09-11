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

export function isLocalOnlySamplePath(pathname: string): boolean {
  return LOCAL_ONLY_SAMPLE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
