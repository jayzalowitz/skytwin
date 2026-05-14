import { describe, it, expect } from 'vitest';
import {
  classifyDualConfirmStep,
  FIRST_CONFIRMATION_WINDOW_MS,
  type DualConfirmApprovalRow,
} from '../routes/dual-confirm.js';

const NOW = Date.UTC(2026, 4, 14, 12, 0, 0);

function row(overrides: Partial<DualConfirmApprovalRow> = {}): DualConfirmApprovalRow {
  return {
    confirmation_level: 'dual',
    status: 'pending',
    first_confirmed_at: null,
    confirmation_token: null,
    ...overrides,
  };
}

describe('classifyDualConfirmStep', () => {
  it('is not-applicable for a single-confirmation request', () => {
    const step = classifyDualConfirmStep(
      row({ confirmation_level: 'single' }),
      { action: 'approve' },
      NOW,
    );
    expect(step.kind).toBe('not-applicable');
  });

  it('is not-applicable for a reject action even on a dual request', () => {
    // Rejecting an extreme action is always single-step — only approving
    // takes two confirmations.
    const step = classifyDualConfirmStep(row(), { action: 'reject' }, NOW);
    expect(step.kind).toBe('not-applicable');
  });

  it('issues the first confirmation when a dual request has no first_confirmed_at', () => {
    const step = classifyDualConfirmStep(row(), { action: 'approve' }, NOW);
    expect(step.kind).toBe('issue-first');
  });

  it('rejects with 409 when the dual request is no longer pending', () => {
    const step = classifyDualConfirmStep(
      row({ status: 'approved' }),
      { action: 'approve' },
      NOW,
    );
    expect(step).toEqual({
      kind: 'reject',
      httpStatus: 409,
      error: 'Approval request is no longer pending',
    });
  });

  it('proceeds when the second confirmation carries the matching token in-window', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: new Date(NOW - 60_000), // 1 min ago
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve', confirmationToken: 'good-token-abc' },
      NOW,
    );
    expect(step.kind).toBe('proceed');
  });

  it('rejects with 400 when the second confirmation has no token', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: new Date(NOW - 60_000),
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve' },
      NOW,
    );
    expect(step.kind).toBe('reject');
    if (step.kind === 'reject') expect(step.httpStatus).toBe(400);
  });

  it('rejects with 400 when the token does not match', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: new Date(NOW - 60_000),
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve', confirmationToken: 'wrong-token-xyz' },
      NOW,
    );
    expect(step.kind).toBe('reject');
    if (step.kind === 'reject') expect(step.httpStatus).toBe(400);
  });

  it('rejects a token of a different length without throwing (timingSafeEqual guard)', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: new Date(NOW - 60_000),
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve', confirmationToken: 'short' },
      NOW,
    );
    expect(step.kind).toBe('reject');
    if (step.kind === 'reject') expect(step.httpStatus).toBe(400);
  });

  it('rejects an empty stored token even if an empty token is provided', () => {
    // A null/empty stored token must never be satisfiable.
    const step = classifyDualConfirmStep(
      row({ first_confirmed_at: new Date(NOW - 60_000), confirmation_token: null }),
      { action: 'approve', confirmationToken: '' },
      NOW,
    );
    expect(step.kind).toBe('reject');
  });

  it('rejects with 410 when the first confirmation is past the 10-minute window', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: new Date(NOW - FIRST_CONFIRMATION_WINDOW_MS - 1000),
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve', confirmationToken: 'good-token-abc' },
      NOW,
    );
    expect(step.kind).toBe('reject');
    if (step.kind === 'reject') expect(step.httpStatus).toBe(410);
  });

  it('accepts a confirmation exactly at the window boundary', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: new Date(NOW - FIRST_CONFIRMATION_WINDOW_MS),
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve', confirmationToken: 'good-token-abc' },
      NOW,
    );
    expect(step.kind).toBe('proceed');
  });

  it('rejects with 410 when first_confirmed_at is an unparseable value', () => {
    const step = classifyDualConfirmStep(
      row({
        first_confirmed_at: 'not-a-date',
        confirmation_token: 'good-token-abc',
      }),
      { action: 'approve', confirmationToken: 'good-token-abc' },
      NOW,
    );
    expect(step.kind).toBe('reject');
    if (step.kind === 'reject') expect(step.httpStatus).toBe(410);
  });
});
