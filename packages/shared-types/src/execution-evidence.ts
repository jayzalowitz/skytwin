import type { MemoryActionLoopReport, MemoryActionOpportunityStatus } from './memory-action-loop.js';

const REDACTED_CREDENTIAL = '[redacted:credential]';
const REDACTED_EVIDENCE = '[redacted:unapproved-evidence]';
const REDACTED_ERROR = '[redacted:execution-error]';
const REDACTED_URL = '[redacted:url]';
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TEXT_LENGTH = 1_000;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'ambiguous']);
const RESULT_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'ambiguous']);
const EVENT_TYPES = new Set([
  'plan_started', 'step_started', 'step_completed', 'step_failed', 'plan_completed', 'plan_failed',
]);
const MEMORY_STATUSES = new Set<MemoryActionOpportunityStatus>([
  'suggested', 'queued_approval', 'auto_executed', 'blocked_by_policy', 'learning_needed',
  'execution_failed', 'execution_ambiguous', 'noted_awareness', 'skipped',
]);
const SAFE_FALLBACK_REASON = 'previous adapter returned non-completed status, fallback unsafe';

export interface NormalizeExecutionEvidenceOptions {
  /** Known credentials for exact-string removal from locally-authored text. */
  secretValues?: ReadonlyArray<string | null | undefined>;
}

export interface NormalizedAdapterOutput extends Record<string, unknown> {
  adapter_used?: string;
  routing_decision?: string;
  fallbacks_attempted?: number;
  fallback_skipped_reason?: string;
  adapter_plan_id?: string;
  status?: string;
  success?: boolean;
  rollback_available?: boolean;
  _redacted?: string;
}

function secrets(options: NormalizeExecutionEvidenceOptions): string[] {
  return (options.secretValues ?? [])
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
}

function redactRecognizableText(
  value: string,
  options: NormalizeExecutionEvidenceOptions = {},
  maxLength = MAX_TEXT_LENGTH,
): string {
  let redacted = value;
  for (const secret of secrets(options)) {
    redacted = redacted.split(secret).join(REDACTED_CREDENTIAL);
  }
  redacted = redacted
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/gi,
      REDACTED_CREDENTIAL)
    .replace(/https?:\/\/[^\s"'<>]+/gi, REDACTED_URL)
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED_CREDENTIAL}`)
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password)=[^\s&]+/gi,
      `$1=${REDACTED_CREDENTIAL}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_CREDENTIAL)
    .replace(/\bya29\.[A-Za-z0-9._-]+\b/g, REDACTED_CREDENTIAL)
    .replace(/\b1\/\/[A-Za-z0-9._-]+\b/g, REDACTED_CREDENTIAL)
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{6,}\b/g, REDACTED_CREDENTIAL)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED_CREDENTIAL)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED_CREDENTIAL)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED_CREDENTIAL)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, REDACTED_CREDENTIAL);
  return redacted.slice(0, maxLength);
}

export function normalizeExecutionIdentifier(value: unknown, maxLength = MAX_IDENTIFIER_LENGTH): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
}

/**
 * Typed durable schema for adapter output. Only router-authored routing facts
 * and bounded scalar terminal facts survive. Containers, arrays, arbitrary
 * response bodies, unknown keys, and primitive values nested beneath generic
 * names such as `output`/`payload`/`metadata` collapse to one marker.
 */
