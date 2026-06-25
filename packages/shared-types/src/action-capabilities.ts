import {
  getExecutionRuntimeVersionSummary,
  type ExecutionRuntimeVersionSummary,
} from './execution-runtime-versions.js';

export type ExecutionAdapterName = 'ironclaw' | 'openclaw' | 'direct' | 'mcp-host';

export type ActionPlanReadiness = 'known_action_type' | 'learn_or_connect';

export interface ExecutableActionPlan {
  actionType: string;
  label: string;
  primaryAdapter: 'ironclaw' | 'openclaw';
  fallbackAdapters: ExecutionAdapterName[];
  readiness: ActionPlanReadiness;
  learnTarget?: string;
  runtimeVersion: ExecutionRuntimeVersionSummary;
  adapterRationale: string;
}

export const IRONCLAW_CORE_ACTION_TYPES = new Set([
  'archive_email',
  'label_email',
  'send_reply',
  'reply_email',
  'draft_email',
  'send_email',
  'delete_email',
  'accept_invite',
  'decline_invite',
  'decline_event',
  'propose_alternative',
  'tentative_accept',
  'acknowledge',
  'dismiss',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'reschedule_event',
  'categorize_transaction',
  'record_expense',
  'set_budget_alert',
  'flag_suspicious_transaction',
  'create_task',
  'complete_task',
  'assign_task',
  'set_reminder',
  'update_task_priority',
  'organize_file',
  'share_document',
  'summarize_document',
  'create_document',
  'create_note',
]);

export const OPENCLAW_ACTION_TYPES = new Set([
  'send_email',
  'archive_email',
  'label_email',
  'reply_email',
  'send_reply',
  'draft_email',
  'forward_email',
  'snooze_email',
  'unsubscribe_email',
  'create_filter',
  'move_to_folder',
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'reschedule_event',
  'decline_event',
  'set_out_of_office',
  'block_focus_time',
  'find_meeting_time',
  'social_media_post',
  'web_search',
  'data_analysis',
  'content_generation',
  'cancel_subscription',
  'downgrade_subscription',
  'renew_subscription',
  'reorder_items',
  'add_to_list',
  'book_travel',
  'set_travel_alert',
  'pay_bill',
  'categorize_transaction',
  'flag_suspicious_transaction',
  'transfer_funds',
  'record_expense',
  'set_budget_alert',
  'set_thermostat',
  'toggle_lights',
  'lock_door',
  'set_alarm',
  'run_routine',
  'create_task',
  'complete_task',
  'assign_task',
  'set_reminder',
  'update_task_priority',
  'draft_social_post',
  'schedule_social_post',
  'respond_to_mention',
  'mute_conversation',
  'share_content',
  'organize_file',
  'share_document',
  'summarize_document',
  'create_document',
  'log_health_metric',
  'set_medication_reminder',
  'book_appointment',
  'reschedule_appointment',
  'flag_health_anomaly',
  'create_note',
  'escalate_to_user',
  'snooze_reminder',
  'save_option',
  'place_order',
]);

export function buildExecutableActionPlan(actionType: string, label: string): ExecutableActionPlan {
  if (IRONCLAW_CORE_ACTION_TYPES.has(actionType)) {
    const fallbackAdapters: ExecutionAdapterName[] = ['direct'];
    if (OPENCLAW_ACTION_TYPES.has(actionType)) fallbackAdapters.push('openclaw');
    return {
      actionType,
      label,
      primaryAdapter: 'ironclaw',
      fallbackAdapters,
      readiness: 'known_action_type',
      runtimeVersion: getExecutionRuntimeVersionSummary('ironclaw'),
      adapterRationale: 'Known high-trust SkyTwin action type; route through IronClaw first.',
    };
  }

  if (OPENCLAW_ACTION_TYPES.has(actionType)) {
    return {
      actionType,
      label,
      primaryAdapter: 'openclaw',
      fallbackAdapters: [],
      readiness: 'known_action_type',
      runtimeVersion: getExecutionRuntimeVersionSummary('openclaw'),
      adapterRationale: 'Known OpenClaw skill; use OpenClaw when the user has configured it.',
    };
  }

  return {
    actionType,
    label,
    primaryAdapter: 'openclaw',
    fallbackAdapters: ['mcp-host'],
    readiness: 'learn_or_connect',
    learnTarget: `Teach OpenClaw or install an MCP capability for ${actionType}.`,
    runtimeVersion: getExecutionRuntimeVersionSummary('openclaw'),
    adapterRationale: 'No known built-in action type; treat this as a skill gap to learn or connect.',
  };
}
