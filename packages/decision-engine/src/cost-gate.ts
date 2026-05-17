/**
 * Cost-gate port for the draft-email candidate generator (#299).
 *
 * The decision-engine layer doesn't depend on `@skytwin/db` or
 * `@skytwin/llm-client` directly. The cost gate is therefore expressed
 * as a port — apps/api wires the DB-backed implementation (see
 * `apps/api/src/cost-gate.ts`). Keeps the engine layer testable in
 * isolation and prevents downward-dependency creep.
 *
 * Two-phase contract:
 *   1. `check()` runs BEFORE the LLM call. The gate either green-lights
 *      the call ({allowed: true}) or short-circuits with a reason
 *      ({allowed: false, reason}). The candidate generator returns an
 *      empty candidate list on red light — never throws on a gate
 *      decision; the gate is a normal control-flow path, not an error.
 *   2. `record()` runs AFTER the LLM call (whether it succeeded or
 *      failed). Updates the gate's internal counters so the next
 *      check() reflects this call.
 */
export interface CostGateDecision {
  allowed: boolean;
  reason: string;
  /**
   * Opaque reservation handle. The gate impl uses this to find the
   * row it pre-reserved during check() and update it in record() —
   * the call ledger's `provider` column gets the actual provider the
   * LlmClient ended up using (which can fall through past the
   * gate's estimate when an earlier provider trips its circuit
   * breaker), and `succeeded` reflects the real outcome. Callers
   * MUST pass this back to record() so the gate can finalize the
   * reservation. Undefined when `allowed` is false (no reservation
   * was made).
   */
  reservation?: CostGateReservation;
}

export interface CostGateReservation {
  /** Ledger row id from the gate's atomic reserve step. */
  callRecordId: string;
}

export interface CostGatePort {
  check(input: {
    userId: string;
    decisionId: string;
    estimatedCostCents: number;
  }): Promise<CostGateDecision>;

  record(input: {
    userId: string;
    decisionId: string;
    estimatedCostCents: number;
    /**
     * Actual provider the LlmClient routed to (from
     * `LlmResponse.provider`). May differ from the gate's pre-call
     * estimate when an earlier provider in the chain failed and the
     * client fell through. The gate uses this to (a) write the real
     * provider to the call ledger and (b) reconcile the spend
     * reservation — embedded/Ollama gets reconciled to 0 cents.
     */
    provider: string;
    succeeded: boolean;
    /** Pass back the reservation handle from check(). */
    reservation?: CostGateReservation;
  }): Promise<void>;
}

/**
 * Pure-function trivial-signal classifier (sub-gate, no IO).
 *
 * The connector-side classifier (gmail-connector.ts `inferEmailType`)
 * already sets `requiresResponse: false` for most noreply / newsletter
 * traffic. This belt-and-braces filter catches misclassifications that
 * still arrive with `requiresResponse: true` so an LLM call isn't
 * spent on:
 *
 *   - mailer-daemon / postmaster bounces (real address shape, but no
 *     human reading replies)
 *   - donotreply / no-reply senders that slipped past the connector
 *     (some senders use unusual punctuation: `Do_Not_Reply`,
 *     `NO.REPLY`, etc. — our regex stays loose so it doesn't grow a
 *     bug surface trying to catch every variant)
 *   - Out-of-office auto-replies (subject "Out of office", "Auto:
 *     Out of office", "Automatic reply: ...")
 *   - Unsubscribe / opt-out confirmations ("Unsubscribe confirmed")
 *
 * Returns true when the inbound looks trivial; the generator skips
 * draft generation and returns an empty candidate list.
 */
export function isTrivialAutoEmail(args: {
  from: string;
  subject: string;
}): boolean {
  const lowerFrom = (args.from ?? '').toLowerCase();
  const lowerSubject = (args.subject ?? '').toLowerCase();

  // Sender heuristics
  if (lowerFrom.includes('noreply')) return true;
  if (lowerFrom.includes('no-reply')) return true;
  if (lowerFrom.includes('no.reply')) return true;
  if (lowerFrom.includes('donotreply')) return true;
  if (lowerFrom.includes('do-not-reply')) return true;
  if (lowerFrom.includes('do_not_reply')) return true;
  if (lowerFrom.includes('mailer-daemon')) return true;
  if (lowerFrom.includes('postmaster@')) return true;

  // Subject heuristics — auto-reply / OOO. Allow the "out of office"
  // phrase to be written with spaces, dashes, or underscores between
  // tokens ("Out-of-office", "out_of_office") since email clients and
  // mail servers normalize the separator inconsistently.
  if (/out[\s_-]*of[\s_-]*office/.test(lowerSubject)) return true;
  if (/auto[\s_-]?reply/.test(lowerSubject)) return true;
  if (/automatic\s+reply/.test(lowerSubject)) return true;
  if (/auto[\s_-]?responder/.test(lowerSubject)) return true;

  // Subject heuristics — unsubscribe / opt-out confirmations. The
  // "you've / you have" alternation handles the contraction form
  // (no space before "'ve") and the expanded form (space + "have").
  if (/unsubscribe\s+(?:confirmed|successful|complete)/.test(lowerSubject)) return true;
  if (/you(?:'ve| have) been unsubscribed/.test(lowerSubject)) return true;

  return false;
}
