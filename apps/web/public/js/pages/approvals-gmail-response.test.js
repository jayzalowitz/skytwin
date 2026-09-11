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
      actionType: 'archive_email',
      description: 'Propose moving this message out of the Inbox.',
      domain: 'email',
      parameters: {},
      confidence: 'moderate',
    },
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
  const button = document.querySelector(
    `[data-action="approval"][data-decision="${action}"]`,
  );
  button.click();
  await vi.waitFor(() => expect(api.respondToApproval).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
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
    api.respondToApproval.mockResolvedValueOnce({
      requestId: APPROVAL_ID,
      action: 'approve',
      approval: { id: APPROVAL_ID, status: 'approved' },
      execution: { status: 'completed' },
    });

    await renderAndClick('approve');
    await vi.waitFor(() => expect(api.fetchTrustProgress).toHaveBeenCalledTimes(2));

    expect(showToast).toHaveBeenCalledWith('Got it — I\'ll handle this for you.', {
      kind: 'success',
    });
  });
});
