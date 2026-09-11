export const GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA = 'gmail_inbox_mutation_v1';

/** Authority-minimized command for one admitted Inbox state transition. */
export interface GmailInboxMutationCommand {
  userId: string;
  admissionId: string;
  messageRefId: string;
  operation: 'archive' | 'restore';
}

export type GmailInboxMutationResult =
  | {
      outcome: 'confirmed';
      operation: GmailInboxMutationCommand['operation'];
      inbox: boolean;
      effect: 'changed' | 'already_in_state' | 'reconciled';
      compensationAvailable: boolean;
      observationRecorded: boolean;
    }
  | {
      outcome: 'known_failure';
      code: 'invalid_command' | 'not_admitted' | 'credentials_unavailable' | 'remote_rejected';
      compensationAvailable: false;
    }
  | {
      outcome: 'unknown';
      code: 'admission_unavailable' | 'preflight_unavailable' | 'remote_outcome_unknown';
      compensationAvailable: false;
    };

export interface GmailInboxMutationPort {
  mutate(command: GmailInboxMutationCommand): Promise<GmailInboxMutationResult>;
}
