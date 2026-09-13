import { describe, expect, it } from 'vitest';
import {
  normalizeAdapterOutput,
  normalizeExecutionError,
  normalizeExecutionEventPayload,
  normalizeExecutionObservation,
  normalizeExecutionPlanSteps,
  normalizeMemoryActionReport,
  normalizeMemoryActionText,
} from '../execution-evidence.js';

const SYNTHETIC_AWS_ACCESS_KEY = ['AK', 'IAIOSFODNN7EXAMPLE'].join('');
const SYNTHETIC_GITHUB_TOKEN = ['gh', 'p_abcdefghijklmnopqrstuvwxyz1234567890'].join('');
const SYNTHETIC_GITHUB_PAT = ['github_', 'pat_11AA22BB33CC44DD55EE66FF'].join('');
const SYNTHETIC_PRIVATE_KEY = [
  '-----BEGIN PRIVATE ',
  'KEY-----\nopaque-body\n-----END PRIVATE KEY-----',
].join('');

describe('typed execution evidence normalization', () => {
  it('keeps only known-safe canonical result facts', () => {
    expect(normalizeAdapterOutput({
      adapter_used: 'direct',
      routing_decision: 'ironclaw',
      fallbacks_attempted: 1,
      fallback_skipped_reason: 'previous adapter returned non-completed status, fallback unsafe',
      adapter_plan_id: 'remote-plan-1',
      status: 'completed',
      success: true,
      rollback_available: false,
    })).toEqual({
      adapter_used: 'direct',
      routing_decision: 'ironclaw',
      fallbacks_attempted: 1,
      fallback_skipped_reason: 'previous adapter returned non-completed status, fallback unsafe',
      adapter_plan_id: 'remote-plan-1',
      status: 'completed',
      success: true,
      rollback_available: false,
    });
  });

  it.each([
    ['nested arrays', { output: [{ status: 'completed' }, 'opaque-secret'] }],
    ['primitive output', { output: 'opaque-secret' }],
    ['primitive payload', { payload: 'opaque-secret' }],
    ['primitive result', { result: ['opaque-secret'] }],
    ['primitive steps', { steps: ['opaque-secret'] }],
    ['primitive metadata', { metadata: 'opaque-secret' }],
    ['nested secret key', { metadata: { accessToken: 'opaque-secret' } }],
  ])('collapses %s instead of recursively preserving container content', (_label, input) => {
    const serialized = JSON.stringify(normalizeAdapterOutput(input));
    expect(serialized).not.toContain('opaque-secret');
    expect(serialized).toBe('{"_redacted":"[redacted:unapproved-evidence]"}');
  });

  it('bounds huge values and never preserves unknown keys or values in event payloads', () => {
    const huge = 'x'.repeat(100_000);
    const result = normalizeExecutionEventPayload({
      adapter_used: huge,
      [huge]: huge,
      body: huge,
    });
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(100);
    expect(serialized).not.toContain(huge);
    expect(result).toEqual({ _redacted: '[redacted:unapproved-evidence]' });
  });

  it('uses an exact typed observation envelope and normalizes nested output', () => {
    const result = normalizeExecutionObservation({
      planId: 'plan-1',
      status: 'failed',
      adapterName: 'direct',
      output: { adapter_used: 'direct', body: ['opaque-secret'] },
      error: 'opaque-secret',
      metadata: ['opaque-secret'],
    });
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({
      planId: 'plan-1', status: 'failed', adapterName: 'direct',
      output: { adapter_used: 'direct', _redacted: '[redacted:unapproved-evidence]' },
      error: '[redacted:execution-error]',
      _redacted: '[redacted:unapproved-evidence]',
    });
    expect(serialized).not.toContain('opaque-secret');
  });

  it('bounds and scrubs every locally-authored memory scalar', () => {
    const report = normalizeMemoryActionReport({
      opportunityId: 'opportunity-1',
      status: 'execution_failed',
      title: 'x'.repeat(10_000),
      actionType: 'create_task',
      actionLabel: 'Create task',
      adapterName: 'bad adapter name with spaces',
      policyReason: 'Bearer credential-value',
      routeReason: 'See https://example.test/failure?token=secret',
      summary: 'failed',
      nextStep: 'x'.repeat(10_000),
      attemptedAt: '2026-09-13T00:00:00Z',
    });
    expect(report.title).toHaveLength(1_000);
    expect(report.nextStep).toHaveLength(1_000);
    expect(report.adapterName).toBeUndefined();
    expect(report.policyReason).toBe('Bearer [redacted:credential]');
    expect(report.routeReason).toBe('See [redacted:url]');
    expect(report.attemptedAt).toBe('2026-09-13T00:00:00.000Z');
    expect(normalizeMemoryActionText('')).toBeNull();
  });

  it.each([
    'sk-proj-abc123xyz',
    SYNTHETIC_GITHUB_TOKEN,
    SYNTHETIC_GITHUB_PAT,
    SYNTHETIC_AWS_ACCESS_KEY,
    'xoxb-1234567890-secret',
    SYNTHETIC_PRIVATE_KEY,
  ])('scrubs recognizable credential families without an explicit secret list', (secret) => {
    const normalized = normalizeMemoryActionText(`prefix ${secret} suffix`);
    expect(normalized).toContain('[redacted:credential]');
    expect(normalized).not.toContain(secret);
  });

  it('drops credential-shaped memory identifiers and report linkage', () => {
    const report = normalizeMemoryActionReport({
      opportunityId: 'sk-proj-abc123xyz',
      status: 'execution_failed',
      title: 'Safe title',
      actionType: SYNTHETIC_AWS_ACCESS_KEY,
      actionLabel: 'Safe label',
      decisionId: SYNTHETIC_GITHUB_TOKEN,
      approvalRequestId: SYNTHETIC_GITHUB_PAT,
      executionPlanId: 'ya29.plan-secret',
      summary: 'Safe summary',
      nextStep: 'Review',
      attemptedAt: '2026-09-13T00:00:00Z',
    });
    expect(report.opportunityId).toBe('unknown');
    expect(report.actionType).toBe('unknown');
    expect(report).not.toHaveProperty('decisionId');
    expect(report).not.toHaveProperty('approvalRequestId');
    expect(report).not.toHaveProperty('executionPlanId');
    expect(JSON.stringify(report)).not.toMatch(/sk-proj|AKIA|ghp_|github_pat_|ya29/);
  });

  it('drops adapter plan ids from event payloads and parameters from durable plan steps', () => {
    expect(normalizeExecutionEventPayload({
      adapter_plan_id: 'opaque-secret',
      adapter_used: 'direct',
    })).toEqual({
      adapter_used: 'direct',
      _redacted: '[redacted:unapproved-evidence]',
    });
    expect(normalizeExecutionPlanSteps([{
      type: 'send_email',
      status: 'pending',
      parameters: { accessToken: 'opaque-secret' },
    }, 'opaque-secret'])).toEqual([{ type: 'send_email', status: 'pending' }]);
  });

  it('never persists arbitrary free-form errors', () => {
    expect(normalizeExecutionError('opaque-secret')).toBe('[redacted:execution-error]');
  });
});
