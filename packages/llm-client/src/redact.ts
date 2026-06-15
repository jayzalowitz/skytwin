/**
 * PII redaction for LLM prompts (#375).
 *
 * The decision pipeline feeds user-derived text into LLM prompts: raw signal
 * data (inbound email headers carry the sender + recipient addresses) and
 * episodic-memory summaries (which can quote addresses from prior signals).
 * When the active provider is a cloud one (Anthropic / OpenAI / Google), that
 * text — including third parties' contact addresses — leaves the machine. This
 * masks email addresses before the text is assembled into a prompt.
 *
 * Scope is deliberately narrow — email addresses only — because that is the
 * high-precision, zero-false-positive win that directly closes #375's stated
 * concern ("email senders"), and masking them costs the decision path nothing:
 * an action's actual recipient is resolved from the structured signal record,
 * never by parsing an address out of the prompt, so the model only loses an
 * identifier it didn't need to reason about the CONTENT.
 *
 * Deliberately NOT redacted here (each would do more harm than good at this
 * precision, tracked as follow-ups):
 *   - Phone / account / card numbers — a digit-run matcher also eats ISO dates
 *     (`2026-06-15`), timestamps, and IDs, and dates are reasoning-critical for
 *     the decision path (deadlines). Needs date-aware exclusions before it's
 *     safe to enable.
 *   - Names — needs NER + a reversible token map + response rehydration (the
 *     model's reply would echo the tokens). A larger, separate piece of work.
 *
 * Pure and idempotent: the `[redacted:email]` placeholder contains no `@`, so
 * re-running redaction over already-redacted text is a no-op.
 */

// user@host.tld — the local part allows the usual RFC-ish symbols; the domain
// requires at least one dot + a 2+ char TLD so we don't match a bare `a@b`.
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

/**
 * Mask email addresses in `text`. Returns the input unchanged when it's
 * empty/nullish. Safe to call more than once (idempotent).
 */
export function redactPromptPii(text: string): string {
  if (!text) return text;
  return text.replace(EMAIL_RE, '[redacted:email]');
}
