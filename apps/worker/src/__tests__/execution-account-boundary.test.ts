import { describe, expect, it } from 'vitest';
import { ConfidenceLevel, type CandidateAction } from '@skytwin/shared-types';
import { createWorkerExecutionAdmissionGuard } from '../execution-account-boundary.js';

function action(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    id: 'action-1',
    decisionId: 'decision-1',
    actionType: 'create_task',
    description: 'Create a local task',
    domain: 'tasks',
    parameters: {},
    estimatedCostCents: 0,
    reversible: true,
    confidence: ConfidenceLevel.HIGH,
    reasoning: 'Requested by the user',
    provenance: 'user_originated',
    ...overrides,
  };
}

describe('createWorkerExecutionAdmissionGuard', () => {
  it('denies an account-backed selected adapter for a neutral action while disabled', async () => {
    const guard = createWorkerExecutionAdmissionGuard('disabled');

    expect(await guard(action(), 'user-1', 'outlook')).toMatchObject({
      allowed: false,
    });
  });

  it.each([
    'groups_events_list', 'users.list', 'users.messages.send',
    'me.messages.send', 'me.events.list', 'me.drive.root.children',
    'me.mail.read', 'me.calendar.get', 'group.members.list',
    'groups.calendar.get', 'groups.threads.list', 'groups.conversations.list',
    'users.byUserId.messages.list', 'users/123/messages/list',
    'groups.byGroupId.events.list', 'groups/123/threads/list', 'groups.list',
    'me.sendMail', 'users.sendMail', 'me.contacts.list', 'me.people.list',
    'me.todo.lists', 'me.memberOf', 'me.photo.get', 'me.mailboxSettings.get',
    'get_me_messages', 'list_users_messages', 'me__messages_list',
    'get_me', 'list_users', 'users/123', 'users.byUserId.get',
    'groups/123', 'groups.byGroupId.get', 'users.delta', 'groups.delta',
    'me.manager.get', 'me.presence.get', 'me.planner.tasks.list',
    'me.authentication.methods.list', 'me.onenote.notebooks.list',
    'users.byUserId.authentication.methods.list', 'users.byUserId.manager.get',
    'groups.byGroupId.owners.list',
    'send_user_mail', 'sendUserMail', 'add_group_member', 'addGroupMember',
    'invite_user', 'assign_user_license', 'revoke_user_sessions', 'export_users',
    'user_preferences_update', 'users_export', 'me_profile_update',
    'group_project_create', 'user', 'group',
  ])('denies the account action %s before adapter selection while disabled', async (actionType) => {
    const guard = createWorkerExecutionAdmissionGuard('disabled');

    expect(await guard(action({ actionType }), 'user-1'))
      .toMatchObject({ allowed: false });
  });

  it('allows a neutral action through a neutral selected adapter while disabled', async () => {
    const guard = createWorkerExecutionAdmissionGuard('disabled');

    expect(await guard(action(), 'user-1', 'direct')).toEqual({ allowed: true });
  });

  it('preserves both action and adapter paths in exact experimental mode', async () => {
    const guard = createWorkerExecutionAdmissionGuard('experimental');

    expect(await guard(
      action({ actionType: 'send_email', domain: 'email' }),
      'user-1',
      'outlook',
    )).toEqual({ allowed: true });
  });
});