export function normalizeAdapterOutput(
  value: unknown,
  options: NormalizeExecutionEvidenceOptions = {},
): NormalizedAdapterOutput {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { _redacted: REDACTED_EVIDENCE };
  }
  const source = value as Record<string, unknown>;
  const normalized: NormalizedAdapterOutput = {};
  let omitted = false;

  const adapterUsed = normalizeExecutionIdentifier(source['adapter_used'], 64);
  if (adapterUsed) normalized.adapter_used = redactRecognizableText(adapterUsed, options, 64);
  else if (source['adapter_used'] !== undefined) omitted = true;

  const routingDecision = normalizeExecutionIdentifier(source['routing_decision'], 64);
  if (routingDecision) normalized.routing_decision = redactRecognizableText(routingDecision, options, 64);
  else if (source['routing_decision'] !== undefined) omitted = true;

  const fallbacks = source['fallbacks_attempted'];
  if (Number.isSafeInteger(fallbacks) && (fallbacks as number) >= 0 && (fallbacks as number) <= 100) {
    normalized.fallbacks_attempted = fallbacks as number;
  } else if (fallbacks !== undefined) {
    omitted = true;
  }

  if (source['fallback_skipped_reason'] === SAFE_FALLBACK_REASON) {
    normalized.fallback_skipped_reason = SAFE_FALLBACK_REASON;
  } else if (source['fallback_skipped_reason'] !== undefined) {
    omitted = true;
  }

  const adapterPlanId = normalizeExecutionIdentifier(source['adapter_plan_id']);
  if (adapterPlanId) normalized.adapter_plan_id = redactRecognizableText(adapterPlanId, options);
  else if (source['adapter_plan_id'] !== undefined) omitted = true;

  if (typeof source['status'] === 'string' && RESULT_STATUSES.has(source['status'])) {
    normalized.status = source['status'];
  } else if (source['status'] !== undefined) {
    omitted = true;
  }
  if (typeof source['success'] === 'boolean') normalized.success = source['success'];
  else if (source['success'] !== undefined) omitted = true;
  if (typeof source['rollback_available'] === 'boolean') {
    normalized.rollback_available = source['rollback_available'];
  } else if (source['rollback_available'] !== undefined) omitted = true;

  const knownKeys = new Set([
    'adapter_used', 'routing_decision', 'fallbacks_attempted', 'fallback_skipped_reason',
    'adapter_plan_id', 'status', 'success', 'rollback_available', '_redacted',
  ]);
  if (Object.keys(source).some((key) => !knownKeys.has(key))) omitted = true;
  if (source['_redacted'] === REDACTED_EVIDENCE) omitted = true;
  if (omitted) normalized._redacted = REDACTED_EVIDENCE;
  return normalized;
}

/** The event payload schema intentionally matches the adapter-result schema. */
export function normalizeExecutionEventPayload(
  value: unknown,
  options: NormalizeExecutionEvidenceOptions = {},
): NormalizedAdapterOutput {
  const normalized = normalizeAdapterOutput(value, options);
  if (normalized.adapter_plan_id !== undefined) {
    delete normalized.adapter_plan_id;
    normalized._redacted = REDACTED_EVIDENCE;
  }
  return normalized;
}

export function normalizeExecutionEventType(value: unknown): string {
  return typeof value === 'string' && EVENT_TYPES.has(value) ? value : 'unknown';
}

/** Durable plan schema: execution parameters never belong in plan evidence. */
export function normalizeExecutionPlanSteps(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  const statuses = new Set(['pending', 'running', 'completed', 'failed', 'skipped']);
  return value.slice(0, 100).flatMap((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const source = step as Record<string, unknown>;
    const type = normalizeExecutionIdentifier(source['type'], 128);
    const status = typeof source['status'] === 'string' && statuses.has(source['status'])
      ? source['status']
      : null;
    if (!type || !status) return [];
    return [{ type: redactRecognizableText(type, {}, 128), status }];
  });
}

/** Typed admission-barrier terminal observation schema. */
export function normalizeExecutionObservation(
  value: Record<string, unknown>,
  options: NormalizeExecutionEvidenceOptions = {},
): Record<string, unknown> {
  const planId = normalizeExecutionIdentifier(value['planId']);
  const status = typeof value['status'] === 'string' && TERMINAL_STATUSES.has(value['status'])
    ? value['status']
    : null;
  const result: Record<string, unknown> = {
    ...(planId ? { planId } : {}),
    ...(status ? { status } : {}),
    output: normalizeAdapterOutput(value['output'], options),
    error: value['error'] ? normalizeExecutionError(value['error'], options) : null,
  };
  const adapterName = normalizeExecutionIdentifier(value['adapterName'] ?? value['adapterUsed'], 64);
  if (adapterName) {
    result[value['adapterName'] !== undefined ? 'adapterName' : 'adapterUsed'] =
      redactRecognizableText(adapterName, options, 64);
  }
  const adapterPlanId = normalizeExecutionIdentifier(value['adapterPlanId']);
  if (adapterPlanId) result['adapterPlanId'] = redactRecognizableText(adapterPlanId, options);
  const knownKeys = new Set([
    'planId', 'status', 'output', 'error', 'adapterName', 'adapterUsed', 'adapterPlanId', '_redacted',
  ]);
  if (!planId || !status || Object.keys(value).some((key) => !knownKeys.has(key)) ||
      value['_redacted'] === REDACTED_EVIDENCE) {
    result['_redacted'] = REDACTED_EVIDENCE;
  }
  return result;
}

