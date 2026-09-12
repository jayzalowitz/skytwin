import type { ActionPolicy, PolicyRule } from '@skytwin/shared-types';
import type { PolicyRepositoryPort } from '@skytwin/policy-engine';
import { query } from '../connection.js';
import { policyRepository } from '../repositories/policy-repository.js';
import type { ActionPolicyRow } from '../types.js';

/**
 * Check whether a raw rule from the DB has the structured
 * `{condition: {field, operator, value}}` shape the policy engine expects.
 * Seed data may use a simpler `{action, condition: "string"}` format that
 * cannot be evaluated by the engine — those are filtered out.
 */
function isStructuredRule(raw: unknown): raw is PolicyRule {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (!r['condition'] || typeof r['condition'] !== 'object') return false;
  const cond = r['condition'] as Record<string, unknown>;
  return typeof cond['field'] === 'string';
}

/**
 * Maps a database `ActionPolicyRow` to the domain `ActionPolicy` type
 * expected by the policy engine.
 */
function toDomain(row: ActionPolicyRow): ActionPolicy {
  const rawRules = (Array.isArray(row.rules) ? row.rules : []) as unknown[];
  return {
    id: row.id,
    name: row.name,
    description: '',
    rules: rawRules.filter(isStructuredRule),
    priority: Number(row.priority),
    enabled: row.is_active,
    builtIn: false,
    createdAt: row.created_at,
    updatedAt: row.created_at,
  };
}

function requireOwnerId(userId: string): string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error('Policy reads require a non-empty owner ID.');
  }
  return userId;
}

/**
 * Adapter that implements `PolicyRepositoryPort` (from @skytwin/policy-engine)
 * by delegating to the concrete `policyRepository` (from @skytwin/db) and
 * raw SQL where needed.
 *
 * Every read is owner-scoped. Evaluation callers must supply the same user ID
 * that owns the decision or action being checked; there is no implicit
 * system-wide fallback.
 */
export const policyRepositoryAdapter: PolicyRepositoryPort = {
  async getAllPolicies(userId: string): Promise<ActionPolicy[]> {
    const ownerId = requireOwnerId(userId);
    const result = await query<ActionPolicyRow>(
      'SELECT * FROM action_policies WHERE user_id = $1 ORDER BY priority DESC',
      [ownerId],
    );
    return result.rows.map(toDomain);
  },

  async getEnabledPolicies(userId: string): Promise<ActionPolicy[]> {
    const ownerId = requireOwnerId(userId);
    const result = await query<ActionPolicyRow>(
      'SELECT * FROM action_policies WHERE user_id = $1 AND is_active = true ORDER BY priority DESC',
      [ownerId],
    );
    return result.rows.map(toDomain);
  },

  async getPolicy(policyId: string, userId: string): Promise<ActionPolicy | null> {
    const ownerId = requireOwnerId(userId);
    const result = await query<ActionPolicyRow>(
      'SELECT * FROM action_policies WHERE id = $1 AND user_id = $2',
      [policyId, ownerId],
    );
    const row = result.rows[0];
    return row ? toDomain(row) : null;
  },

  async getPoliciesByDomain(domain: string, userId: string): Promise<ActionPolicy[]> {
    const ownerId = requireOwnerId(userId);
    const result = await query<ActionPolicyRow>(
      'SELECT * FROM action_policies WHERE domain = $1 AND user_id = $2 AND is_active = true ORDER BY priority DESC',
      [domain, ownerId],
    );
    return result.rows.map(toDomain);
  },

  async savePolicy(policy: ActionPolicy): Promise<ActionPolicy> {
    const row = await policyRepository.createPolicy({
      userId: 'system',
      name: policy.name,
      domain: '',
      rules: policy.rules as unknown[],
      priority: policy.priority,
      isActive: policy.enabled,
    });
    return toDomain(row);
  },

  async updatePolicy(policy: ActionPolicy): Promise<ActionPolicy> {
    const row = await policyRepository.updatePolicy(policy.id, {
      name: policy.name,
      rules: policy.rules as unknown[],
      priority: policy.priority,
      isActive: policy.enabled,
    });
    if (!row) {
      throw new Error(`Policy not found: ${policy.id}`);
    }
    return toDomain(row);
  },

  async deletePolicy(policyId: string): Promise<void> {
    await policyRepository.hardDeletePolicy(policyId);
  },
};
