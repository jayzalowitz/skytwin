import type { GoogleConnectionMode } from '@skytwin/config';
import type { ExecutionAdmissionGuard } from '@skytwin/execution-router';
import {
  isAccountBackedEmailOrCalendarAction,
  isAccountBackedIntegration,
} from '@skytwin/shared-types';

/**
 * Build the worker's execution boundary using the same selected-adapter signal
 * as the API router. The first pre-selection check has no adapter name, while
 * prepare and dispatch checks receive the exact selected adapter.
 */
export function createWorkerExecutionAdmissionGuard(
  googleConnectionMode: GoogleConnectionMode,
): ExecutionAdmissionGuard {
  return (action, _userId, adapterName) => {
    if (googleConnectionMode === 'experimental') return { allowed: true };
    if (adapterName && isAccountBackedIntegration({ adapter: adapterName })) {
      return {
        allowed: false,
        reason: 'The selected execution integration is unavailable in this preview.',
      };
    }
    if (isAccountBackedEmailOrCalendarAction(action)) {
      return {
        allowed: false,
        reason: 'Account-backed email and calendar actions are unavailable in this preview.',
      };
    }
    return { allowed: true };
  };
}
