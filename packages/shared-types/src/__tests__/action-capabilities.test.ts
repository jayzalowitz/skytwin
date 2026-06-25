import { describe, expect, it } from 'vitest';
import { buildExecutableActionPlan, OPENCLAW_ACTION_TYPES } from '../action-capabilities.js';

describe('buildExecutableActionPlan', () => {
  it('routes core high-trust actions through IronClaw first', () => {
    expect(buildExecutableActionPlan('draft_email', 'draft a reply')).toMatchObject({
      actionType: 'draft_email',
      primaryAdapter: 'ironclaw',
      readiness: 'known_action_type',
      runtimeVersion: {
        runtime: 'ironclaw',
        stableVersion: '0.29.1',
      },
    });
  });

  it('routes OpenClaw-specific actions through OpenClaw', () => {
    expect(buildExecutableActionPlan('web_search', 'research missing context')).toMatchObject({
      actionType: 'web_search',
      primaryAdapter: 'openclaw',
      readiness: 'known_action_type',
      runtimeVersion: {
        runtime: 'openclaw',
        stableVersion: '2026.6.10',
        prereleaseVersion: '2026.6.11-beta.1',
      },
    });
  });

  it('marks unknown actions as skill gaps to learn or connect', () => {
    expect(buildExecutableActionPlan('update_custom_crm', 'update a custom CRM')).toMatchObject({
      actionType: 'update_custom_crm',
      primaryAdapter: 'openclaw',
      readiness: 'learn_or_connect',
    });
  });

  it('keeps OpenClaw email vocabulary aligned with decision-engine action names', () => {
    expect(OPENCLAW_ACTION_TYPES.has('draft_email')).toBe(true);
    expect(OPENCLAW_ACTION_TYPES.has('send_reply')).toBe(true);
  });
});
