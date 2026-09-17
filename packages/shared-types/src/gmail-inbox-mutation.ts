export const GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA = 'gmail_inbox_mutation_v1';
export const GMAIL_ARCHIVE_ATTEMPT_SCHEMA = 'gmail_archive_attempt_v1';

export type GmailArchiveAttemptPhase = 'pre_dispatch' | 'dispatch_may_have_started';

/** Durable, exact B1 state bracketing the sole non-idempotent provider request. */
export interface GmailArchiveAttemptStateV1 {
  schema: typeof GMAIL_ARCHIVE_ATTEMPT_SCHEMA;
  phase: GmailArchiveAttemptPhase;
}

/** Authority-minimized command for one admitted Inbox archive. */
export interface GmailInboxMutationCommand {
  userId: string;
  admissionId: string;
  messageRefId: string;
  operation: 'archive';
}

/** Secret-free authority tuple copied from the exact canonical command. */
export interface GmailInboxMutationBinding {
  userId: string;
  admissionId: string;
  messageRefId: string;
}

/** Exact private provider target held only across the mutation/gate boundary. */
export interface GmailInboxMutationTarget {
  connectorAccountId: string;
  credentialRevision: string;
  providerMessageId: string;
}

export type GmailInboxMutationResult =
  | {
      outcome: 'confirmed';
      operation: 'archive';
      inbox: false;
      effect: 'changed' | 'already_in_state' | 'reconciled';
      /** Restore is not implemented by this archive-only boundary. */
      compensationAvailable: false;
      /** Local acceptance time after the complete bounded provider representation validates. */
      observedAt: string;
      /** Exact command authority this same-call provider result belongs to. */
      binding: Readonly<GmailInboxMutationBinding>;
    }
  | {
      outcome: 'known_failure';
      code: 'invalid_command';
      compensationAvailable: false;
    }
  | {
      outcome: 'known_failure';
      code: 'not_admitted' | 'admission_unavailable' |
        'credentials_unavailable' | 'preflight_unavailable' | 'remote_rejected';
      compensationAvailable: false;
      /** Exact command authority this same-call failure belongs to. */
      binding: Readonly<GmailInboxMutationBinding>;
    }
  | {
      outcome: 'unknown';
      /** Reserved for a mutation POST whose external effect cannot be proven. */
      code: 'remote_outcome_unknown';
      compensationAvailable: false;
      /** Exact command authority this same-call unknown outcome belongs to. */
      binding: Readonly<GmailInboxMutationBinding>;
    };

export interface GmailInboxMutationPort {
  mutate(command: GmailInboxMutationCommand): Promise<GmailInboxMutationResult>;
}

export type GmailInboxMutationDispatchGateResult =
  | { status: 'entered' }
  | { status: 'not_admitted' }
  | { status: 'conflict' };

/**
 * Mandatory durable gate entered immediately before the sole Gmail mutation
 * request. A provider request is forbidden unless `entered` was returned.
 */
export interface GmailInboxMutationDispatchGate {
  enter(
    command: GmailInboxMutationCommand,
    expectedTarget: GmailInboxMutationTarget,
  ): Promise<GmailInboxMutationDispatchGateResult>;
}
