import { createHash } from 'node:crypto';
import type { RoutineFilter, RoutineSpec } from '@skytwin/shared-types';
import { matchesFilter, type MatchableSignal } from './match.js';

/** Stable identity stored by the adaptive-workflow envelope. */
export const SIGNAL_DIGEST_V1_PROVIDER_KEY = 'signal_digest.v1' as const;
export const SIGNAL_DIGEST_V1_SCHEMA_VERSION = '1' as const;
export const SIGNAL_DIGEST_V1_PROJECTION_VERSION = 1 as const;

const MAX_NAME_LENGTH = 120;
const MAX_SUMMARY_INSTRUCTION_LENGTH = 280;
const MAX_FILTER_ENTRIES = 50;
const MAX_FILTER_ENTRY_LENGTH = 200;
const MAX_CITATION_TEXT_LENGTH = 240;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const SPEC_KEYS = new Set([
  'name',
  'cadence',
  'hourOfDay',
  'dayOfWeek',
  'filter',
  'action',
  'summaryInstruction',
  'timezone',
]);
const FILTER_KEYS = ['sources', 'fromContains', 'keywords', 'domains'] as const;
const FILTER_KEY_SET = new Set<string>(FILTER_KEYS);
const CADENCES = new Set<RoutineSpec['cadence']>(['hourly', 'daily', 'weekly']);
const ACTIONS = new Set<RoutineSpec['action']>(['digest', 'notify']);

/** Provider-owned v1 payload. The workflow envelope stores provider identity separately. */
export interface SignalDigestV1Payload extends RoutineSpec {
  /** Versioned synthesis intent retained in each durable adaptive Watch slot. */
  summaryInstruction: string;
  /** IANA timezone pinned into the immutable workflow version when known. */
  timezone?: string;
}

export interface SignalDigestValidationIssue {
  path: string;
  code:
    | 'invalid_type'
    | 'missing_value'
    | 'unknown_field'
    | 'invalid_value'
    | 'limit_exceeded'
    | 'unsafe_value';
  message: string;
}

export type SignalDigestValidationResult =
  | { ok: true; payload: SignalDigestV1Payload }
  | { ok: false; issues: SignalDigestValidationIssue[] };

export interface SignalDigestV1WatchProjection {
  kind: 'watch.routine_spec';
  projectionVersion: typeof SIGNAL_DIGEST_V1_PROJECTION_VERSION;
  providerKey: typeof SIGNAL_DIGEST_V1_PROVIDER_KEY;
  providerSchemaVersion: typeof SIGNAL_DIGEST_V1_SCHEMA_VERSION;
  routineSpec: RoutineSpec;
  scheduleTimezone: string | null;
  canonicalPayloadJson: string;
  contentHash: string;
}

export type SignalDigestCompileResult =
  | { ok: true; artifact: SignalDigestV1WatchProjection }
  | { ok: false; issues: SignalDigestValidationIssue[] };

export type SignalDigestChangeClassification =
  | 'unchanged'
  | 'narrowing'
  | 'lateral'
  | 'broadening'
  | 'mixed';

export interface SignalDigestDiffDimension {
  changed: boolean;
  classification: SignalDigestChangeClassification;
  /** Conservative safety signal: true when this dimension can admit new runs/data/output. */
  broadened: boolean;
  reasons: string[];
}

export interface SignalDigestSemanticDiff {
  changed: boolean;
  metadataChanged: boolean;
  summaryInstructionChanged: boolean;
  trigger: SignalDigestDiffDimension;
  filter: SignalDigestDiffDimension;
  dataScope: SignalDigestDiffDimension;
  destination: SignalDigestDiffDimension;
  /** v1 has no effect authority, but broader matching/delivery still needs fresh consent. */
  authorityRelevantBroadening: boolean;
  requiresExplicitApproval: boolean;
}

export type SignalDigestDiffResult =
  | { ok: true; before: SignalDigestV1Payload; after: SignalDigestV1Payload; diff: SignalDigestSemanticDiff }
  | {
      ok: false;
      beforeIssues: SignalDigestValidationIssue[];
      afterIssues: SignalDigestValidationIssue[];
    };

/** Minimal SignalRow-compatible shape accepted by the pure historical simulator. */
export interface SignalDigestReplayRecord {
  id: string;
  source: string;
  timestamp: Date | string;
  data?: Readonly<Record<string, unknown>> | null;
}

