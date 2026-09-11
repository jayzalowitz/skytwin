// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchPendingApprovals: vi.fn(),
  fetchApprovalHistory: vi.fn(),
  respondToApproval: vi.fn(),
  fetchTrustProgress: vi.fn(),
}));
const showToast = vi.hoisted(() => vi.fn());

vi.mock('../api-client.js', () => ({
  ...api,
  escapeHtml: (value) => String(value ?? ''),
  renderApiError: () => '<div>error</div>',
  wireApiRetry: vi.fn(),
}));
vi.mock('../components/progress-bar.js', () => ({
  renderTrustProgress: () => '<div class="trust-progress">progress</div>',
}));
vi.mock('../components/draft-card.js', () => ({
  renderDraftEmailCard: vi.fn(),
  readDraftEditedBody: () => null,
}));
vi.mock('../storage-keys.js', () => ({
  KEY_TOUR_MODE: 'tour-mode',
  firstApprovalIntroSeenKey: () => 'intro-seen',
}));
vi.mock('../toast.js', () => ({ showToast }));
vi.mock('../format.js', () => ({ formatMoney: (value) => String(value) }));

import { renderApprovals } from './approvals.js';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function pendingApproval() {
  return {
    id: APPROVAL_ID,
    userId: USER_ID,
    status: 'pending',
    urgency: 'medium',
    reason: 'Review this Inbox proposal.',
    requestedAt: '2026-09-11T19:00:00.000Z',
    confirmationLevel: 'single',
    candidateAction: {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      decisionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      actionType: 'archive_email',
      description: 'Archive this Inbox message',
      domain: 'email',
      parameters: {
        schema: 'gmail_inbox_mutation_v1',
        messageRefId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        operation: 'archive',
      },
      estimatedCostCents: 0,
      costZeroIntent: 'verified_zero',
      reversible: true,
      confidence: 'moderate',
      reasoning: 'The owned Inbox signal is eligible for a reversible archive proposal.',
      provenance: 'untrusted_external',
    },
  };
}

function historyApproval(status) {
  return {
    ...pendingApproval(),
    status,
    respondedAt: '2026-09-11T20:00:00.000Z',
    response: { action: status === 'approved' ? 'approve' : 'reject', reason: null },
  };
}

function gmailResponse(action) {
  return {
    workflow: 'gmail_archive',
    status: 'approval_recorded',
    requestId: APPROVAL_ID,
    action,
    approval: { id: APPROVAL_ID, status: action === 'approve' ? 'approved' : 'rejected' },
    execution: null,
    replayed: false,
  };
}

async function renderAndClick(action) {
  const container = document.getElementById('page-content');
  await renderApprovals(container, USER_ID);
  const initialCardText = document.getElementById(`approval-${APPROVAL_ID}`)?.textContent;
  const button = document.querySelector(
    `[data-action="approval"][data-decision="${action}"]`,
  );
  button.click();
  await vi.waitFor(() => expect(api.respondToApproval).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
  return initialCardText;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<main id="page-content"></main>';
  window.location.hash = '#/approvals';
  api.fetchPendingApprovals.mockResolvedValue({ approvals: [pendingApproval()] });
  api.fetchApprovalHistory.mockResolvedValue({ approvals: [] });
  api.fetchTrustProgress.mockResolvedValue({ approvalCount: 2, currentTier: 'observer' });
});

describe('Gmail archive consent-only approval UI', () => {
  it('describes the pending card as a record-only review', async () => {
    await renderApprovals(document.getElementById('page-content'), USER_ID);

    const card = document.getElementById(`approval-${APPROVAL_ID}`);
    expect(card?.textContent).toContain('Review Inbox archive proposal');
    expect(card?.textContent).toContain('Record approval');
    expect(card?.textContent).toContain('Record rejection');
    expect(card?.textContent).toContain('What this records');
    expect(card?.textContent).toContain('No mailbox change is made at this step.');
    expect(card?.querySelector(`#reason-${APPROVAL_ID}`)?.getAttribute('placeholder'))
      .toBe('Add a note (optional)');
    expect(card?.textContent).not.toContain('Yes, do it');
    expect(card?.textContent).not.toContain('If you approve — what happens');
    expect(card?.textContent).not.toContain('via Gmail API');
  });

  it.each([
    ['approve', 'Approval recorded. No mailbox change has been made.'],
    ['reject', 'Rejection recorded. No mailbox change has been made.'],
  ])('uses literal %s copy and does not imply feedback or execution', async (action, message) => {
    api.respondToApproval.mockResolvedValueOnce(gmailResponse(action));

    await renderAndClick(action);

    expect(showToast).toHaveBeenCalledWith(message, { kind: 'info' });
    expect(api.fetchTrustProgress).toHaveBeenCalledTimes(1);
    expect(document.querySelector(`#approval-${APPROVAL_ID} .approval-actions`)?.textContent)
      .toContain(action === 'approve' ? 'Approved' : 'Rejected');
  });

  it('retains the trust refresh for an ordinary approved action', async () => {
    const ordinary = pendingApproval();
    ordinary.candidateAction = {
      actionType: 'label_email',
      description: 'Label this email',
      domain: 'email',
      parameters: { label: 'Updates' },
      confidence: 'moderate',
    };
    api.fetchPendingApprovals.mockResolvedValueOnce({ approvals: [ordinary] });
    api.respondToApproval.mockResolvedValueOnce({
      requestId: APPROVAL_ID,
      action: 'approve',
      approval: { id: APPROVAL_ID, status: 'approved' },
      execution: { status: 'completed' },
    });

    const initialCardText = await renderAndClick('approve');
    await vi.waitFor(() => expect(api.fetchTrustProgress).toHaveBeenCalledTimes(2));

    expect(showToast).toHaveBeenCalledWith('Got it — I\'ll handle this for you.', {
      kind: 'success',
    });
    expect(initialCardText).toContain('Yes, do it');
  });

  it.each([
    ['approved', 'Approval recorded'],
    ['rejected', 'Rejection recorded'],
  ])('renders %s history without claiming execution or learning', async (status, statusCopy) => {
    api.fetchPendingApprovals.mockResolvedValueOnce({ approvals: [] });
    api.fetchApprovalHistory.mockResolvedValueOnce({ approvals: [historyApproval(status)] });

    await renderApprovals(document.getElementById('page-content'), USER_ID);

    const pageText = document.getElementById('page-content')?.textContent;
    expect(pageText).toContain('Review Inbox archive proposal');
    expect(pageText).toContain('What was recorded');
    expect(pageText).toContain(statusCopy);
    expect(pageText).toContain('Mailbox unchanged');
    expect(pageText).not.toContain('Executed via worker');
    expect(pageText).not.toContain('via Gmail API');
  });
});
