import type { CandidateAction } from '@skytwin/shared-types';
import {
  SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
  SKYTWIN_REPO_URL,
  appendSkyTwinEmailAttribution,
  resolveEmailAttributionEnabled,
} from '@skytwin/shared-types';
import type { UserRow } from '@skytwin/db';

export function isOutboundEmailAction(actionType: string): boolean {
  return [
    'draft_email',
    'send_email',
    'send_reply',
    'reply_email',
    'forward_email',
  ].includes(actionType);
}

export function annotateEmailAttributionPreview(
  parameters: Record<string, unknown>,
  user: Pick<UserRow, 'autonomy_settings'> | null | undefined,
): Record<string, unknown> {
  return {
    ...parameters,
    emailAttributionSignatureEnabled: resolveEmailAttributionEnabled(
      user?.autonomy_settings,
    ),
    emailAttributionSignatureText: SKYTWIN_EMAIL_ATTRIBUTION_TEXT,
    emailAttributionRepoUrl: SKYTWIN_REPO_URL,
  };
}

export function prepareEmailActionForExecution(
  action: CandidateAction,
  user: Pick<UserRow, 'autonomy_settings'> | null | undefined,
): void {
  if (!isOutboundEmailAction(action.actionType)) return;

  const enabled = resolveEmailAttributionEnabled(user?.autonomy_settings);
  action.parameters['emailAttributionSignatureEnabled'] = enabled;
  action.parameters['emailAttributionSignatureText'] = SKYTWIN_EMAIL_ATTRIBUTION_TEXT;
  action.parameters['emailAttributionRepoUrl'] = SKYTWIN_REPO_URL;

  for (const key of ['draftBody', 'body', 'messageBody']) {
    const value = action.parameters[key];
    if (typeof value === 'string') {
      action.parameters[key] = appendSkyTwinEmailAttribution(value, { enabled });
    }
  }

  if (action.actionType === 'draft_email') {
    action.parameters['originalActionType'] = 'draft_email';
    action.parameters['replyType'] ??= 'reviewed_draft';
    action.actionType = 'send_reply';
    action.reversible = false;
    action.description = action.description.replace(/^Draft\b/i, 'Send');
  }
}
