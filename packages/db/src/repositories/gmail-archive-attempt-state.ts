import {
  GMAIL_ARCHIVE_ATTEMPT_SCHEMA,
  type GmailArchiveAttemptPhase,
  type GmailArchiveAttemptStateV1,
} from '@skytwin/shared-types';

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return null;
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function gmailArchiveAttemptState(
  phase: GmailArchiveAttemptPhase,
): Readonly<GmailArchiveAttemptStateV1> {
  return Object.freeze({ schema: GMAIL_ARCHIVE_ATTEMPT_SCHEMA, phase });
}

export function snapshotGmailArchiveAttemptState(
  value: unknown,
): Readonly<GmailArchiveAttemptStateV1> | null {
  const state = ownData(value, ['phase', 'schema']);
  if (state?.['schema'] !== GMAIL_ARCHIVE_ATTEMPT_SCHEMA ||
      (state['phase'] !== 'pre_dispatch' && state['phase'] !== 'dispatch_may_have_started')) return null;
  return gmailArchiveAttemptState(state['phase']);
}
