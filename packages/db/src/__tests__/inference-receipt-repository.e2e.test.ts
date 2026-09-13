/**
 * Real CockroachDB coverage for the inference-receipt ownership boundary.
 *
 * Run via:
 * E2E=true pnpm --filter @skytwin/db exec vitest run src/__tests__/inference-receipt-repository.e2e.test.ts
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  sha256Hex,
  signInferenceReceipt,
  type InferenceReceiptExportV1,
} from '@skytwin/shared-types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closePool } from '../connection.js';
import { collectBackup, restoreBackup } from '../backup/backup.js';
import { inferenceReceiptRepository } from '../repositories/inference-receipt-repository.js';

const E2E = process.env['E2E'] === 'true';
const keys = generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let pool: Pool;
const createdUserIds: string[] = [];

interface Graph {
  userId: string;
  decisionId: string;
  explanationId: string;
}

async function createGraph(label: string): Promise<Graph> {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, trust_tier, autonomy_settings)
     VALUES ($1, $2, 'observer', '{}') RETURNING id`,
    [`receipt-${label}-${randomUUID()}@example.test`, `Receipt ${label}`],
  );
  const userId = user.rows[0]!.id;
  createdUserIds.push(userId);
  const decision = await pool.query<{ id: string }>(
    `INSERT INTO decisions
       (user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
     VALUES ($1, 'test', '{}', '{}', 'test', 'normal', '{}') RETURNING id`,
    [userId],
  );
  const decisionId = decision.rows[0]!.id;
  const explanation = await pool.query<{ id: string }>(
    `INSERT INTO explanation_records
       (decision_id, what_happened, evidence_used, preferences_invoked,
        confidence_reasoning, action_rationale, correction_guidance)
     VALUES ($1, 'receipt test', '[]', '{}', 'fixture', 'fixture', 'fixture') RETURNING id`,
    [decisionId],
  );
  return { userId, decisionId, explanationId: explanation.rows[0]!.id };
}

function receiptBundle(graph: Graph): InferenceReceiptExportV1 {
  const request = Buffer.from('request');
  const response = Buffer.from('response');
  return {
    exportVersion: 1,
    receipt: signInferenceReceipt({
      version: 1,
      id: randomUUID(),
      userId: graph.userId,
      decisionId: graph.decisionId,
      explanationId: graph.explanationId,
      reasoningMode: 'on_device',
      provider: 'embedded',
      model: 'local',
      endpointIdentity: 'local',
      requestSha256: sha256Hex(request),
      responseSha256: sha256Hex(response),
      verifierVersion: '1',
      cost: { basis: 'exact', currency: 'USD', amountMinor: 0 },
      status: 'on_device',
      createdAt: '2026-09-12T00:00:00.000Z',
    }, { keyId: 'e2e-recorder', privateKeyPem, publicKeyPem }),
    requestBase64: request.toString('base64'),
    responseBase64: response.toString('base64'),
    disclosure: 'Test fixture bytes.',
  };
}

describe.skipIf(!E2E)('E2E: inference receipt repository', () => {
  beforeAll(() => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) throw new Error('DATABASE_URL must be set for E2E tests');
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
  });

  afterEach(async () => {
    for (const userId of createdUserIds) {
      await pool.query(
        `DELETE FROM explanation_records WHERE decision_id IN
         (SELECT id FROM decisions WHERE user_id = $1)`,
        [userId],
      );
      await pool.query('DELETE FROM decisions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
    createdUserIds.length = 0;
  });

  afterAll(async () => {
    await closePool();
    await pool.end();
  });

  it('inserts, reads, and deletes only through the exact decision owner', async () => {
    const owner = await createGraph('owner');
    const other = await createGraph('other');
    const bundle = receiptBundle(owner);
    expect(await inferenceReceiptRepository.createForUser(other.userId, {
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    })).toBeNull();
    const created = await inferenceReceiptRepository.createForUser(owner.userId, {
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    });

    expect(created).toMatchObject({
      id: bundle.receipt.id,
      version: 1,
      decision_id: owner.decisionId,
      explanation_id: owner.explanationId,
      trusted: true,
    });
    expect(await inferenceReceiptRepository.findByIdForUser(owner.userId, bundle.receipt.id))
      .toMatchObject({ id: bundle.receipt.id });
    expect(await inferenceReceiptRepository.findByDecisionForUser(owner.userId, owner.decisionId))
      .toMatchObject({ id: bundle.receipt.id });
    expect(await inferenceReceiptRepository.findByIdForUser(other.userId, bundle.receipt.id)).toBeNull();
    expect(await inferenceReceiptRepository.findByDecisionForUser(other.userId, owner.decisionId)).toBeNull();
    expect(await inferenceReceiptRepository.deleteForUser(other.userId, bundle.receipt.id)).toBe(false);
    expect(await inferenceReceiptRepository.deleteByDecisionForUser(other.userId, owner.decisionId)).toBe(false);
    expect(await inferenceReceiptRepository.deleteForUser(owner.userId, bundle.receipt.id)).toBe(true);
    expect(await inferenceReceiptRepository.findByIdForUser(owner.userId, bundle.receipt.id)).toBeNull();
  });

  it('enforces receipt version, status, and exact explanation-decision linkage constraints', async () => {
    const owner = await createGraph('constraints-owner');
    const other = await createGraph('constraints-other');
    const insert = (version: number, status: string, explanationId = owner.explanationId) =>
      pool.query(
        `INSERT INTO inference_receipts
           (id, version, decision_id, explanation_id, status, receipt, trusted)
         VALUES ($1, $2, $3, $4, $5, '{}', false)`,
        [randomUUID(), version, owner.decisionId, explanationId, status],
      );

    await expect(insert(2, 'on_device')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(1, 'unknown')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(1, 'on_device', other.explanationId))
      .rejects.toMatchObject({ code: '23503' });

    await insert(1, 'on_device');
    const secondExplanation = await pool.query<{ id: string }>(
      `INSERT INTO explanation_records
         (decision_id, what_happened, evidence_used, preferences_invoked,
          confidence_reasoning, action_rationale, correction_guidance)
       VALUES ($1, 'second receipt test', '[]', '{}', 'fixture', 'fixture', 'fixture')
       RETURNING id`,
      [owner.decisionId],
    );
    await expect(insert(1, 'on_device', secondExplanation.rows[0]!.id))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('admits exactly one immutable receipt batch under concurrent finalization', async () => {
    const owner = await createGraph('concurrent-completion');
    const first = receiptBundle(owner);
    const second = receiptBundle(owner);
    const input = (bundle: InferenceReceiptExportV1) => [{
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    }];
    const completion = {
      decisionId: owner.decisionId,
      explanationId: owner.explanationId,
    };

    const settled = await Promise.allSettled([
      inferenceReceiptRepository.createManyForUser(owner.userId, input(first), completion),
      inferenceReceiptRepository.createManyForUser(owner.userId, input(second), completion),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rows = await pool.query<{ id: string; version: number }>(
      `SELECT id, version::INT4 AS version
         FROM inference_receipts WHERE decision_id = $1`,
      [owner.decisionId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(typeof rows.rows[0]?.version).toBe('number');
    const completions = await pool.query(
      `SELECT 1 FROM inference_receipt_completions WHERE decision_id = $1`,
      [owner.decisionId],
    );
    expect(completions.rows).toHaveLength(1);
  });

  it('round-trips a schema-v2 receipt backup as canonical untrusted metadata', async () => {
    const owner = await createGraph('backup-owner');
    const bundle = receiptBundle(owner);
    const created = await inferenceReceiptRepository.createForUser(owner.userId, {
      bundle,
      trustedRecorderKeys: new Map([['e2e-recorder', publicKeyPem]]),
    });
    expect(created).not.toBeNull();

    const backup = await collectBackup(owner.userId);
    expect(backup.success).toBe(true);
    if (!backup.success) return;
    expect(backup.data.schemaVersion).toBe(2);
    expect(backup.data.decisions).toHaveLength(1);
    expect(backup.data.decisions[0]?.inferenceReceipts).toHaveLength(1);
    expect(backup.data.decisions[0]?.inferenceReceipts?.[0]).toMatchObject({
      id: bundle.receipt.id,
      version: 1,
      trusted: true,
      receipt: bundle.receipt,
    });
    expect(typeof backup.data.decisions[0]?.inferenceReceipts?.[0]?.version).toBe('number');

    await pool.query('DELETE FROM explanation_records WHERE decision_id = $1', [owner.decisionId]);
    await pool.query('DELETE FROM decisions WHERE id = $1', [owner.decisionId]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner.userId]);

    const restored = await restoreBackup(backup.data);
    expect(restored).toMatchObject({ success: true });
    const stored = await pool.query<{
      version: number;
      trusted: boolean;
      receipt: unknown;
    }>(
      `SELECT version::INT4 AS version, trusted, receipt
         FROM inference_receipts WHERE id = $1`,
      [bundle.receipt.id],
    );
    expect(stored.rows).toEqual([{
      version: 1,
      trusted: false,
      receipt: bundle.receipt,
    }]);
    expect(typeof stored.rows[0]?.version).toBe('number');
  });
});
