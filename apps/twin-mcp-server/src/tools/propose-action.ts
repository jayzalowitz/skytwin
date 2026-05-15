import { decisionRepository } from '@skytwin/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ProposeActionArgs {
  action: {
    type: string;
    parameters: Record<string, unknown>;
    reasoning: string;
  };
  sourceAgent: string;
}

/**
 * Insert a proposed action from an external agent as a pending decision.
 * Requires scope: propose.
 *
 * HARD RAIL: This NEVER auto-executes. The decision is always set to
 * requires_approval=true, auto_executed=false. The user must approve it
 * through the SkyTwin web UI or API.
 *
 * The decision is flagged with origin=external_agent in its metadata so
 * the approval UI can surface the source agent prominently.
 */
export async function proposeAction(
  userId: string,
  args: ProposeActionArgs,
): Promise<CallToolResult> {
  const { action, sourceAgent } = args;

  if (!action?.type || typeof action.type !== 'string' || !action.type.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'action.type must be a non-empty string' }],
    };
  }
  if (!action.reasoning || typeof action.reasoning !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'action.reasoning must be a non-empty string' }],
    };
  }
  if (!sourceAgent || typeof sourceAgent !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'sourceAgent must be a non-empty string' }],
    };
  }

  // Create the decision row
  const { row: decision } = await decisionRepository.create({
    userId,
    situationType: action.type,
    rawEvent: {
      origin: 'external_agent',
      sourceAgent,
      proposedAt: new Date().toISOString(),
    },
    interpretedSituation: {
      type: action.type,
      parameters: action.parameters ?? {},
      reasoning: action.reasoning,
      proposedByAgent: sourceAgent,
    },
    domain: 'external_agent',
    urgency: 'normal',
    metadata: {
      origin: 'external_agent',
      sourceAgent,
      requiresApproval: true,
      autoExecute: false,
    },
  });

  // Add a candidate action to the decision
  const candidateAction = await decisionRepository.addCandidateAction({
    decisionId: decision.id,
    actionType: action.type,
    description: action.reasoning,
    parameters: {
      ...action.parameters,
      origin: 'external_agent',
      sourceAgent,
    },
    predictedUserPreference: 'unknown',
    riskAssessment: {
      level: 'moderate',
      reasoning: `Proposed by external agent: ${sourceAgent}. Manual review required.`,
      factors: ['external_origin', 'unverified_agent'],
    },
    reversible: false, // conservative — external proposals assumed irreversible until proven
  });

  // Record outcome: never auto-execute — always pending_approval (HARD RAIL)
  await decisionRepository.recordOutcome({
    decisionId: decision.id,
    selectedActionId: candidateAction.id,
    autoExecuted: false,        // HARD RAIL: NEVER true for external_agent proposals
    requiresApproval: true,     // HARD RAIL: ALWAYS true
    escalationReason: `Proposed by external MCP agent: ${sourceAgent}`,
    explanation: action.reasoning,
    confidence: 0.5,
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          decisionId: decision.id,
          status: 'pending_approval',
          message: `Action proposal from "${sourceAgent}" created. The user must approve it before execution.`,
        }),
      },
    ],
  };
}
