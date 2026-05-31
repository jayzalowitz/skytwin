/**
 * Deep-link parser for the `skytwin://` URL scheme (#387 P2.7).
 *
 * Approval push notifications carry a deep link so a tap opens the
 * *specific* approval instead of dumping the user on the Approvals tab
 * root to scroll for it. The parsing is pure + exhaustive so it can be
 * unit-tested without React Navigation, Expo Linking, or a device — the
 * App shell just maps the returned `DeepLinkTarget` onto its tab state.
 *
 * Supported links (v1):
 *   skytwin://approvals            → { route: 'approvals' }
 *   skytwin://approvals/<id>       → { route: 'approval-detail', id: '<id>' }
 *
 * Anything else — wrong scheme, unknown host, empty id — returns null so
 * the caller can ignore it rather than navigate somewhere surprising.
 */

export type DeepLinkTarget =
  | { route: 'approvals' }
  | { route: 'approval-detail'; id: string };

const SCHEME = 'skytwin://';

/**
 * Parse a `skytwin://` URL into a navigation target, or null if the URL
 * isn't a recognised SkyTwin deep link.
 *
 * Hand-rolled rather than using the URL/Linking parsers because RN's
 * `URL` polyfill historically mishandled custom schemes (treating the
 * host as part of the path), and we want one deterministic source of
 * truth that the tests pin exactly.
 */
export function parseSkytwinUrl(raw: unknown): DeepLinkTarget | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(SCHEME)) return null;

  // Strip the scheme, any query string / fragment, and surrounding
  // slashes, then split into path segments.
  const afterScheme = trimmed.slice(SCHEME.length);
  const withoutQuery = afterScheme.split(/[?#]/)[0] ?? '';
  const segments = withoutQuery
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) return null;

  const [host, ...rest] = segments;
  if (host !== 'approvals') return null;

  if (rest.length === 0) {
    return { route: 'approvals' };
  }

  // Only `skytwin://approvals/<id>` is valid — extra path segments
  // (`skytwin://approvals/<id>/extra`) are malformed and must NOT be
  // silently treated as an approval-detail link. Reject rather than
  // navigate somewhere the URL didn't actually ask for.
  if (rest.length > 1) return null;

  // Decode the id (it may be URL-encoded); reject an empty /
  // whitespace-only decode.
  let id: string;
  try {
    id = decodeURIComponent(rest[0]!);
  } catch {
    // Malformed percent-encoding — treat as no id.
    return null;
  }
  if (id.trim().length === 0) return null;

  return { route: 'approval-detail', id };
}

/**
 * Build a deep link for an approval id. Used when scheduling a push so
 * the notification payload and the parser agree on the exact shape.
 */
export function approvalDeepLink(id: string): string {
  return `${SCHEME}approvals/${encodeURIComponent(id)}`;
}

/**
 * Pull a deep-link target out of a notification's `data` payload (#387).
 *
 * Prefers the explicit `url` deep link (so the same parser governs taps
 * and any future cold-start `Linking.getInitialURL()` path), then falls
 * back to a bare `approvalId` for payloads that only carry the id.
 * Returns null when the payload has neither — the caller leaves the user
 * on whatever screen they were on.
 *
 * Pure given the `data` object (no Expo / RN imports), so it lives here
 * with the parser and is unit-testable without a real notification.
 */
export function deepLinkFromNotificationData(data: unknown): DeepLinkTarget | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;

  const url = record['url'];
  if (typeof url === 'string') {
    const target = parseSkytwinUrl(url);
    if (target) return target;
  }

  const approvalId = record['approvalId'];
  if (typeof approvalId === 'string' && approvalId.trim().length > 0) {
    return { route: 'approval-detail', id: approvalId };
  }

  return null;
}
