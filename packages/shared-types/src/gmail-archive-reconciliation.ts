import type { GmailArchiveAttemptPhase } from './gmail-inbox-mutation.js';
import type {
  GmailInboxObservationBinding,
  GmailInboxObservationUnavailableCode,
} from './gmail-inbox-observation.js';

/**
 * A recovery-only command. It is intentionally incompatible with both the
 * Gmail mutation command and the mailbox observation command so this boundary
 * cannot dispatch or observe provider resources.
 */
export interface GmailArchiveReconciliationCommand {
  userId: string;
  admissionId: string;
  messageRefId: string;
  operation: 'reconcile_archive';
}

/** Durable evidence that the abandoned attempt never reached dispatch. */
export interface GmailArchiveInterruptedBeforeDispatchEvidence {
  kind: 'interrupted_before_dispatch';
}

/**
 * A factual mailbox state accepted after a complete, bounded observation.
 * This state does not attribute the state to the abandoned archive attempt.
 */
export interface GmailArchiveMailboxObservedEvidence {
  kind: 'mailbox_observed';
  binding: Readonly<GmailInboxObservationBinding>;
  inbox: boolean;
  observedAt: string;
}

/** A safe reason that a mailbox state could not be accepted. */
export interface GmailArchiveMailboxObservationUnavailableEvidence {
  kind: 'mailbox_observation_unavailable';
  binding: Readonly<GmailInboxObservationBinding>;
  code: GmailInboxObservationUnavailableCode;
}

/**
 * Evidence accepted by the DB-only reconciliation terminalizer. Provider
 * identifiers, credentials, response bodies, and mutation claims are absent.
 */
export type GmailArchiveReconciliationEvidence =
  | GmailArchiveInterruptedBeforeDispatchEvidence
  | GmailArchiveMailboxObservedEvidence
  | GmailArchiveMailboxObservationUnavailableEvidence;

/**
 * The exact recovery snapshot that may be reconciled. `phaseChangedAt` is the
 * DB timestamp at which the durable attempt entered `phase`.
 */
export interface ReconcileAbandonedGmailArchiveInput {
  command: GmailArchiveReconciliationCommand;
  phase: GmailArchiveAttemptPhase;
  phaseChangedAt: string;
  evidence: GmailArchiveReconciliationEvidence;
}
