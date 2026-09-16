/**
 * Classification used by generic runtime boundaries to quarantine the
 * dedicated Gmail archive workflow. An invalid shape is distinct from an
 * unrelated action so callers cannot turn a failed inspection into authority.
 */
export type GmailArchiveGenericActionClassification =
  | { kind: 'archive' }
  | { kind: 'other' }
  | { kind: 'invalid' };

const ARCHIVE = Object.freeze({ kind: 'archive' } as const);
const OTHER = Object.freeze({ kind: 'other' } as const);
const INVALID = Object.freeze({ kind: 'invalid' } as const);

/**
 * Inspect only the top-level action type without invoking caller-controlled
 * accessors. Every archive_email shape is reserved, including legacy or
 * malformed parameter formats.
 */
export function classifyGmailArchiveGenericAction(
  value: unknown,
): Readonly<GmailArchiveGenericActionClassification> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getOwnPropertySymbols(value).length !== 0) return INVALID;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return INVALID;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'actionType');
    if (!descriptor || !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'string') return INVALID;
    return descriptor.value === 'archive_email' ? ARCHIVE : OTHER;
  } catch {
    return INVALID;
  }
}
