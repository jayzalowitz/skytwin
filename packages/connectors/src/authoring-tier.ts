/**
 * Authoring-tier classification for inbound signals (#251 Layer 1).
 *
 * Every email signal is labelled with an `AuthoringTier` at write time so the
 * downstream memory layer (`brain_pages.metadata.authoringTier`) carries a
 * stable hint about whether the user authored the content or merely received
 * it. Layer 2 (retrieval weighting) reads this metadata; Layer 1 only writes
 * it. The classifier is intentionally side-effect-free so it can be unit-tested
 * without spinning up a connector.
 *
 * The vocabulary is email-shaped but the field name (`authoringTier`) is
 * deliberately channel-agnostic — when Slack/Notion/etc. connectors land they
 * can extend `AuthoringTier` with `authored_originated` / `received_personal`
 * / etc. without rebuilding the memory schema.
 */

export type AuthoringTier =
  | 'user_sent_originated'
  | 'user_sent_reply'
  | 'inbox_personal'
  | 'inbox_broadcast'
  | 'inbox_newsletter'
  | 'inbox_automated';

export interface EmailAuthoringInputs {
  /** Gmail labelIds on the message (e.g. `SENT`, `INBOX`, `CATEGORY_PROMOTIONS`). */
  labels: string[];
  /** Raw `From:` value (display name + address). */
  fromAddress: string;
  /** Bare addresses extracted from the `To:` header. */
  toAddresses: string[];
  /** Bare addresses extracted from the `Cc:` header. */
  ccAddresses: string[];
  /** True when an `In-Reply-To:` header is present (i.e. this is a reply, not a fresh thread). */
  hasInReplyTo: boolean;
  /** True when a `List-Unsubscribe:` header is present. */
  hasListUnsubscribe: boolean;
  /** Parsed `List-Id:` value (e.g. `rangers.lists.example.org`) or `''`. */
  listId: string;
}

/**
 * Local parts that almost always indicate an automated/transactional sender.
 * Matches exactly OR `<part>+...` (Gmail subaddressing) OR `<part>.<digits>...`
 * (e.g. `notifications.123` for thread-specific reply-tos). Deliberately
 * conservative — `support@`, `hello@`, `team@` are not included because they
 * are often staffed by humans.
 */
const AUTOMATED_LOCAL_PARTS = new Set<string>([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
  'alerts',
  'alert',
  'mailer-daemon',
  'postmaster',
  'auto-confirm',
  'automated',
  'auto-reply',
  'autoreply',
]);

/**
 * Known transactional sender-domain patterns. These are domains that
 * structurally do not host humans — only system-generated mail. Anchored to
 * the end of the host so subdomains of legitimate human mail providers don't
 * false-match.
 */
const AUTOMATED_DOMAIN_PATTERNS: RegExp[] = [
  /(^|\.)mailchimp\.com$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)mandrillapp\.com$/i,
  /(^|\.)amazonses\.com$/i,
  /(^|\.)sparkpostmail\.com$/i,
  /(^|\.)mailgun\.org$/i,
  // GitHub notifications: from `notifications@github.com`, but the local-part
  // match already catches that. The subdomain `noreply.` catch covers the
  // long tail of `noreply.<vendor>.com` aliases used by SaaS apps.
  /(^|\.)noreply\./i,
];

/**
 * Strip display name and angle brackets from an RFC 5322 address. Falls back
 * to the raw input if no angle-bracketed address is present. Lowercased.
 *
 * `"Acme <noreply@acme.com>"` → `noreply@acme.com`
 * `noreply@acme.com`          → `noreply@acme.com`
 * `""`                         → `""`
 */
export function extractBareAddress(raw: string): string {
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  return raw.trim().toLowerCase();
}

/**
 * Split an address-list header value (`To:`, `Cc:`) into bare addresses.
 * RFC 5322 allows commas inside quoted display names, but the headers we
 * care about here come from Gmail's API which serializes them cleanly. A
 * simple comma-split with bare-address extraction is good enough for tier
 * classification — false positives just push us toward `inbox_broadcast`,
 * which is the safer side.
 */
export function splitAddressList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => extractBareAddress(part))
    .filter((s) => s.length > 0);
}

/**
 * Return true if the address looks automated (no-reply / mailer / vendor
 * sending infrastructure). The classifier uses this only when the message is
 * NOT in `SENT` and is NOT already classified as newsletter/list mail —
 * automated senders that ALSO ship `List-Unsubscribe` (typical) are caught
 * by the earlier newsletter branch.
 */
export function isAutomatedSender(rawFrom: string): boolean {
  const addr = extractBareAddress(rawFrom);
  if (!addr) return false;
  const at = addr.indexOf('@');
  if (at === -1) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);

  // Exact-match local-part hits (the common case: `noreply@acme.com`).
  if (AUTOMATED_LOCAL_PARTS.has(local)) return true;
  // Gmail subaddressing variant: `noreply+thread-id@acme.com`.
  const plus = local.indexOf('+');
  if (plus > 0 && AUTOMATED_LOCAL_PARTS.has(local.slice(0, plus))) return true;
  // Dot-delimited variant: `notifications.42@github.com`.
  const dot = local.indexOf('.');
  if (dot > 0 && AUTOMATED_LOCAL_PARTS.has(local.slice(0, dot))) return true;

  return AUTOMATED_DOMAIN_PATTERNS.some((re) => re.test(domain));
}

/**
 * Classify an email signal into one of the six authoring tiers.
 *
 * Order of checks is significant:
 *
 *   1. `SENT` label dominates everything — anything the user typed is in the
 *      top two tiers regardless of who it was to or what it looked like.
 *      Reply vs. fresh thread is decided by `In-Reply-To`.
 *   2. Newsletter / list mail beats everything else in inbox — list senders
 *      that happen to look automated should still be labelled `newsletter`
 *      (the user can subscribe to genuinely valuable lists; `automated` is
 *      reserved for transactional / system mail with no list semantics).
 *   3. Automated / transactional comes next so receipts and notifications
 *      don't slip into `personal` just because they don't have a List-Id.
 *   4. Broadcast: multi-recipient mail the user is one of several recipients
 *      on. Threshold is `> 1` total addressees across To+Cc.
 *   5. Default: one-to-one human mail.
 */
export function classifyEmailAuthoringTier(input: EmailAuthoringInputs): AuthoringTier {
  const labelSet = new Set(input.labels);

  if (labelSet.has('SENT')) {
    return input.hasInReplyTo ? 'user_sent_reply' : 'user_sent_originated';
  }

  if (
    input.hasListUnsubscribe ||
    input.listId.length > 0 ||
    labelSet.has('CATEGORY_PROMOTIONS')
  ) {
    return 'inbox_newsletter';
  }

  if (isAutomatedSender(input.fromAddress)) {
    return 'inbox_automated';
  }

  if (input.toAddresses.length + input.ccAddresses.length > 1) {
    return 'inbox_broadcast';
  }

  return 'inbox_personal';
}
