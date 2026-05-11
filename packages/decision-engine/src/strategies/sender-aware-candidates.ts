import type {
  DecisionObject,
  DecisionContext,
  CandidateAction,
  TwinProfile,
} from '@skytwin/shared-types';
import { ConfidenceLevel, SituationType } from '@skytwin/shared-types';
import type { CandidateGenerator } from './candidate-strategy.js';
import type { DecisionMaker } from '../decision-maker.js';

/**
 * Default protected-sender pattern. Anything matching this regex is considered
 * relationship-sensitive — board, investor, legal, finance leadership, key
 * customers, etc. Auto-archive / auto-reply are blocked for these senders;
 * the candidate set surfaces a `flag_for_manual_review` instead.
 *
 * Tuned to match real corporate email surface area without being so broad it
 * fires on every internal sender. If a user wants tighter or looser matching
 * they pass `protectedPattern` to the constructor.
 */
const DEFAULT_PROTECTED_PATTERN =
  /\b(?:board|chair|cfo|coo|cmo|ceo|founder|partner|investor|legal|counsel|attorney|sec|audit|compliance|tax)\b/i;

/**
 * Subjects whose presence in the email body or summary suggests the message
 * carries enough weight that auto-archive should never apply, regardless of
 * sender — e.g. anything mentioning "term sheet" or "wire transfer".
 */
const DEFAULT_PROTECTED_SUBJECT_PATTERN =
  /\b(?:term\s*sheet|wire\s*transfer|signed|nda|equity|cap\s*table|board\s*deck|earnings|payroll)\b/i;

/**
 * SenderAwareCandidateGenerator wraps the rule-based candidate set with a
 * pre-pass that inspects the inbound signal's sender and subject. When the
 * message is from (or about) a protected sender / topic it injects an
 * irreversible `flag_for_manual_review` candidate at maximum confidence —
 * which is what the policy engine routes through the approval queue.
 *
 * **What this fixes:** the rule-based EMAIL_TRIAGE generator produces
 * `(archive_email, label_email, [send_reply])` for *every* email regardless
 * of who sent it. At MODERATE_AUTONOMY+ that means board emails get
 * auto-archived alongside newsletters. The fake-user E2E
 * (apps/api/src/__tests__/fake-user-e2e.test.ts) demonstrates the gap.
 *
 * **Composition:** this generator delegates to the underlying DecisionMaker's
 * built-in rules for the non-protected case, so behaviour for routine
 * email/calendar/finance signals is unchanged. Only protected senders get
 * the extra candidate.
 *
 * **Production swap:** when an LLM strategy is configured this class steps
 * out of the way (the LLM does its own content-aware reasoning). Use it as
 * the default fallback for users without LLM keys configured — it is the
 * "free" safety improvement over pure rule-based generation.
 */
export class SenderAwareCandidateGenerator implements CandidateGenerator {
  private readonly senderPattern: RegExp;
  private readonly subjectPattern: RegExp;

  constructor(
    private readonly decisionMaker: DecisionMaker,
    options: {
      protectedPattern?: RegExp;
      protectedSubjectPattern?: RegExp;
    } = {},
  ) {
    this.senderPattern = options.protectedPattern ?? DEFAULT_PROTECTED_PATTERN;
    this.subjectPattern = options.protectedSubjectPattern ?? DEFAULT_PROTECTED_SUBJECT_PATTERN;
  }

  async generate(
    decision: DecisionObject,
    profile: TwinProfile,
    _context: DecisionContext,
  ): Promise<CandidateAction[]> {
    // Only intercept email-triage decisions. Calendar / finance / etc. fall
    // through unchanged — those domains have their own irreversibility
    // signals already.
    if (decision.situationType !== SituationType.EMAIL_TRIAGE) {
      return this.decisionMaker.generateCandidates(decision, profile);
    }

    const { isProtected, why } = this.classifySender(decision);
    const baseCandidates = this.decisionMaker.generateCandidates(decision, profile);

    if (!isProtected) return baseCandidates;

    // Sender / subject is protected → SUPPRESS the rule-based candidates
    // entirely and emit ONLY a flag_for_manual_review. Returning the
    // rule-based candidates alongside the flag is unsafe because
    // `archive_email` (reversible) scores higher on the DecisionMaker's
    // risk-weighted ranking and would auto-execute at MODERATE_AUTONOMY.
    // The user can never get into a state where the engine selects
    // "auto-archive a board email" because the candidate set doesn't
    // include archive at all.
    //
    // The built-in policy NO_IRREVERSIBLE_WITHOUT_APPROVAL (priority 95) sees
    // reversible=false on this candidate and routes to `require_approval` —
    // which gates auto-execute at every trust tier. That's the safety floor
    // the user explicitly opted into when they chose MODERATE_AUTONOMY.
    const flag: CandidateAction = {
      id: crypto.randomUUID(),
      decisionId: decision.id,
      actionType: 'flag_for_manual_review',
      description: `Flag this email for manual review (${why}).`,
      domain: 'email',
      parameters: {
        emailId: decision.rawData['emailId'],
        reason: why,
        from: decision.rawData['from'],
        subject: decision.rawData['subject'],
      },
      estimatedCostCents: 0,
      reversible: false,
      confidence: ConfidenceLevel.CONFIRMED,
      reasoning: `Sender or subject matched protected pattern. ${why}`,
    };

    return [flag];
  }

  private classifySender(decision: DecisionObject): { isProtected: boolean; why: string } {
    const data = decision.rawData ?? {};
    const from = String(data['from'] ?? '').toLowerCase();
    const subject = String(data['subject'] ?? '');
    const text = String(data['text'] ?? '');
    const summary = decision.summary ?? '';

    const senderMatch = from.match(this.senderPattern);
    if (senderMatch) {
      return { isProtected: true, why: `sender contains "${senderMatch[0]}"` };
    }
    const haystack = `${subject} ${text} ${summary}`;
    const subjectMatch = haystack.match(this.subjectPattern);
    if (subjectMatch) {
      return { isProtected: true, why: `content mentions "${subjectMatch[0]}"` };
    }
    return { isProtected: false, why: '' };
  }
}