export interface SignalDigestReplayCitation {
  signalId: string;
  source: string;
  timestamp: string | null;
  title: string;
  from: string;
}

export interface SignalDigestReplayResult {
  providerKey: typeof SIGNAL_DIGEST_V1_PROVIDER_KEY;
  providerSchemaVersion: typeof SIGNAL_DIGEST_V1_SCHEMA_VERSION;
  contentHash: string;
  totalCount: number;
  caughtCount: number;
  ignoredCount: number;
  /** Malformed records are included in ignoredCount and never cited. */
  invalidCount: number;
  examples: SignalDigestReplayCitation[];
}

export type SignalDigestReplaySimulation =
  | { ok: true; result: SignalDigestReplayResult }
  | { ok: false; issues: SignalDigestValidationIssue[] };

interface NormalizedReplayRecord {
  signalId: string;
  source: string;
  timestamp: string | null;
  timestampMs: number;
  matchable: MatchableSignal;
  title: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(
  path: string,
  code: SignalDigestValidationIssue['code'],
  message: string,
): SignalDigestValidationIssue {
  return { path, code, message };
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function canonicalFilterEntry(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

/** Locale-independent UTF-16 ordering keeps hashes stable across ICU builds. */
function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateStringList(
  raw: unknown,
  path: string,
  issues: SignalDigestValidationIssue[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(issue(path, 'invalid_type', `${path} must be an array of strings`));
    return [];
  }
  if (raw.length > MAX_FILTER_ENTRIES) {
    issues.push(
      issue(path, 'limit_exceeded', `${path} must contain at most ${MAX_FILTER_ENTRIES} entries`),
    );
  }

  const normalized: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    const itemPath = `${path}[${index}]`;
    if (typeof value !== 'string') {
      issues.push(issue(itemPath, 'invalid_type', `${itemPath} must be a string`));
      continue;
    }
    const clean = canonicalFilterEntry(value);
    if (!clean) {
      issues.push(issue(itemPath, 'missing_value', `${itemPath} must not be blank`));
      continue;
    }
    if (clean.length > MAX_FILTER_ENTRY_LENGTH) {
      issues.push(
        issue(
          itemPath,
          'limit_exceeded',
          `${itemPath} must be at most ${MAX_FILTER_ENTRY_LENGTH} characters`,
        ),
      );
      continue;
    }
    if (CONTROL_CHARACTERS.test(value)) {
      issues.push(issue(itemPath, 'unsafe_value', `${itemPath} must not contain control characters`));
      continue;
    }
    normalized.push(clean);
  }
  return [...new Set(normalized)].sort(lexicalCompare);
}

function normalizedFilter(raw: unknown, issues: SignalDigestValidationIssue[]): RoutineFilter {
  if (!isPlainRecord(raw)) {
    issues.push(issue('filter', 'invalid_type', 'filter must be an object'));
    return { sources: [], fromContains: [], keywords: [], domains: [] };
  }
  for (const key of Object.keys(raw).sort()) {
    if (!FILTER_KEY_SET.has(key)) {
      issues.push(issue(`filter.${key}`, 'unknown_field', `Unknown filter field: ${key}`));
    }
  }
  return {
    sources: validateStringList(raw['sources'], 'filter.sources', issues),
    fromContains: validateStringList(raw['fromContains'], 'filter.fromContains', issues),
    keywords: validateStringList(raw['keywords'], 'filter.keywords', issues),
    domains: validateStringList(raw['domains'], 'filter.domains', issues),
  };
}

function integerInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: SignalDigestValidationIssue[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.push(issue(path, 'invalid_value', `${path} must be an integer from ${min} to ${max}`));
    return undefined;
  }
  return value;
}

function validTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 128 || CONTROL_CHARACTERS.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Strictly validate untrusted structured inference output and return its single
 * canonical RoutineSpec representation. Unknown fields and unsafe broad
 * all-signal filters fail closed instead of being silently discarded.
 */
export function validateSignalDigestV1Payload(input: unknown): SignalDigestValidationResult {
  const issues: SignalDigestValidationIssue[] = [];
  if (!isPlainRecord(input)) {
    return {
      ok: false,
      issues: [issue('$', 'invalid_type', 'signal_digest.v1 payload must be an object')],
    };
  }

  for (const key of Object.keys(input).sort()) {
    if (!SPEC_KEYS.has(key)) {
      issues.push(issue(key, 'unknown_field', `Unknown payload field: ${key}`));
    }
  }

  let name = '';
  if (typeof input['name'] !== 'string') {
    issues.push(issue('name', 'invalid_type', 'name must be a string'));
  } else {
    name = normalizeWhitespace(input['name']);
    if (!name) issues.push(issue('name', 'missing_value', 'name must not be blank'));
    if (name.length > MAX_NAME_LENGTH) {
      issues.push(
        issue('name', 'limit_exceeded', `name must be at most ${MAX_NAME_LENGTH} characters`),
      );
    }
    if (CONTROL_CHARACTERS.test(input['name'])) {
      issues.push(issue('name', 'unsafe_value', 'name must not contain control characters'));
    }
  }

  let summaryInstruction = '';
  if (typeof input['summaryInstruction'] !== 'string') {
    issues.push(issue('summaryInstruction', 'invalid_type', 'summaryInstruction must be a string'));
  } else {
    summaryInstruction = normalizeWhitespace(input['summaryInstruction']);
    if (!summaryInstruction) {
      issues.push(issue('summaryInstruction', 'missing_value', 'summaryInstruction must not be blank'));
    }
    if (summaryInstruction.length > MAX_SUMMARY_INSTRUCTION_LENGTH) {
      issues.push(issue(
        'summaryInstruction',
        'limit_exceeded',
        `summaryInstruction must be at most ${MAX_SUMMARY_INSTRUCTION_LENGTH} characters`,
      ));
    }
    if (CONTROL_CHARACTERS.test(input['summaryInstruction'])) {
      issues.push(issue(
        'summaryInstruction',
        'unsafe_value',
        'summaryInstruction must not contain control characters',
      ));
    }
  }

  const cadenceRaw = input['cadence'];
  const cadence =
    typeof cadenceRaw === 'string' && CADENCES.has(cadenceRaw as RoutineSpec['cadence'])
      ? (cadenceRaw as RoutineSpec['cadence'])
      : undefined;
  if (!cadence) {
    issues.push(
      issue('cadence', 'invalid_value', 'cadence must be hourly, daily, or weekly'),
    );
  }

  const actionRaw = input['action'];
  const action =
    typeof actionRaw === 'string' && ACTIONS.has(actionRaw as RoutineSpec['action'])
      ? (actionRaw as RoutineSpec['action'])
      : undefined;
  if (!action) {
    issues.push(issue('action', 'invalid_value', 'action must be digest or notify'));
  }

  const hourOfDay = integerInRange(input['hourOfDay'], 'hourOfDay', 0, 23, issues);
  const dayOfWeek = integerInRange(input['dayOfWeek'], 'dayOfWeek', 0, 6, issues);
  if (cadence === 'hourly') {
    if (input['hourOfDay'] !== undefined) {
      issues.push(issue('hourOfDay', 'invalid_value', 'hourly cadence must omit hourOfDay'));
    }
    if (input['dayOfWeek'] !== undefined) {
      issues.push(issue('dayOfWeek', 'invalid_value', 'hourly cadence must omit dayOfWeek'));
    }
  } else if (cadence === 'daily' && input['dayOfWeek'] !== undefined) {
    issues.push(issue('dayOfWeek', 'invalid_value', 'daily cadence must omit dayOfWeek'));
  } else if (cadence === 'weekly' && dayOfWeek === undefined) {
    issues.push(issue('dayOfWeek', 'missing_value', 'weekly cadence requires dayOfWeek'));
  }

  const filter = normalizedFilter(input['filter'], issues);
  const hasNarrowingFilter = FILTER_KEYS.some((key) => (filter[key]?.length ?? 0) > 0);
  if (!hasNarrowingFilter) {
    issues.push(
      issue(
        'filter',
        'unsafe_value',
        'signal_digest.v1 requires at least one source, sender, keyword, or domain filter',
      ),
    );
  }

  const timezoneRaw = input['timezone'];
  const timezone = timezoneRaw === undefined
    ? undefined
    : typeof timezoneRaw === 'string' && validTimeZone(timezoneRaw.trim())
      ? timezoneRaw.trim()
      : undefined;
  if (timezoneRaw !== undefined && timezone === undefined) {
    issues.push(issue('timezone', 'invalid_value', 'timezone must be a valid IANA timezone'));
  }

  if (issues.length > 0 || !cadence || !action) return { ok: false, issues };

  const payload: SignalDigestV1Payload = {
    name,
    summaryInstruction,
    cadence,
    action,
    filter,
    ...(timezone === undefined ? {} : { timezone }),
    ...(cadence !== 'hourly' ? { hourOfDay: hourOfDay ?? 8 } : {}),
    ...(cadence === 'weekly' ? { dayOfWeek: dayOfWeek! } : {}),
  };
  return { ok: true, payload };
}

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function stableJson(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(',')}}`;
}

function payloadAsCanonicalValue(payload: SignalDigestV1Payload): CanonicalJson {
  return {
    action: payload.action,
    cadence: payload.cadence,
    ...(payload.dayOfWeek !== undefined ? { dayOfWeek: payload.dayOfWeek } : {}),
    filter: {
      domains: [...(payload.filter.domains ?? [])],
      fromContains: [...(payload.filter.fromContains ?? [])],
      keywords: [...(payload.filter.keywords ?? [])],
      sources: [...(payload.filter.sources ?? [])],
    },
    ...(payload.hourOfDay !== undefined ? { hourOfDay: payload.hourOfDay } : {}),
    name: payload.name,
    summaryInstruction: payload.summaryInstruction,
    ...(payload.timezone !== undefined ? { timezone: payload.timezone } : {}),
  };
}

/** Canonical JSON for the provider-owned payload only. */
export function canonicalSignalDigestV1Json(payload: SignalDigestV1Payload): string {
  return stableJson(payloadAsCanonicalValue(payload));
}

/**
 * Hash is domain-separated by provider key + schema version to prevent cross-provider collisions.
 * The envelope order deliberately matches the durable workflow-version hashing contract.
 */
export function signalDigestV1ContentHash(payload: SignalDigestV1Payload): string {
  const identityBoundJson = `{"providerKey":${JSON.stringify(SIGNAL_DIGEST_V1_PROVIDER_KEY)},`
    + `"providerSchemaVersion":${JSON.stringify(SIGNAL_DIGEST_V1_SCHEMA_VERSION)},`
    + `"canonicalPayload":${canonicalSignalDigestV1Json(payload)}}`;
  return createHash('sha256').update(identityBoundJson, 'utf8').digest('hex');
}

/** Compile a validated provider payload to the current Watch/RoutineSpec projection. */
export function compileSignalDigestV1(input: unknown): SignalDigestCompileResult {
  const validation = validateSignalDigestV1Payload(input);
  if (!validation.ok) return validation;
  const payload = validation.payload;
  const routineSpec: RoutineSpec = {
    name: payload.name,
    cadence: payload.cadence,
    action: payload.action,
    filter: payload.filter,
    ...(payload.hourOfDay !== undefined ? { hourOfDay: payload.hourOfDay } : {}),
    ...(payload.dayOfWeek !== undefined ? { dayOfWeek: payload.dayOfWeek } : {}),
  };
  return {
    ok: true,
    artifact: {
      kind: 'watch.routine_spec',
      projectionVersion: SIGNAL_DIGEST_V1_PROJECTION_VERSION,
      providerKey: SIGNAL_DIGEST_V1_PROVIDER_KEY,
      providerSchemaVersion: SIGNAL_DIGEST_V1_SCHEMA_VERSION,
    routineSpec,
    scheduleTimezone: payload.timezone ?? null,
      canonicalPayloadJson: canonicalSignalDigestV1Json(payload),
      contentHash: signalDigestV1ContentHash(payload),
    },
  };
}

function stringSet(values: readonly string[] | undefined): Set<string> {
  return new Set(values ?? []);
}

function setRelation(
  beforeValues: readonly string[] | undefined,
  afterValues: readonly string[] | undefined,
  label: string,
): SignalDigestDiffDimension {
  const before = stringSet(beforeValues);
  const after = stringSet(afterValues);
  const added = [...after].filter((value) => !before.has(value)).sort(lexicalCompare);
  const removed = [...before].filter((value) => !after.has(value)).sort(lexicalCompare);
  if (added.length === 0 && removed.length === 0) {
    return { changed: false, classification: 'unchanged', broadened: false, reasons: [] };
  }

  // Empty means unconstrained/any for each RoutineFilter field.
  if (before.size === 0) {
    return {
      changed: true,
      classification: 'narrowing',
      broadened: false,
      reasons: [`${label} became constrained to: ${[...after].join(', ')}`],
    };
  }
  if (after.size === 0) {
    return {
      changed: true,
      classification: 'broadening',
      broadened: true,
      reasons: [`${label} constraint was removed`],
    };
  }

  const classification: SignalDigestChangeClassification =
    added.length > 0 && removed.length > 0
      ? 'mixed'
      : added.length > 0
        ? 'broadening'
        : 'narrowing';
  return {
    changed: true,
    classification,
    broadened: added.length > 0,
    reasons: [
      ...(added.length ? [`${label} added: ${added.join(', ')}`] : []),
      ...(removed.length ? [`${label} removed: ${removed.join(', ')}`] : []),
    ],
  };
}

function combineDimensions(parts: readonly SignalDigestDiffDimension[]): SignalDigestDiffDimension {
  const changed = parts.some((part) => part.changed);
  if (!changed) return { changed: false, classification: 'unchanged', broadened: false, reasons: [] };
  const hasBroadening = parts.some(
    (part) => part.classification === 'broadening' || part.classification === 'mixed',
  );
  const hasNarrowing = parts.some(
    (part) => part.classification === 'narrowing' || part.classification === 'mixed',
  );
  const hasLateral = parts.some((part) => part.classification === 'lateral');
  const classification: SignalDigestChangeClassification =
    (hasBroadening && (hasNarrowing || hasLateral)) || (hasNarrowing && hasLateral)
      ? 'mixed'
      : hasBroadening
        ? 'broadening'
        : hasNarrowing
          ? 'narrowing'
          : 'lateral';
  return {
    changed,
    classification,
    broadened: hasBroadening,
    reasons: parts.flatMap((part) => part.reasons),
  };
}

function triggerDiff(before: SignalDigestV1Payload, after: SignalDigestV1Payload): SignalDigestDiffDimension {
  const beforeFrequency = { weekly: 1, daily: 7, hourly: 168 }[before.cadence];
  const afterFrequency = { weekly: 1, daily: 7, hourly: 168 }[after.cadence];
  const reasons: string[] = [];
  if (before.cadence !== after.cadence) reasons.push(`cadence changed from ${before.cadence} to ${after.cadence}`);
  if (before.hourOfDay !== after.hourOfDay) {
    reasons.push(`hour changed from ${String(before.hourOfDay)} to ${String(after.hourOfDay)}`);
  }
  if (before.dayOfWeek !== after.dayOfWeek) {
    reasons.push(`day changed from ${String(before.dayOfWeek)} to ${String(after.dayOfWeek)}`);
  }
  if (before.timezone !== after.timezone) {
    reasons.push(`timezone changed from ${String(before.timezone)} to ${String(after.timezone)}`);
  }
  if (reasons.length === 0) {
    return { changed: false, classification: 'unchanged', broadened: false, reasons: [] };
  }
  const classification: SignalDigestChangeClassification =
    afterFrequency > beforeFrequency
      ? 'broadening'
      : afterFrequency < beforeFrequency
        ? 'narrowing'
        : 'lateral';
  return {
    changed: true,
    classification,
    broadened: classification === 'broadening',
    reasons,
  };
}

function destinationDiff(
  before: SignalDigestV1Payload,
  after: SignalDigestV1Payload,
): SignalDigestDiffDimension {
  if (before.action === after.action) {
    return { changed: false, classification: 'unchanged', broadened: false, reasons: [] };
  }
  // A notification interrupts the user for each run; a digest is the quieter destination.
  const broadened = before.action === 'digest' && after.action === 'notify';
  return {
    changed: true,
    classification: broadened ? 'broadening' : 'narrowing',
    broadened,
    reasons: [`destination changed from ${before.action} to ${after.action}`],
  };
}

/** Authoritative server-side semantic comparison used before activation. */
export function diffSignalDigestV1(beforeInput: unknown, afterInput: unknown): SignalDigestDiffResult {
  const beforeValidation = validateSignalDigestV1Payload(beforeInput);
  const afterValidation = validateSignalDigestV1Payload(afterInput);
  if (!beforeValidation.ok || !afterValidation.ok) {
    return {
      ok: false,
      beforeIssues: beforeValidation.ok ? [] : beforeValidation.issues,
      afterIssues: afterValidation.ok ? [] : afterValidation.issues,
    };
  }
  const before = beforeValidation.payload;
  const after = afterValidation.payload;
  const trigger = triggerDiff(before, after);
  const dataScope = setRelation(before.filter.sources, after.filter.sources, 'sources');
  const filter = combineDimensions([
    setRelation(before.filter.fromContains, after.filter.fromContains, 'senders'),
    setRelation(before.filter.keywords, after.filter.keywords, 'keywords'),
    setRelation(before.filter.domains, after.filter.domains, 'domains'),
  ]);
  const destination = destinationDiff(before, after);
  const metadataChanged = before.name !== after.name;
  const summaryInstructionChanged = before.summaryInstruction !== after.summaryInstruction;
  const changed = metadataChanged || summaryInstructionChanged
    || trigger.changed || dataScope.changed || filter.changed || destination.changed;
  const authorityRelevantBroadening =
    trigger.broadened || dataScope.broadened || filter.broadened || destination.broadened;
  return {
    ok: true,
    before,
    after,
    diff: {
      changed,
      metadataChanged,
      summaryInstructionChanged,
      trigger,
      filter,
      dataScope,
      destination,
      authorityRelevantBroadening,
      // Every edit becomes an immutable candidate version. Even a name-only
      // version needs explicit activation; semantic broadening additionally
      // flips authorityRelevantBroadening for stronger review UI.
      requiresExplicitApproval: changed,
    },
  };
}

function replayString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function boundedCitationText(value: string): string {
  return normalizeWhitespace(value).slice(0, MAX_CITATION_TEXT_LENGTH);
}

function replayTimestamp(value: unknown): { iso: string | null; millis: number } {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return { iso: null, millis: Number.NEGATIVE_INFINITY };
  return { iso: date.toISOString(), millis: date.getTime() };
}

function normalizeReplayRecord(input: unknown): NormalizedReplayRecord | null {
  if (!isPlainRecord(input)) return null;
  const id = input['id'];
  const source = input['source'];
  if (typeof id !== 'string' || !id.trim() || typeof source !== 'string' || !source.trim()) return null;
  const data = isPlainRecord(input['data']) ? input['data'] : {};
  const from = replayString(data['from']) || replayString(data['organizer']);
  const text = [
    data['subject'],
    data['title'],
    data['snippet'],
    data['body'],
    data['text'],
    data['description'],
  ]
    .map(replayString)
    .filter(Boolean)
    .join(' ');
  const title = replayString(data['subject']) || replayString(data['title']) || replayString(data['summary']);
  const timestamp = replayTimestamp(input['timestamp']);
  return {
    signalId: id.trim(),
    source: source.trim(),
    timestamp: timestamp.iso,
    timestampMs: timestamp.millis,
    matchable: { source: source.trim(), from, text },
    title: boundedCitationText(title || `${source.trim()} item`),
  };
}

/**
 * Replay the deterministic Watch predicate over caller-supplied historical
 * records. The caller owns the time window and data-access disclosure; this
 * pure function only classifies the supplied rows and emits bounded citations.
 */
export function simulateSignalDigestV1(
  payloadInput: unknown,
  records: readonly unknown[],
): SignalDigestReplaySimulation {
  const validation = validateSignalDigestV1Payload(payloadInput);
  if (!validation.ok) return validation;
  const payload = validation.payload;
  const matched: NormalizedReplayRecord[] = [];
  let invalidCount = 0;
  for (const recordInput of records) {
    const record = normalizeReplayRecord(recordInput);
    if (!record) {
      invalidCount += 1;
      continue;
    }
    if (matchesFilter(record.matchable, payload.filter)) matched.push(record);
  }
  matched.sort((a, b) => b.timestampMs - a.timestampMs || lexicalCompare(a.signalId, b.signalId));
  const examples = matched.slice(0, 3).map<SignalDigestReplayCitation>((record) => ({
    signalId: record.signalId,
    source: record.source,
    timestamp: record.timestamp,
    title: record.title,
    from: boundedCitationText(record.matchable.from),
  }));
  return {
    ok: true,
    result: {
      providerKey: SIGNAL_DIGEST_V1_PROVIDER_KEY,
      providerSchemaVersion: SIGNAL_DIGEST_V1_SCHEMA_VERSION,
      contentHash: signalDigestV1ContentHash(payload),
      totalCount: records.length,
      caughtCount: matched.length,
      ignoredCount: records.length - matched.length,
      invalidCount,
      examples,
    },
  };
}

/** Small integration surface for a future workflow-provider registry. */
export const signalDigestV1Provider = Object.freeze({
  key: SIGNAL_DIGEST_V1_PROVIDER_KEY,
  schemaVersion: SIGNAL_DIGEST_V1_SCHEMA_VERSION,
  validate: validateSignalDigestV1Payload,
  compile: compileSignalDigestV1,
  diff: diffSignalDigestV1,
  simulate: simulateSignalDigestV1,
});
