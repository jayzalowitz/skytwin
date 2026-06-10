/**
 * Power-view detail view-model (#spec 14).
 *
 * One digest, two depths: the clean view (spec 01/08) is default; power users
 * expand a row to see the technical depth SkyTwin already computed — provenance,
 * confidence, why-this-urgency, the real source refs, and (for to-dos) why it
 * did NOT auto-execute. This is the single place raw codes become human strings,
 * so the UI stays dumb. Pure + testable.
 */

import type { ActionProvenance } from '@skytwin/shared-types';

export interface DigestItemDetailInput {
  provenance?: ActionProvenance;
  /** 0..1 */
  confidence?: number;
  deadlinePhrase?: string | null;
  domain?: string | null;
  sourceRefs: string[];
  requiresApproval?: boolean;
  /** Machine block codes, e.g. 'missing_write_scope:gmail.send', 'trust_tier:observer'. */
  blockedReasons?: string[];
  explanation?: string | null;
  /**
   * Explicit "why this urgency" string. When provided it overrides the
   * computed default (deadline phrase / "Default for <domain>"), so callers
   * that know the real urgency driver (a security alert, an RSVP, a stated
   * deadline) can surface it instead of a generic placeholder.
   */
  urgencyReason?: string;
  /**
   * The action the twin recommends — the user's actual next step ("Accept
   * this calendar invitation", "Review the sign-in in your account settings").
   * Actionable, not a system label.
   */
  suggestedAction?: string;
  /** When the underlying signal arrived (ISO string), for a "when" line. */
  occurredAt?: string;
}

export interface DigestItemDetail {
  provenanceLabel: string;
  confidencePct: number | null;
  urgencyReason: string;
  sourceRefs: string[];
  whyNotAutoExecuted: string[];
  explanation: string | null;
  /** The twin's recommended next step (actionable), if known. */
  suggestedAction: string | null;
  /** When the underlying signal arrived (ISO string), if known. */
  occurredAt: string | null;
}

// Provenance → plain-English label a non-technical person understands. The
// fail-safe still resolves to "someone else" (never imply you wrote something
// we can't prove you did), but without the alarming "untrusted" wording — the
// caution lives in the "why I'm asking you" line, not a scary origin label.
const PROVENANCE_LABELS: Record<string, string> = {
  user_originated: 'From you',
  trusted_context: 'From your assistant',
  untrusted_external: 'From someone else',
};

export function provenanceLabel(p: ActionProvenance | undefined): string {
  return (p && PROVENANCE_LABELS[p]) || 'From someone else';
}

/** Map a single machine block code to a human reason. */
function humanizeBlockReason(code: string): string {
  const [kind] = code.split(':');
  switch (kind) {
    case 'missing_write_scope':
      return "I don't have permission to do this for you yet";
    case 'trust_tier':
      return "You've asked me to check with you before I act";
    case 'policy':
      return 'A safety rule is holding this for review';
    case 'untrusted_origin':
      return 'It came from someone else, so I want your OK first';
    case 'spend_limit':
      return 'It would cost more than your limit';
    default:
      return code;
  }
}

export function buildDigestItemDetail(input: DigestItemDetailInput): DigestItemDetail {
  const confidencePct =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.round(Math.max(0, Math.min(1, input.confidence)) * 100)
      : null;

  const urgencyReason =
    input.urgencyReason?.trim() ||
    (input.deadlinePhrase
      ? `Deadline: "${input.deadlinePhrase}"`
      : `Default for ${input.domain ?? 'this kind of item'}`);

  const whyNotAutoExecuted =
    input.requiresApproval && input.blockedReasons && input.blockedReasons.length > 0
      ? input.blockedReasons.map(humanizeBlockReason)
      : input.requiresApproval
        ? ['Set aside for your review']
        : [];

  return {
    provenanceLabel: provenanceLabel(input.provenance),
    confidencePct,
    urgencyReason,
    sourceRefs: input.sourceRefs,
    whyNotAutoExecuted,
    explanation: input.explanation ?? null,
    suggestedAction: input.suggestedAction?.trim() || null,
    occurredAt: input.occurredAt ?? null,
  };
}
