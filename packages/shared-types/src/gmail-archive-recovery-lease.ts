import type { GmailArchiveAttemptPhase } from './gmail-inbox-mutation.js';
import type {
  GmailInboxObservationBinding,
  GmailInboxObservationUnavailableCode,
} from './gmail-inbox-observation.js';

export type GmailArchiveRecoveryWorkKind =
  | 'resume_preparation'
  | 'resume_claim'
  | 'reconcile_pre_dispatch'
  | 'observe_dispatch';

export type GmailArchiveRecoveryObservationState =
  | 'not_started'
  | 'started'
  | 'evidence_recorded';

export interface GmailArchiveRecoveryLeaseFence {
  userId: string;
  approvalId: string;
  admissionId: string;
  messageRefId: string;
  workKind: GmailArchiveRecoveryWorkKind;
  barrierStatus: 'reserved' | 'prepared' | 'in_progress';
  attemptPhase: GmailArchiveAttemptPhase | null;
  phaseChangedAt: string;
  leaseToken: string;
  generation: number;
}

export interface GmailArchiveRecoveryLease extends GmailArchiveRecoveryLeaseFence {
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  observationState: GmailArchiveRecoveryObservationState;
  observationAttemptId: string | null;
  observationAuthorizedAt: string | null;
  observationDeadlineAt: string | null;
  evidence: Readonly<GmailArchiveRecoveryObservationEvidence> | null;
}

export interface AcquireGmailArchiveRecoveryLeaseInput {
  userId: string;
  approvalId: string;
  leaseMs: number;
}

export type AcquireGmailArchiveRecoveryLeaseResult =
  | { ok: true; status: 'acquired'; created: boolean; lease: Readonly<GmailArchiveRecoveryLease> }
  | { ok: true; status: 'busy' | 'not_due' | 'terminal'; lease: null }
  | {
      ok: false;
      error: 'invalid_input' | 'not_found' | 'legacy_untracked' | 'integrity_conflict' |
        'commit_unverified';
    };

export interface GmailArchiveRecoveryObservationPermit extends GmailArchiveRecoveryLeaseFence {
  observationAttemptId: string;
  authorizedAt: string;
  /** Exact expiry of the lease generation that authorized this observation. */
  leaseExpiresAt: string;
  deadlineAt: string;
}

export interface GmailArchiveRecoveryMailboxObservedEvidence {
  kind: 'mailbox_observed';
  binding: Readonly<GmailInboxObservationBinding>;
  inbox: boolean;
  observedAt: string;
}

export interface GmailArchiveRecoveryObservationUnavailableEvidence {
  kind: 'mailbox_observation_unavailable';
  binding: Readonly<GmailInboxObservationBinding>;
  code: GmailInboxObservationUnavailableCode;
}

export type GmailArchiveRecoveryObservationEvidence =
  | GmailArchiveRecoveryMailboxObservedEvidence
  | GmailArchiveRecoveryObservationUnavailableEvidence;

export type BeginGmailArchiveRecoveryObservationResult =
  | {
      ok: true;
      status: 'permitted';
      permit: Readonly<GmailArchiveRecoveryObservationPermit>;
    }
  | {
      ok: true;
      status: 'already_started' | 'evidence_recorded';
      permit: null;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'stale_lease' | 'integrity_conflict' | 'commit_unverified';
    };

export interface RecordGmailArchiveRecoveryObservationInput {
  permit: GmailArchiveRecoveryObservationPermit;
  evidence: GmailArchiveRecoveryObservationEvidence;
}

export type RecordGmailArchiveRecoveryObservationResult =
  | {
      ok: true;
      recorded: boolean;
      evidence: Readonly<GmailArchiveRecoveryObservationEvidence>;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'stale_lease' | 'permit_expired' | 'evidence_conflict' |
        'integrity_conflict' | 'commit_unverified';
    };

export interface GmailArchiveRecoveryLeaseRepository {
  acquire(
    input: AcquireGmailArchiveRecoveryLeaseInput,
  ): Promise<AcquireGmailArchiveRecoveryLeaseResult>;
  renew(
    fence: GmailArchiveRecoveryLeaseFence,
    leaseMs: number,
  ): Promise<AcquireGmailArchiveRecoveryLeaseResult>;
  /**
   * Consumes the one-shot observation slot. A later runtime must call this
   * before the entire bounded OAuth materialization, final-authority check, and
   * Gmail GET envelope, and carry this permit through each step. This DB-only
   * slice does not wire that runtime.
   */
  beginObservation(
    fence: GmailArchiveRecoveryLeaseFence,
  ): Promise<BeginGmailArchiveRecoveryObservationResult>;
  /**
   * Freezes the evidence, samples DB time before opening the locking write
   * transaction, and accepts it only when submitted before the permit deadline.
   * Lock wait and persistence may complete later than that deadline.
   */
  recordObservation(
    input: RecordGmailArchiveRecoveryObservationInput,
  ): Promise<RecordGmailArchiveRecoveryObservationResult>;
}
