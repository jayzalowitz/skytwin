/**
 * MCP-action spend recording site (#323 AC#3).
 *
 * Closes the last open acceptance criterion on #323: the decision
 * pipeline now populates `spend_records.registry_id` from the executed
 * action's source. Migration 054 + the repository wiring
 * (`spendRepository.create` / `checkAndRecordSpend` accepting an
 * optional `registryId`) and the per-app `getMonthlyTotal(userId,
 * appRegistryId)` query all shipped in v0.6.48.0 (PR #329); what was
 * missing was a recording site that actually *knows* its registry
 * source. That dependency (which server an action ran against) landed
 * via #324 partial (PR #330) — the action's target MCP server is on
 * `action.parameters.mcpServerId` (the `mcp_servers` row id that
 * `McpHost.buildPlan` honors).
 *
 * This helper is invoked AFTER a candidate action has executed through
 * the trust-ranked router on both the auto-execute path
 * (`routes/events.ts`) and the approved-execute path
 * (`routes/approvals.ts`). It:
 *
 *   1. Skips zero-cost actions — they don't consume budget, mirroring
 *      the cost-gate's zero-cost short-circuit. Recording a 0-cent row
 *      would only add noise to the audit timeline.
 *   2. Resolves the registry source: `parameters.mcpServerId` →
 *      `mcp_servers.registry_id`. When the action didn't target a
 *      specific MCP server (Direct / IronClaw / auto-selected), or the
 *      server row has no `registry_id`, the spend is still recorded but
 *      with `registryId` left undefined → the column stays NULL and the
 *      row only contributes to user-global monthly totals, never to a
 *      per-app total. This is the exact semantics migration 054
 *      documents: "leave rows un-backfillable as NULL."
 *   3. Records the spend via `spendRepository.create`. This is a
 *      post-execution *ledger* write, not a pre-execution reservation —
 *      the spend cap was already enforced upstream by the policy engine
 *      / cost-gate before the action ran (Safety Invariant #4). We use
 *      `create` (not `checkAndRecordSpend`) because the limit decision
 *      already happened; double-gating here would reject already-
 *      executed, already-approved work.
 *
 * Best-effort: a failure to record spend must never surface as a
 * user-facing execution error — the action already ran. Errors are
 * logged and swallowed so the ledger write can't break the response.
 */

import { createLogger } from '@skytwin/core';
import { mcpServerRepository, spendRepository } from '@skytwin/db';
import type { CandidateAction } from '@skytwin/shared-types';

const log = createLogger('api:mcp-action-spend');

export interface RecordMcpActionSpendInput {
  userId: string;
  decisionId: string;
  action: CandidateAction;
}

/**
 * Resolve the registry source for an executed action.
 *
 * The action's target MCP server (when it has one) lives on
 * `parameters.mcpServerId` — the `mcp_servers` row id. We map that to
 * the row's `registry_id` (the stable per-app identifier the per-app
 * monthly totals key on). Returns `undefined` when:
 *   - the action didn't target an MCP server (no `mcpServerId`), or
 *   - the server row is gone, or
 *   - the server row has no `registry_id` (locally-defined server with
 *     no registry entry).
 *
 * `undefined` is the correct "no known registry source" signal — it
 * flows through to a NULL `registry_id` column. We deliberately do NOT
 * substitute the raw row id or any default: per-app totals must only
 * see genuine registry ids, and a NULL row rolls into user-global only.
 */
async function resolveRegistrySource(
  action: CandidateAction,
): Promise<string | undefined> {
  const serverId = action.parameters['mcpServerId'];
  if (typeof serverId !== 'string' || serverId.length === 0) {
    return undefined;
  }
  const server = await mcpServerRepository.getById(serverId);
  return server?.registry_id ?? undefined;
}

/**
 * Record post-execution spend for an MCP-backed action, tagged with the
 * action's registry source when one is resolvable (#323 AC#3).
 *
 * Best-effort: returns `void`, never throws. Callers fire this after a
 * successful (or attempted) execution and continue regardless.
 */
export async function recordMcpActionSpend(
  input: RecordMcpActionSpendInput,
): Promise<void> {
  const { userId, decisionId, action } = input;

  // Zero-cost (and any malformed negative) actions never consume
  // budget — nothing to record. Mirrors the cost-gate's zero-cost
  // short-circuit so the ledger stays free of noise rows.
  if (!Number.isFinite(action.estimatedCostCents) || action.estimatedCostCents <= 0) {
    return;
  }

  try {
    const registryId = await resolveRegistrySource(action);
    await spendRepository.create({
      userId,
      actionId: action.id,
      decisionId,
      estimatedCostCents: action.estimatedCostCents,
      // Undefined → NULL column → user-global totals only. A resolved
      // registry id makes the row count toward that app's per-app
      // monthly total via getMonthlyTotal(userId, registryId).
      registryId,
    });
    log.info('Recorded MCP-action spend', {
      userId,
      decisionId,
      actionId: action.id,
      estimatedCostCents: action.estimatedCostCents,
      registryId: registryId ?? null,
    });
  } catch (err) {
    // Never let a ledger write break the already-executed action's
    // response. Spend tracking is observability + future-budget input,
    // not part of the execution success contract.
    log.warn('Failed to record MCP-action spend (best-effort, swallowed)', {
      userId,
      decisionId,
      actionId: action.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
