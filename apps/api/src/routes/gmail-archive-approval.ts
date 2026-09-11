import { GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA } from '@skytwin/shared-types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_ACTION_KEYS = [
  'actionType',
  'confidence',
  'costZeroIntent',
  'decisionId',
  'description',
  'domain',
  'estimatedCostCents',
  'id',
  'parameters',
  'provenance',
  'reasoning',
  'reversible',
] as const;
const CANONICAL_PARAMETER_KEYS = ['messageRefId', 'operation', 'schema'] as const;

interface DescriptorInspection {
  ok: boolean;
  descriptors?: PropertyDescriptorMap;
}

function inspectPlainObject(value: unknown): DescriptorInspection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return { ok: false };
    return { ok: true, descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return { ok: false };
  }
}

function dataSnapshot(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  const inspection = inspectPlainObject(value);
  if (!inspection.ok || !inspection.descriptors) return null;
  try {
    const keys = Reflect.ownKeys(inspection.descriptors);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const names = (keys as string[]).sort();
    if (names.length !== expectedKeys.length ||
        names.some((key, index) => key !== expectedKeys[index])) return null;
    const snapshot: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = inspection.descriptors[name];
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      snapshot[name] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function dataValue(
  descriptors: PropertyDescriptorMap,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  const descriptor = descriptors[key];
  if (!descriptor || descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return { ok: false };
  return { ok: true, value: descriptor.value };
}

/**
 * Identify approvals reserved for the bounded Gmail Inbox workflow.
 *
 * The dedicated lifecycle is not executable yet. Matching any of its
 * authority-minimized parameter markers keeps malformed or partially migrated
 * rows out of the generic approval router as well as matching the canonical
 * schema exactly.
 */
export function isReservedGmailArchiveApproval(value: unknown): boolean {
  const actionInspection = inspectPlainObject(value);
  if (!actionInspection.ok || !actionInspection.descriptors) {
    // An object that cannot be inspected safely must not reach the generic
    // execution path. Ordinary primitives/arrays are not reserved shapes.
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  const actionType = dataValue(actionInspection.descriptors, 'actionType');
  if (!actionType.ok) return Object.prototype.hasOwnProperty.call(
    actionInspection.descriptors,
    'actionType',
  );
  if (actionType.value !== 'archive_email') return false;

  const parameters = dataValue(actionInspection.descriptors, 'parameters');
  if (!parameters.ok) return Object.prototype.hasOwnProperty.call(
    actionInspection.descriptors,
    'parameters',
  );
  const parameterInspection = inspectPlainObject(parameters.value);
  if (!parameterInspection.ok || !parameterInspection.descriptors) {
    return typeof parameters.value === 'object' && parameters.value !== null;
  }
  return ['schema', 'messageRefId', 'operation'].some((key) =>
    Object.prototype.hasOwnProperty.call(parameterInspection.descriptors, key));
}

/**
 * Positive classifier for the exact persisted Gmail Inbox approval projection.
 * It reads only own enumerable data descriptors: getters are never invoked and
 * proxies that throw during reflection are rejected.
 */
export function isCanonicalGmailArchiveApproval(value: unknown): boolean {
  const action = dataSnapshot(value, CANONICAL_ACTION_KEYS);
  if (!action || typeof action['id'] !== 'string' || !UUID.test(action['id']) ||
      typeof action['decisionId'] !== 'string' || !UUID.test(action['decisionId']) ||
      action['actionType'] !== 'archive_email' || action['domain'] !== 'email' ||
      typeof action['description'] !== 'string' || action['description'].trim().length === 0 ||
      action['estimatedCostCents'] !== 0 || action['costZeroIntent'] !== 'verified_zero' ||
      action['reversible'] !== true || action['confidence'] !== 'moderate' ||
      typeof action['reasoning'] !== 'string' || action['reasoning'].trim().length === 0 ||
      action['provenance'] !== 'untrusted_external') return false;

  const parameters = dataSnapshot(action['parameters'], CANONICAL_PARAMETER_KEYS);
  return parameters !== null &&
    parameters['schema'] === GMAIL_INBOX_MUTATION_CANDIDATE_SCHEMA &&
    typeof parameters['messageRefId'] === 'string' && UUID.test(parameters['messageRefId']) &&
    parameters['operation'] === 'archive';
}