export function normalizeExecutionError(
  value: unknown,
  _options: NormalizeExecutionEvidenceOptions = {},
): string {
  return value === null || value === undefined || value === '' ? '' : REDACTED_ERROR;
}

/** Bounded local text for direct memory-opportunity scalar columns. */
export function normalizeMemoryActionText(
  value: unknown,
  options: NormalizeExecutionEvidenceOptions = {},
): string | null {
  return typeof value === 'string' && value.length > 0
    ? redactRecognizableText(value, options)
    : null;
}

export function normalizeMemoryActionAdapterName(value: unknown): string | null {
  const identifier = normalizeExecutionIdentifier(value, 64);
  return identifier ? redactRecognizableText(identifier, {}, 64) : null;
}

/** Credential-aware identifier boundary for memory source/page references. */
export function normalizeMemoryActionReference(value: unknown): string | null {
  const identifier = normalizeExecutionIdentifier(value);
  if (!identifier) return null;
  return redactRecognizableText(identifier) === identifier ? identifier : REDACTED_CREDENTIAL;
}

/** Identifier boundary for memory fields where a marker is not schema-valid. */
export function normalizeMemoryActionIdentifier(value: unknown): string | null {
  const identifier = normalizeExecutionIdentifier(value);
  if (!identifier) return null;
  return redactRecognizableText(identifier) === identifier ? identifier : null;
}

/** Typed memory-opportunity report schema; no recursive generic containers. */
export function normalizeMemoryActionReport(
  value: MemoryActionLoopReport,
  options: NormalizeExecutionEvidenceOptions = {},
): MemoryActionLoopReport {
  const status = MEMORY_STATUSES.has(value.status) ? value.status : 'execution_ambiguous';
  const identifier = (candidate: unknown, fallback: string): string =>
    normalizeMemoryActionIdentifier(candidate) ?? fallback;
  const text = (candidate: unknown, fallback: string): string =>
    normalizeMemoryActionText(candidate, options) ?? fallback;
  const adapterName = normalizeMemoryActionAdapterName(value.adapterName);
  const policyReason = normalizeMemoryActionText(value.policyReason, options);
  const routeReason = normalizeMemoryActionText(value.routeReason, options);
  return {
    opportunityId: identifier(value.opportunityId, 'unknown'),
    status,
    title: text(value.title, REDACTED_EVIDENCE),
    actionType: identifier(value.actionType, 'unknown'),
    actionLabel: text(value.actionLabel, REDACTED_EVIDENCE),
    ...(adapterName ? { adapterName } : {}),
    ...(normalizeMemoryActionIdentifier(value.decisionId) ? { decisionId: value.decisionId } : {}),
    ...(normalizeMemoryActionIdentifier(value.approvalRequestId)
      ? { approvalRequestId: value.approvalRequestId } : {}),
    ...(normalizeMemoryActionIdentifier(value.executionPlanId)
      ? { executionPlanId: value.executionPlanId } : {}),
    ...(policyReason ? { policyReason } : {}),
    ...(routeReason ? { routeReason } : {}),
    summary: text(value.summary, REDACTED_EVIDENCE),
    nextStep: text(value.nextStep, REDACTED_EVIDENCE),
    attemptedAt: typeof value.attemptedAt === 'string' && value.attemptedAt.length <= 64 &&
        !Number.isNaN(Date.parse(value.attemptedAt))
      ? new Date(value.attemptedAt).toISOString()
      : new Date(0).toISOString(),
  };
}
