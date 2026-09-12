/** Authority-minimized command for one read-only Gmail Inbox observation. */
export interface GmailInboxObservationCommand {
  userId: string;
  admissionId: string;
  messageRefId: string;
  operation: 'observe_inbox';
}

/** Secret-free authority tuple copied from the exact canonical command. */
export interface GmailInboxObservationBinding {
  userId: string;
  admissionId: string;
  messageRefId: string;
}

export type GmailInboxObservationUnavailableCode =
  | 'not_observable'
  | 'authority_unavailable'
  | 'credentials_unavailable'
  | 'observation_rejected'
  | 'observation_unavailable';

/**
 * A factual mailbox observation, deliberately distinct from mutation results.
 * An observation never attributes the state to a prior archive attempt.
 */
export type GmailInboxObservationResult =
  | {
      outcome: 'observed';
      operation: 'observe_inbox';
      inbox: boolean;
      /** Local time at which the bounded provider evidence was accepted. */
      observedAt: string;
      /** Exact command authority this factual evidence belongs to. */
      binding: Readonly<GmailInboxObservationBinding>;
    }
  | {
      outcome: 'unavailable';
      code: 'invalid_command';
    }
  | {
      outcome: 'unavailable';
      code: GmailInboxObservationUnavailableCode;
      /** Exact command authority this unavailable observation belongs to. */
      binding: Readonly<GmailInboxObservationBinding>;
    };

/** Mailbox-read-only boundary; implementations must not mutate Gmail state. */
export interface GmailInboxObservationPort {
  observe(command: GmailInboxObservationCommand): Promise<GmailInboxObservationResult>;
}
