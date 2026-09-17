import { gmailArchiveApprovalResponseRepository } from './gmail-archive-approval-response-repository.js';
import { gmailArchiveClaimRepository } from './gmail-archive-claim-repository.js';
import { gmailArchiveDispatchGateRepository } from './gmail-archive-dispatch-gate-repository.js';
import { gmailArchivePreparationRepository } from './gmail-archive-preparation-repository.js';
import { gmailArchiveReconciliationRepository } from './gmail-archive-reconciliation-repository.js';
import { gmailArchiveRecordedObservationReconciliationRepository } from './gmail-archive-recorded-observation-reconciliation-repository.js';
import { gmailArchiveRecoveryCandidateRepository } from './gmail-archive-recovery-candidate-repository.js';
import { gmailArchiveRecoveryLeaseRepository } from './gmail-archive-recovery-lease-repository.js';
import { gmailArchiveTerminalStatusRepository } from './gmail-archive-terminal-status-repository.js';
import { gmailArchiveTerminalizationRepository } from './gmail-archive-terminalization-repository.js';
import { gmailInboxObservationTargetRepository } from './gmail-inbox-observation-target-repository.js';

const approvalResponse = Object.freeze({
  respond: gmailArchiveApprovalResponseRepository.respond.bind(gmailArchiveApprovalResponseRepository),
});
const preparation = Object.freeze({
  prepare: gmailArchivePreparationRepository.prepare.bind(gmailArchivePreparationRepository),
});
const claim = Object.freeze({
  claim: gmailArchiveClaimRepository.claim.bind(gmailArchiveClaimRepository),
});
const dispatchGate = Object.freeze({
  enter: gmailArchiveDispatchGateRepository.enter.bind(gmailArchiveDispatchGateRepository),
});
const terminalization = Object.freeze({
  terminalize: gmailArchiveTerminalizationRepository.terminalize.bind(
    gmailArchiveTerminalizationRepository,
  ),
});
const recoveryLease = Object.freeze({
  acquire: gmailArchiveRecoveryLeaseRepository.acquire.bind(gmailArchiveRecoveryLeaseRepository),
  renew: gmailArchiveRecoveryLeaseRepository.renew.bind(gmailArchiveRecoveryLeaseRepository),
  beginObservation: gmailArchiveRecoveryLeaseRepository.beginObservation.bind(
    gmailArchiveRecoveryLeaseRepository,
  ),
  recordObservation: gmailArchiveRecoveryLeaseRepository.recordObservation.bind(
    gmailArchiveRecoveryLeaseRepository,
  ),
});
const observationTarget = Object.freeze({
  resolveInitial: gmailInboxObservationTargetRepository.resolveInitial.bind(
    gmailInboxObservationTargetRepository,
  ),
  resolveFinal: gmailInboxObservationTargetRepository.resolveFinal.bind(
    gmailInboxObservationTargetRepository,
  ),
});
const preDispatchReconciliation = Object.freeze({
  reconcile: gmailArchiveReconciliationRepository.reconcile.bind(
    gmailArchiveReconciliationRepository,
  ),
});
const recordedObservationReconciliation = Object.freeze({
  reconcileRecordedObservation:
    gmailArchiveRecordedObservationReconciliationRepository.reconcileRecordedObservation.bind(
      gmailArchiveRecordedObservationReconciliationRepository,
    ),
});
const terminalStatus = Object.freeze({
  read: gmailArchiveTerminalStatusRepository.read.bind(gmailArchiveTerminalStatusRepository),
});
const recoveryCandidates = Object.freeze({
  list: gmailArchiveRecoveryCandidateRepository.list.bind(
    gmailArchiveRecoveryCandidateRepository,
  ),
});

/**
 * The only public composition surface for the dedicated archive runtime. Each
 * nested port is method-bound and frozen; raw leaf repositories and test hooks
 * remain unavailable from package barrels.
 */
export const gmailArchiveRuntimeRepositories = Object.freeze({
  approvalResponse,
  preparation,
  claim,
  dispatchGate,
  terminalization,
  recoveryLease,
  observationTarget,
  preDispatchReconciliation,
  recordedObservationReconciliation,
  terminalStatus,
  recoveryCandidates,
});
