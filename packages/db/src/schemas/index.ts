import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the SQL schema file.
 */
export const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * All table names in the SkyTwin database.
 */
export const TABLE_NAMES = {
  users: 'users',
  connectedAccounts: 'connected_accounts',
  twinProfiles: 'twin_profiles',
  twinProfileVersions: 'twin_profile_versions',
  preferences: 'preferences',
  decisions: 'decisions',
  candidateActions: 'candidate_actions',
  decisionOutcomes: 'decision_outcomes',
  actionPolicies: 'action_policies',
  approvalRequests: 'approval_requests',
  executionPlans: 'execution_plans',
  executionResults: 'execution_results',
  explanationRecords: 'explanation_records',
  feedbackEvents: 'feedback_events',
} as const;

export type TableName = (typeof TABLE_NAMES)[keyof typeof TABLE_NAMES];
