import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { gmailArchiveRuntimeRepositories } from '../repositories/index.js';

describe('Gmail archive runtime repository facade', () => {
  it('exposes only frozen, method-bound narrow ports', () => {
    expect(Object.isFrozen(gmailArchiveRuntimeRepositories)).toBe(true);
    expect(Object.keys(gmailArchiveRuntimeRepositories).sort()).toEqual([
      'approvalResponse',
      'claim',
      'dispatchGate',
      'observationTarget',
      'preDispatchReconciliation',
      'preparation',
      'recordedObservationReconciliation',
      'recoveryCandidates',
      'recoveryLease',
      'terminalStatus',
      'terminalization',
    ]);
    for (const port of Object.values(gmailArchiveRuntimeRepositories)) {
      expect(Object.isFrozen(port)).toBe(true);
      expect(Object.values(port).every((value) => typeof value === 'function')).toBe(true);
    }
    expect(Object.keys(gmailArchiveRuntimeRepositories.observationTarget).sort()).toEqual([
      'resolveFinal', 'resolveInitial',
    ]);
    expect(Object.keys(gmailArchiveRuntimeRepositories.recordedObservationReconciliation))
      .toEqual(['reconcileRecordedObservation']);
    expect(Object.keys(gmailArchiveRuntimeRepositories.terminalStatus)).toEqual(['read']);
    expect(Object.keys(gmailArchiveRuntimeRepositories.recoveryCandidates)).toEqual(['list']);
  });

  it('does not add individual sensitive leaves or test hooks to either barrel', async () => {
    const barrels = await Promise.all([
      readFile(new URL('../repositories/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../index.ts', import.meta.url), 'utf8'),
    ]);
    for (const barrel of barrels) {
      expect(barrel).toContain('gmailArchiveRuntimeRepositories');
      for (const forbidden of [
        'gmailArchiveApprovalResponseRepository',
        'gmailArchivePreparationRepository',
        'gmailArchiveClaimRepository',
        'gmailArchiveDispatchGateRepository',
        'gmailArchiveRecoveryRepository',
        'gmailArchiveRecoveryLeaseRepository',
        'gmailInboxObservationTargetRepository',
        'gmailArchiveReconciliationRepository',
        'gmailArchiveTerminalizationRepository',
        'gmailArchiveRecoveryCandidateRepository',
        'gmailArchiveRecordedObservationReconciliationRepository',
        'gmailArchiveTerminalStatusRepository',
        'gmailArchiveRecoveryCandidateTestHooks',
        'gmailArchiveRecordedObservationReconciliationTestHooks',
        'gmailArchiveTerminalStatusTestHooks',
      ]) expect(barrel).not.toContain(forbidden);
    }
  });

  it('keeps the provider mutation implementation out of the adapter barrel', async () => {
    const barrel = await readFile(
      new URL('../../../ironclaw-adapter/src/index.ts', import.meta.url),
      'utf8',
    );
    expect(barrel).not.toContain('GmailInboxMutationService');
    expect(barrel).toContain('gmailInboxMutationLimits');
  });
});
