import {
  ConfidenceLevel,
  GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
  RiskDimension,
  RiskTier,
  SituationType,
  type CandidateAction,
  type DecisionObject,
  type DimensionAssessment,
  type RiskAssessment,
} from '@skytwin/shared-types';

const PROPOSAL_GATE = 'SKYTWIN_GMAIL_ARCHIVE_ENABLED';
const INPUT_KEYS = ['decision'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Provider targets and execution authority must never be supplied alongside
 * the canonical opaque message reference. Account and native provider IDs
 * remain behind the Gmail evidence repository boundary.
 */
const FORBIDDEN_RAW_AUTHORITY_KEYS = new Set([
  'admissionId',
  'connectorAccountId',
  'connectorEvidence',
  'emailId',
  'messageId',
  'operation',
  'parameters',
  'providerMessageId',
  'providerThreadId',
  'resourceRefId',
  'threadId',
]);

export interface BuildGmailArchiveProposalInput {
  decision: DecisionObject;
}

export interface GmailArchiveProposal {
  candidate: CandidateAction;
  /** Complete and ready for CandidateAction risk-assessment persistence. */
  riskAssessment: RiskAssessment;
}

export type BuildGmailArchiveProposalResult =
  | { ok: true; proposal: GmailArchiveProposal }
  | {
      ok: false;
      error: 'proposal_disabled' | 'invalid_input' | 'invalid_decision' | 'invalid_message_ref';
    };

/**
 * Proposal-only rollout switch. It is off unless the operator supplies the
 * exact value `true`; other truthy aliases and case variants do not enable it.
 */
export function gmailArchiveProposalEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.[PROPOSAL_GATE] === 'true';
}

function plainDataDescriptors(value: unknown): PropertyDescriptorMap | null {
  if (!value || typeof value !== 'object') return null;
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function dataValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return undefined;
  }
  return descriptor.value as unknown;
}

function parseDecision(input: unknown):
  | { ok: true; decisionId: string; messageRefId: string }
  | { ok: false; error: 'invalid_input' | 'invalid_decision' | 'invalid_message_ref' } {
  const inputDescriptors = plainDataDescriptors(input);
  if (!inputDescriptors) return { ok: false, error: 'invalid_input' };
  const inputKeys = Reflect.ownKeys(inputDescriptors);
  if (inputKeys.some((key) => typeof key !== 'string')) {
    return { ok: false, error: 'invalid_input' };
  }
  const sortedInputKeys = (inputKeys as string[]).sort();
  if (
    sortedInputKeys.length !== INPUT_KEYS.length ||
    sortedInputKeys.some((key, index) => key !== INPUT_KEYS[index])
  ) {
    return { ok: false, error: 'invalid_input' };
  }

  const decisionValue = dataValue(inputDescriptors, 'decision');
  const decisionDescriptors = plainDataDescriptors(decisionValue);
  if (!decisionDescriptors) return { ok: false, error: 'invalid_decision' };
  const decisionId = dataValue(decisionDescriptors, 'id');
  const situationType = dataValue(decisionDescriptors, 'situationType');
  const domain = dataValue(decisionDescriptors, 'domain');
  const rawDataValue = dataValue(decisionDescriptors, 'rawData');
  if (
    typeof decisionId !== 'string' || !UUID.test(decisionId) ||
    situationType !== SituationType.EMAIL_TRIAGE || domain !== 'email'
  ) {
    return { ok: false, error: 'invalid_decision' };
  }

  const rawDataDescriptors = plainDataDescriptors(rawDataValue);
  if (!rawDataDescriptors) return { ok: false, error: 'invalid_decision' };
  if (Reflect.ownKeys(rawDataDescriptors).some(
    (key) => typeof key !== 'string' || FORBIDDEN_RAW_AUTHORITY_KEYS.has(key),
  )) {
    return { ok: false, error: 'invalid_input' };
  }
  const messageRefId = dataValue(rawDataDescriptors, 'messageRefId');
  if (typeof messageRefId !== 'string' || !UUID.test(messageRefId)) {
    return { ok: false, error: 'invalid_message_ref' };
  }

  return {
    ok: true,
    decisionId,
    messageRefId,
  };
}

function archiveRiskAssessment(actionId: string, assessedAt: Date): RiskAssessment {
  const dimensions: Record<RiskDimension, DimensionAssessment> = {
    [RiskDimension.REVERSIBILITY]: {
      tier: RiskTier.LOW,
      score: 0.25,
      reasoning: 'The Inbox state can be restored manually, but this proposal has no automated compensation path.',
    },
    [RiskDimension.FINANCIAL_IMPACT]: {
      tier: RiskTier.NEGLIGIBLE,
      score: 0,
      reasoning: 'Archiving one message has no direct financial cost.',
    },
    [RiskDimension.LEGAL_SENSITIVITY]: {
      tier: RiskTier.LOW,
      score: 0.2,
      reasoning: 'Moving a message out of the Inbox can delay review of time-sensitive correspondence.',
    },
    [RiskDimension.PRIVACY_SENSITIVITY]: {
      tier: RiskTier.NEGLIGIBLE,
      score: 0.05,
      reasoning: 'The proposal identifies one opaque message reference and does not disclose message content.',
    },
    [RiskDimension.RELATIONSHIP_SENSITIVITY]: {
      tier: RiskTier.MODERATE,
      score: 0.5,
      reasoning: 'Hiding one inbound message can cause the user to miss correspondence that needs attention.',
    },
    [RiskDimension.OPERATIONAL_RISK]: {
      tier: RiskTier.MODERATE,
      score: 0.5,
      reasoning: 'The action changes the Inbox state of one account-bound message.',
    },
  };
  return {
    actionId,
    overallTier: RiskTier.MODERATE,
    dimensions,
    reasoning: 'This proposal changes mailbox state and requires one explicit confirmation before execution.',
    assessedAt,
  };
}

/**
 * Build one canonical, persistence-ready Gmail archive proposal. This module
 * does not register a route, persist anything, or expose dispatch authority.
 */
export function buildGmailArchiveProposal(
  input: BuildGmailArchiveProposalInput,
): BuildGmailArchiveProposalResult {
  if (!gmailArchiveProposalEnabled()) return { ok: false, error: 'proposal_disabled' };
  const parsed = parseDecision(input);
  if (!parsed.ok) return parsed;

  const candidateId = crypto.randomUUID();
  const candidate: CandidateAction = {
    id: candidateId,
    decisionId: parsed.decisionId,
    actionType: 'archive_email',
    description: 'Propose moving this message out of the Inbox.',
    domain: 'email',
    parameters: {
      schema: GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA,
      messageRefId: parsed.messageRefId,
      operation: 'archive',
    },
    estimatedCostCents: 0,
    costZeroIntent: 'verified_zero',
    reversible: true,
    confidence: ConfidenceLevel.MODERATE,
    reasoning: 'The trusted Gmail decision identifies one opaque, account-bound message target.',
    provenance: 'untrusted_external',
  };

  return {
    ok: true,
    proposal: {
      candidate,
      riskAssessment: archiveRiskAssessment(candidateId, new Date()),
    },
  };
}
