// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  parseWatchText: vi.fn(),
  fetchWatches: vi.fn(),
  createWatch: vi.fn(),
  updateWatchStatus: vi.fn(),
  updateWatchSpec: vi.fn(),
  deleteWatch: vi.fn(),
  fetchWatchRuns: vi.fn(),
  fetchAdaptiveWorkflowReadiness: vi.fn(),
  createAdaptiveSignalDigestDraft: vi.fn(),
  fetchAdaptiveWorkflowDetail: vi.fn(),
  fetchAdaptiveWorkflowResumableDraft: vi.fn(),
  createAdaptiveWorkflowFeedbackRevision: vi.fn(),
  activateAdaptiveWorkflow: vi.fn(),
  rollbackAdaptiveWorkflow: vi.fn(),
}));

vi.mock('../api-client.js', () => ({
  ...api,
  createClientRequestId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
  escapeHtml: (value) => {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  renderApiError: () => '<div>load error</div>',
  wireApiRetry: vi.fn(),
}));
vi.mock('../sample-session.js', () => ({ getEffectiveUserId: () => '' }));
vi.mock('../toast.js', () => ({ showToast: vi.fn() }));

import { renderWatches } from './watches.js';

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SPEC = {
  name: 'Morning invoice digest',
  cadence: 'daily',
  hourOfDay: 9,
  action: 'digest',
  filter: { sources: ['gmail'], fromContains: [], keywords: ['invoice'], domains: [] },
};

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  document.body.innerHTML = '<main id="page-content"></main>';
  window.location.hash = '#/watches';
  localStorage.clear();
  api.fetchWatches.mockResolvedValue({ watches: [] });
  api.fetchAdaptiveWorkflowResumableDraft.mockResolvedValue({ candidate: null });
  api.fetchAdaptiveWorkflowReadiness.mockResolvedValue({
    readiness: {
      state: 'ready', reasoningMode: 'on_device', provider: 'embedded', model: 'managed',
    },
  });
});

