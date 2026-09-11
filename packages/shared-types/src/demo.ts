/**
 * Public demo route response shapes (apps/api/src/routes/demo.ts).
 *
 * These describe the unauthenticated tour-mode surface so the dashboard
 * client and any future consumer can type-check against a single source.
 */

import type { WhatWouldIDoResponse } from './twin.js';
import type { ActionProvenance, ConfirmationLevel } from './action-safety.js';

/**
 * Response from `GET /api/v1/demo/info`.
 *
 * `available: false` when the seeded demo user is missing. The server
 * intentionally omits PII like email and name even when the user exists.
 */
export type DemoInfoResponse =
  { available: false } | { available: true; userId: string };

/** Response from `POST /api/v1/demo/session`. */
export interface DemoSessionResponse {
  token: string;
  userId: string;
  expiresAt: string;
}

export type SampleSimulationProposalId =
  | 'calendar-focus'
  | 'newsletter-triage'
  | 'focus-time-preference'
  | 'untrusted-document';

export type SampleSimulationStatus =
  | 'pending'
  | 'simulated_approved'
  | 'simulated_rejected'
  | 'simulated_corrected'
  | 'contained';

export type SampleSimulationCommandType =
  'approve' | 'reject' | 'correct' | 'reset';

export type SampleSimulationActionType =
  'decline_event' | 'archive_email' | 'schedule_focus_block' | 'shell_exec';

export interface SampleSimulationCorrectionOption {
  id: 'prefer-afternoons';
  label: string;
  learnedPreference: string;
}

export interface SampleSimulationPolicyResult {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  confirmationLevel: ConfirmationLevel | 'none';
}

export interface SampleSimulationExplanation {
  summary: string;
  evidence: string[];
  preferences: string[];
  confidenceReasoning: string;
  actionRationale: string;
  escalationRationale: string | null;
  correctionGuidance: string;
  riskTier: string;
}

export interface SampleSimulationProposal {
  id: SampleSimulationProposalId;
  title: string;
  situation: string;
  proposedAction: string;
  actionType: SampleSimulationActionType;
  status: SampleSimulationStatus;
  provenance: ActionProvenance;
  provenanceNote: string;
  estimatedCostCents: number;
  reversible: boolean;
  policy: SampleSimulationPolicyResult;
  explanation: SampleSimulationExplanation;
  allowedCommands: Array<'approve' | 'reject' | 'correct'>;
  correctionOptions: SampleSimulationCorrectionOption[];
  resultMessage: string | null;
  simulationOnly: true;
  externalEffects: false;
}

export interface SampleSimulationLearning {
  key: 'preferred_focus_window';
  value: 'afternoon';
  source: 'corrected';
}

export interface SampleSimulationPrediction {
  label: string;
  proposedAction: string;
  changedByLearning: boolean;
}

export interface SampleSimulationStateResponse {
  mode: 'simulation';
  sessionIsolated: true;
  revision: number;
  proposals: SampleSimulationProposal[];
  learning: SampleSimulationLearning[];
  nextPrediction: SampleSimulationPrediction;
}

export type SampleSimulationCommand =
  | {
      type: 'approve' | 'reject';
      proposalId: Exclude<SampleSimulationProposalId, 'untrusted-document'>;
    }
  | {
      type: 'correct';
      proposalId: 'focus-time-preference';
      correctionId: 'prefer-afternoons';
    }
  | { type: 'reset' };

/**
 * Response from `POST /api/v1/demo/preview`.
 *
 * Same shape as `WhatWouldIDoResponse` plus a rate-limit hint so the
 * dashboard's Ask Your Twin widget can show "N previews left this window"
 * if it ever wants to.
 */
export interface DemoPreviewResponse extends WhatWouldIDoResponse {
  previewRateLimit: {
    remaining: number;
    windowMs: number;
  };
}
