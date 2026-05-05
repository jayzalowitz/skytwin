/**
 * Strip an RFC 5322 `Display Name <addr@host>` to `addr@host`, lowercased.
 *
 * Used by the Gmail connector to normalize sender addresses before writing
 * `email_label_signals` rows, AND by the decision engine to normalize
 * sender addresses before looking up those rows. Both sides MUST agree on
 * the transformation — a divergence means every per-sender label lookup
 * silently misses, so the function lives in `@skytwin/core` and is imported
 * from both ends rather than duplicated. Issue #122 follow-up.
 *
 * Returns `''` for inputs that don't contain an `@`, so callers can skip
 * recording rather than poison the model with garbage keys.
 *
 * Behavioral notes:
 * - `Black Rock Rangers <rangers@example.org>` → `rangers@example.org`
 * - `  Alice@Example.COM  ` → `alice@example.com`
 * - `Name <bad>` → `''` (no `@` in the captured group)
 * - `<>` → `''`
 * - `''` / non-string → `''`
 *
 * Non-goals: full RFC 5322 parsing (no support for quoted local-parts,
 * comments, or group syntax). Real Gmail `From:` headers are well-formed
 * enough in practice that the regex covers them; the goal here is a
 * reproducible canonical form, not RFC compliance.
 */
export function normalizeSenderAddress(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const trimmed = raw.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  const candidate = angle && angle[1] ? angle[1] : trimmed;
  const addr = candidate.trim().toLowerCase();
  return addr.includes('@') ? addr : '';
}