describe('adaptive Watches authoring', () => {
  it('resumes a durable unactivated proposal after reload', async () => {
    api.fetchAdaptiveWorkflowResumableDraft.mockResolvedValue({
      candidate: {
        kind: 'initial',
        workflow: { id: 'workflow-resume', activeVersionId: null },
        version: { id: 'version-resume', versionNumber: 1 },
        proposal: { id: 'proposal-resume' },
        preview: {
          routineSpec: SPEC,
          summaryInstruction: 'Summarize invoice totals.',
          replay: {
            dataAccess: { status: 'available', synthetic: false, recordsEvaluated: 0 },
            schedule: { timezone: 'UTC', nextRunAt: '2026-09-17T09:00:00.000Z' },
            simulation: { caughtCount: 0, ignoredCount: 0, examples: [] },
            synthesis: { available: false, text: 'AI summary unavailable' },
          },
        },
      },
    });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-resume');

    expect(container.textContent).toContain('Proposed version 1');
    expect(container.textContent).toContain('Nothing runs until you activate this version.');
  });

  it('preserves a draft, renders real replay evidence safely, and activates with CAS identity', async () => {
    api.createAdaptiveSignalDigestDraft.mockResolvedValue({
      success: true,
      workflow: { id: 'workflow-1', activeVersionId: null },
      version: { id: 'version-1', versionNumber: 1 },
      proposal: { id: 'proposal-1' },
      preview: {
        routineSpec: SPEC,
        summaryInstruction: 'Summarize invoice totals and due dates.',
        replay: {
          dataAccess: {
            status: 'available', synthetic: false, recordsFound: 12, recordsEvaluated: 12,
          },
          window: {
            start: '2026-09-09T12:00:00.000Z', end: '2026-09-16T12:00:00.000Z',
            bounds: '(start,end]',
          },
          schedule: {
            timezone: 'America/Los_Angeles',
            nextRunAt: '2026-09-17T16:00:00.000Z',
          },
          simulation: {
            caughtCount: 2,
            ignoredCount: 10,
            examples: [{
              signalId: 'signal-1', source: 'gmail', from: 'billing@example.com',
              timestamp: '2026-09-16T11:00:00.000Z', title: '<img src=x onerror=alert(1)> Invoice 104',
            }],
          },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
    });
    api.activateAdaptiveWorkflow.mockResolvedValue({ success: true });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-ready');
    expect(container.textContent).toContain('On-device model');

    const input = container.querySelector('[data-region="watch-input"]');
    input.value = 'Every morning summarize invoice email';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem('skytwin_adaptive_watch_draft_user-ready')).toBe(input.value);
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(api.createAdaptiveSignalDigestDraft).toHaveBeenCalledWith(
      'user-ready',
      input.value,
      true,
      'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
    );
    expect(container.textContent).toContain('2Caught');
    expect(container.textContent).toContain('10Ignored');
    expect(container.textContent).toContain('Recent real signals');
    expect(container.textContent).toContain('Real, not synthetic');
    expect(container.textContent).toContain('America/Los_Angeles');
    expect(container.textContent).toContain('Next');
    expect(container.textContent).toContain('AI summary unavailable');
    expect(container.textContent).toContain('<img src=x onerror=alert(1)> Invoice 104');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.watch-preview-state')?.getAttribute('role')).toBe('status');
    expect(document.activeElement?.getAttribute('data-action')).toBe('adaptive-activate');

    container.querySelector('[data-action="adaptive-activate"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    await tick();

    expect(api.activateAdaptiveWorkflow).toHaveBeenCalledWith('user-ready', 'workflow-1', {
      versionId: 'version-1',
      proposalId: 'proposal-1',
      expectedActiveVersionId: null,
    });
    expect(api.fetchWatches).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('skytwin_adaptive_watch_draft_user-ready')).toBeNull();
  });

  it('offers the deterministic fallback only when no model is configured', async () => {
    api.fetchAdaptiveWorkflowReadiness.mockResolvedValue({
      readiness: { state: 'setup_required', reason: 'No provider', retryable: false },
    });
    api.parseWatchText.mockResolvedValue({ matched: true, spec: SPEC, warnings: [] });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-no-model');
    expect(container.textContent).toContain('Deterministic Watch fallback');
    expect(container.textContent).toContain('not AI-authored');

    const input = container.querySelector('[data-region="watch-input"]');
    input.value = 'Every morning summarize invoice email';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(api.parseWatchText).toHaveBeenCalledWith(input.value);
    expect(api.createAdaptiveSignalDigestDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Activate');
  });

  it('preserves typed readiness states carried by non-2xx API responses', async () => {
    api.fetchAdaptiveWorkflowReadiness.mockRejectedValue(Object.assign(
      new Error('Request failed'),
      {
        responseBody: {
          readiness: {
            state: 'runtime_unavailable',
            reason: 'Local runtime is not running',
            retryable: true,
          },
        },
      },
    ));

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-runtime-down');
    expect(container.textContent).toContain('Runtime unavailable');
    expect(container.textContent).toContain('runtime is not ready');
    expect(container.querySelector('[data-region="watch-input"]').disabled).toBe(true);
    expect(container.textContent).not.toContain('Deterministic Watch fallback');
  });

  it('distinguishes model artifact setup from a missing runtime binary', async () => {
    api.fetchAdaptiveWorkflowReadiness.mockRejectedValue(Object.assign(
      new Error('Request failed'),
      {
        responseBody: {
          readiness: {
            state: 'artifact_unavailable',
            reason: 'Managed artifact failed verification',
            retryable: false,
          },
        },
      },
    ));

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-artifact-missing');

    expect(container.textContent).toContain('Model artifact unavailable');
    expect(container.textContent).toContain('artifact is missing or failed verification');
    expect(container.querySelector('a[href="#/settings"]')?.textContent).toContain('Open settings');
    expect(container.textContent).not.toContain('Runtime unavailable');
    expect(container.textContent).not.toContain('Deterministic Watch fallback');
  });

  it('asks one authoring clarification without losing the draft or AI readiness', async () => {
    api.createAdaptiveSignalDigestDraft.mockRejectedValueOnce(Object.assign(
      new Error('Clarification required'),
      {
        responseBody: {
          failure: {
            state: 'clarification_required',
            question: 'Which finance team or sender should this Watch match?',
          },
        },
      },
    )).mockResolvedValueOnce({
      success: true,
      workflow: { id: 'workflow-clarified', activeVersionId: null },
      version: { id: 'version-clarified', versionNumber: 1 },
      proposal: { id: 'proposal-clarified' },
      preview: {
        routineSpec: SPEC,
        replay: {
          dataAccess: { status: 'available', synthetic: false, recordsEvaluated: 1 },
          simulation: { caughtCount: 1, ignoredCount: 0, examples: [] },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
    });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-clarify');
    const input = container.querySelector('[data-region="watch-input"]');
    input.value = 'Summarize finance email every morning';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(container.textContent).toContain('Which finance team or sender should this Watch match?');
    expect(container.textContent).toContain('AI configured');
    expect(container.querySelector('.watch-preview-clarification')?.getAttribute('role')).toBe('status');
    expect(container.querySelector('.watch-preview-error')).toBeNull();
    expect(container.querySelector('[data-region="watch-input"]').value).toBe(input.value);
    expect(document.activeElement?.getAttribute('data-region')).toBe('watch-input');
    expect(localStorage.getItem('skytwin_adaptive_watch_draft_user-clarify')).toBe(input.value);

    const answerInput = container.querySelector('[data-region="watch-input"]');
    answerInput.value = 'Messages from the controller team.';
    answerInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.textContent).toContain('Which finance team or sender should this Watch match?');
    expect(container.textContent).toContain('Answer the clarification');
    answerInput.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(api.createAdaptiveSignalDigestDraft).toHaveBeenNthCalledWith(
      2,
      'user-clarify',
      [
        'Original request:',
        'Summarize finance email every morning',
        '',
        'Clarification question:',
        'Which finance team or sender should this Watch match?',
        '',
        'User answer:',
        'Messages from the controller team.',
      ].join('\n'),
      false,
      'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
    );
    expect(container.textContent).toContain('Proposed version 1');
  });

  it('drops a late authoring response after the current user changes', async () => {
    let resolveAuthoring;
    api.createAdaptiveSignalDigestDraft.mockReturnValue(new Promise((resolve) => {
      resolveAuthoring = resolve;
    }));
    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-a');
    const input = container.querySelector('[data-region="watch-input"]');
    input.value = 'Every morning summarize private finance email';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    await renderWatches(container, 'user-b');
    resolveAuthoring({
      success: true,
      workflow: { id: 'workflow-a', activeVersionId: null },
      version: { id: 'version-a', versionNumber: 1 },
      proposal: { id: 'proposal-a' },
      preview: {
        routineSpec: SPEC,
        replay: {
          dataAccess: { status: 'available', synthetic: false, recordsEvaluated: 1 },
          simulation: {
            caughtCount: 1, ignoredCount: 0,
            examples: [{ title: 'USER A PRIVATE INVOICE', source: 'gmail' }],
          },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
    });
    await tick();

    expect(container.textContent).not.toContain('USER A PRIVATE INVOICE');
    expect(container.querySelector('[data-region="watch-input"]').value).toBe('');
  });

  it('turns an adaptive edit into a reviewed immutable version before activation', async () => {
    api.fetchWatches.mockResolvedValue({
      watches: [{
        id: 'watch-1', workflowId: 'workflow-1', name: SPEC.name,
        sourceText: 'Projection label that must not become edit input', status: 'active',
        ...SPEC, lastRunAt: null, nextRunAt: null,
      }],
    });
    api.fetchAdaptiveWorkflowDetail.mockResolvedValue({
      activeVersion: {
        id: 'version-1',
        canonicalPayload: {
          ...SPEC,
          summaryInstruction: 'Summarize invoice totals and due dates.',
        },
      },
    });
    api.createAdaptiveWorkflowFeedbackRevision.mockResolvedValue({
      success: true,
      workflow: { id: 'workflow-1', activeVersionId: 'version-1' },
      version: {
        id: 'version-2', versionNumber: 2,
        canonicalPayload: {
          ...SPEC,
          name: 'Invoice and receipt digest',
          summaryInstruction: 'Summarize invoice totals and due dates.',
        },
        contentHash: 'b'.repeat(64),
      },
      proposal: { id: 'proposal-2' },
      diff: {
        changed: true,
        metadataChanged: true,
        authorityRelevantBroadening: true,
        trigger: { changed: false },
        filter: { changed: true, classification: 'broadening', reasons: ['keywords added: receipt'] },
        dataScope: { changed: false },
        destination: { changed: false },
      },
      replay: {
        before: { simulation: { caughtCount: 2 } },
        after: {
          dataAccess: { status: 'available', synthetic: false, recordsEvaluated: 12 },
          window: { start: '2026-09-09T12:00:00Z', end: '2026-09-16T12:00:00Z' },
          simulation: { caughtCount: 4, ignoredCount: 8, examples: [] },
          synthesis: { available: false, text: 'AI summary unavailable' },
        },
      },
    });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-edit');
    container.querySelector('[data-action="watch-edit"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(api.fetchAdaptiveWorkflowDetail).toHaveBeenCalledWith('user-edit', 'workflow-1');
    expect(container.querySelector('[data-action="watch-delete"]')).toBeNull();

    const input = container.querySelector('[data-region="watch-input"]');
    expect(input.value).toBe('');
    input.value = 'Every morning summarize invoice and receipt email';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(JSON.parse(localStorage.getItem('skytwin_adaptive_watch_edit_user-edit'))).toMatchObject({
      workflowId: 'workflow-1',
      parentVersionId: 'version-1',
      feedback: 'Every morning summarize invoice and receipt email',
    });
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(api.createAdaptiveWorkflowFeedbackRevision).toHaveBeenCalledWith(
      'user-edit',
      'workflow-1',
      'version-1',
      'Every morning summarize invoice and receipt email',
      'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
    );
    expect(container.textContent).toContain('What changed');
    expect(container.textContent).toContain('broadens what the Watch can match');
    expect(container.textContent).toContain('Previous version caught 2 · proposed version catches 4');
    expect(container.textContent).toContain('Activate version 2');
  });

  it('shows immutable history and rolls back only a previously active version with CAS', async () => {
    api.fetchWatches.mockResolvedValue({
      watches: [{
        id: 'watch-history', workflowId: 'workflow-history', name: SPEC.name,
        status: 'active', ...SPEC, lastRunAt: null, nextRunAt: null,
      }],
    });
    const versions = [
      { id: 'version-1', versionNumber: 1, canonicalPayload: SPEC, createdAt: '2026-09-14T09:00:00Z' },
      { id: 'version-2', versionNumber: 2, canonicalPayload: { ...SPEC, name: 'Unused proposal' }, createdAt: '2026-09-15T09:00:00Z' },
      { id: 'version-3', versionNumber: 3, canonicalPayload: { ...SPEC, name: 'Current digest' }, createdAt: '2026-09-16T09:00:00Z' },
    ];
    api.fetchAdaptiveWorkflowDetail
      .mockResolvedValueOnce({
        workflow: { id: 'workflow-history', activeVersionId: 'version-3' },
        activeVersion: versions[2],
        versions,
        activationEvents: [
          { id: 'event-1', activatedVersionId: 'version-1', kind: 'activate' },
          { id: 'event-3', activatedVersionId: 'version-3', kind: 'activate' },
        ],
      })
      .mockResolvedValueOnce({
        workflow: { id: 'workflow-history', activeVersionId: 'version-1' },
        activeVersion: versions[0],
        versions,
        activationEvents: [
          { id: 'event-1', activatedVersionId: 'version-1', kind: 'activate' },
          { id: 'event-3', activatedVersionId: 'version-3', kind: 'activate' },
          { id: 'event-rollback', activatedVersionId: 'version-1', kind: 'rollback' },
        ],
      });
    api.rollbackAdaptiveWorkflow.mockResolvedValue({ success: true });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-history');
    const historyButton = container.querySelector('[data-action="watch-history"]');
    expect(historyButton?.getAttribute('aria-controls')).toBe('watch-history-workflow-history');
    historyButton
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    expect(container.textContent).toContain('Versions stay immutable');
    expect(document.activeElement?.getAttribute('data-region')).toBe('watch-history');
    expect(container.textContent).toContain('Unused proposal · digest · daily');
    expect(container.textContent).toContain('Never active');
    expect(container.querySelector('[data-version-id="version-2"]')).toBeNull();

    container.querySelector('[data-version-id="version-1"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(api.rollbackAdaptiveWorkflow).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Roll back to version 1?');
    expect(document.activeElement?.getAttribute('data-region')).toBe('watch-rollback-confirmation');

    container.querySelector('[data-action="watch-rollback-confirm"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    await tick();

    expect(api.rollbackAdaptiveWorkflow).toHaveBeenCalledWith('user-history', 'workflow-history', {
      versionId: 'version-1',
      expectedActiveVersionId: 'version-3',
    });
    const rolledBackVersion = [...container.querySelectorAll('.watch-version-item')]
      .find((item) => item.textContent.includes('Version 1'));
    expect(rolledBackVersion?.textContent).toContain('Current');
    expect(document.activeElement?.getAttribute('data-region')).toBe('watch-history');
  });

  it('does not render late version history after the current user changes', async () => {
    let resolveHistory;
    api.fetchWatches
      .mockResolvedValueOnce({
        watches: [{
          id: 'watch-private', workflowId: 'workflow-private', name: 'Private finance digest',
          status: 'active', ...SPEC,
        }],
      })
      .mockResolvedValueOnce({ watches: [] });
    api.fetchAdaptiveWorkflowDetail.mockReturnValue(new Promise((resolve) => {
      resolveHistory = resolve;
    }));

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-history-a');
    container.querySelector('[data-action="watch-history"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    await renderWatches(container, 'user-history-b');
    resolveHistory({
      workflow: { id: 'workflow-private', activeVersionId: 'private-version' },
      versions: [{
        id: 'private-version', versionNumber: 1,
        canonicalPayload: { ...SPEC, name: 'USER A PRIVATE HISTORY' },
      }],
      activationEvents: [{ activatedVersionId: 'private-version', kind: 'activate' }],
    });
    await tick();

    expect(container.textContent).not.toContain('USER A PRIVATE HISTORY');
    expect(container.textContent).toContain('No Watches yet.');
  });

  it('offers safe replacement recovery for a quarantined legacy Watch', async () => {
    api.fetchWatches.mockResolvedValue({
      watches: [{
        id: 'watch-quarantine',
        workflowId: 'workflow-quarantine',
        workflowVersionId: 'version-quarantine',
        workflowProviderKey: 'legacy_watch.quarantine.v1',
        name: 'Legacy inbox digest',
        sourceText: 'Old unsupported Watch',
        status: 'paused',
        ...SPEC,
      }],
    });
    api.deleteWatch.mockResolvedValue({ success: true });

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-quarantine');

    const row = container.querySelector('[data-watch-id="watch-quarantine"]');
    expect(row?.textContent).toContain('Needs replacement');
    expect(row?.textContent).toContain(
      'This legacy Watch could not be safely migrated. Delete it and create a replacement.',
    );
    expect(row?.querySelector('[data-action="watch-history"]')).toBeNull();
    expect(row?.querySelector('[data-action="watch-edit"]')).toBeNull();
    expect(row?.querySelector('[data-action="watch-status"]')).toBeNull();
    expect(row?.querySelector('[data-action="watch-runs"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(row?.querySelector('[data-action="watch-runs"]')?.getAttribute('aria-controls'))
      .toBe('watch-runs-watch-quarantine');

    const deleteButton = row?.querySelector('[data-action="watch-delete"]');
    deleteButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(api.deleteWatch).not.toHaveBeenCalled();

    let confirmation = container.querySelector('[data-region="watch-delete-confirmation"]');
    expect(confirmation?.textContent).toContain('quarantined Watch and its migration-only version lineage');
    expect(confirmation?.textContent).toContain('This cannot be undone.');
    expect(document.activeElement).toBe(confirmation);

    confirmation?.querySelector('[data-action="watch-delete-cancel"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement?.getAttribute('data-action')).toBe('watch-delete');
    expect(api.deleteWatch).not.toHaveBeenCalled();

    container.querySelector('[data-action="watch-delete"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    confirmation = container.querySelector('[data-region="watch-delete-confirmation"]');
    confirmation?.querySelector('[data-action="watch-delete-confirm"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    await tick();

    expect(api.deleteWatch).toHaveBeenCalledWith('user-quarantine', 'watch-quarantine');
  });

  it('keeps the destructive confirmation open and focused when deletion fails', async () => {
    api.fetchWatches.mockResolvedValue({
      watches: [{
        id: 'watch-delete-failure', name: 'Invoice digest', sourceText: 'Invoices',
        status: 'paused', workflowId: null, ...SPEC,
      }],
    });
    api.deleteWatch.mockRejectedValue(new Error('Delete service unavailable'));

    const container = document.getElementById('page-content');
    await renderWatches(container, 'user-delete-failure');
    container.querySelector('[data-action="watch-delete"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    container.querySelector('[data-action="watch-delete-confirm"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();

    const confirmation = container.querySelector('[data-region="watch-delete-confirmation"]');
    expect(confirmation?.querySelector('[role="alert"]')?.textContent)
      .toContain('Delete service unavailable');
    expect(document.activeElement).toBe(confirmation);
    expect(container.querySelector('[data-watch-id="watch-delete-failure"]')).not.toBeNull();
  });
});
