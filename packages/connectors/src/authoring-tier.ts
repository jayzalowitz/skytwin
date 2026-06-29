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
  // Non-email authored/received tiers (#251 channel-agnostic extension, spec 07).
  // `authored_originated` = the user created this doc/event/voice note;
  // `received_shared` = someone shared it with the user. These let downstream
  // capabilities (e.g. commitment extraction) treat self-authored non-email
  // content the same as `user_sent_*` mail. Mapped via `isAuthoredByUser` in
  // `@skytwin/decision-engine` (signal-text.ts).
  | 'authored_originated'
  | 'received_shared'
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
 * Matched (via `AUTOMATED_LOCAL_PART_RE`) as a delimited component of the local
 * part: exactly (`noreply@`), Gmail subaddressing (`noreply+thread@`), a
 * dot-delimited id (`notifications.42@`), OR a hyphen/dot-prefixed compound
 * (`google-noreply@`). Deliberately conservative — `support@`, `hello@`,
 * `team@` are not included because they are often staffed by humans.
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
 * Match an `AUTOMATED_LOCAL_PARTS` token that is EITHER the first segment of the
 * local part (`noreply@`, `noreply+id@`, `notifications.42@`, `noreply-team@`)
 * OR the last segment after a hyphen (`google-noreply@`). Built from the set so
 * the vocabulary stays single-sourced; longest-first so a multi-word token
 * (`do-not-reply`) wins over a shorter overlap.
 *
 * Deliberately NOT "token anywhere": a token after a dot (`alex.alert@`,
 * `svc.notifications@`) or mid-string (`real-newsletter-editor@`) reads as a
 * `firstname.role` human or a staffed team, so those stay personal — matching
 * the original first-segment-only intent. The added end-after-hyphen form is the
 * one the start-anchored checks missed, which mis-tiered `google-noreply@` as
 * `inbox_personal` (a human) and produced "draft a reply" to a no-reply address.
 */
const AUTOMATED_LOCAL_TOKENS = [...AUTOMATED_LOCAL_PARTS]
  .sort((a, b) => b.length - a.length)
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const AUTOMATED_LOCAL_PART_RE = new RegExp(
  `^(?:${AUTOMATED_LOCAL_TOKENS})(?:$|[-._+])|-(?:${AUTOMATED_LOCAL_TOKENS})$`,
  'i',
);

/**
 * Known transactional sender-domain patterns. These are domains that
 * structurally do not host humans — only system-generated mail.
 *
 * Most patterns are anchored at BOTH the host-component boundary
 * `(^|\.)` and the end of the host `$` so subdomains of legitimate
 * human mail providers don't false-match. The `noreply\.` pattern is
 * deliberately NOT end-anchored: it matches the `noreply.<anything>`
 * subdomain alias pattern SaaS apps use (e.g. `noreply.github.com`,
 * `noreply.acme.com`). The trade-off is intentional and Copilot
 * called it out on PR #252.
 */
const AUTOMATED_DOMAIN_PATTERNS: RegExp[] = [
  /(^|\.)mailchimp\.com$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)mandrillapp\.com$/i,
  /(^|\.)amazonses\.com$/i,
  /(^|\.)sparkpostmail\.com$/i,
  /(^|\.)mailgun\.org$/i,
  // Subdomain-prefix anchor only: catches the `noreply.<vendor>.com`
  // long tail. Intentional asymmetry with the end-anchored entries
  // above, which target a specific apex domain.
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

  // A known automated token as a delimited component of the local part —
  // covers exact (`noreply@`), subaddressing (`noreply+thread@`), dot-id
  // (`notifications.42@`), and the compound-prefix form (`google-noreply@`)
  // the original start-anchored checks missed.
  if (AUTOMATED_LOCAL_PART_RE.test(local)) return true;

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
