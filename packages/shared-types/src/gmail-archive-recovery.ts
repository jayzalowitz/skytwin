import type {
  GmailArchiveAttemptPhase,
  GmailInboxMutationCommand,
} from './gmail-inbox-mutation.js';

/** Owner authority for a read-only abandoned archive claim lookup. */
export interface QueryAbandonedGmailArchiveInput {
  userId: string;
  approvalId: string;
}

export interface AbandonedGmailArchiveRecovery {
  command: Readonly<GmailInboxMutationCommand>;
  phase: GmailArchiveAttemptPhase;
  /** Database timestamp at which the current durable attempt phase began. */
  phaseChangedAt: string;
}

export type QueryAbandonedGmailArchiveResult =
  | {
      ok: true;
      status: 'eligible';
      recovery: Readonly<AbandonedGmailArchiveRecovery>;
    }
  | {
      ok: true;
      status: 'not_due' | 'terminal';
      recovery: null;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'not_found' | 'legacy_untracked' | 'integrity_conflict';
    };

/** Read-only durable query. It neither dispatches nor terminalizes an attempt. */
export interface AbandonedGmailArchiveRecoveryQuery {
  query(input: QueryAbandonedGmailArchiveInput): Promise<QueryAbandonedGmailArchiveResult>;
}
