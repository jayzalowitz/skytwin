import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { query, withTransaction } from '../connection.js';
import type {
  FeedbackEventRow,
  TwinFeedbackApplicationRow,
  TwinProfileRow,
  TwinProfileVersionRow,
} from '../types.js';
import {
  loadCanonicalGmailArchiveApprovalState,
  type GmailArchiveApprovalCanonicalState,
} from './gmail-archive-approval-response-repository.js';
import { GMAIL_ARCHIVE_PROPOSAL_REASON } from './gmail-archive-proposal-repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAGE_LIMIT = 25;
const CURSOR_PREFIX = 'gmail_archive_feedback_pending_v1';
const MAX_CURSOR_LENGTH = 384;
const PROFILE_FIELDS = [
  'preferences',
  'inferences',
  'risk_tolerance',
  'spend_norms',
  'communication_style',
  'routines',
  'domain_heuristics',
] as const;
const CONFIDENCE_ORDER = [
  ConfidenceLevel.SPECULATIVE,
  ConfidenceLevel.LOW,
  ConfidenceLevel.MODERATE,
  ConfidenceLevel.HIGH,
  ConfidenceLevel.CONFIRMED,
] as const;

export interface ApplyGmailArchiveApprovalFeedbackInput {
  readonly userId: string;
  readonly feedbackEventId: string;
}

export interface GmailArchiveFeedbackApplication {
  readonly id: string;
  readonly feedbackEventId: string;
  readonly userId: string;
  readonly decisionId: string;
  readonly profileId: string;
  readonly inputProfileVersion: number;
  readonly outputProfileVersion: number;
  readonly changed: boolean;
  readonly outputDigest: string;
  readonly appliedAt: string;
}

export type ApplyGmailArchiveApprovalFeedbackResult =
  | { readonly ok: true; readonly created: boolean; readonly application: GmailArchiveFeedbackApplication }
  | { readonly ok: false; readonly error: 'invalid_input' | 'not_found' | 'integrity_conflict' };

declare const gmailArchiveFeedbackPendingCursorBrand: unique symbol;
export type GmailArchiveFeedbackPendingCursor = string & {
  readonly [gmailArchiveFeedbackPendingCursorBrand]: 'GmailArchiveFeedbackPendingCursor';
};

export interface ListPendingGmailArchiveFeedbackInput {
  readonly limit: number;
  /** Trusted scheduling metadata only; never recovery or projection authority. */
  readonly cursor?: GmailArchiveFeedbackPendingCursor;
}

export interface PendingGmailArchiveFeedbackCandidate {
  readonly userId: string;
  readonly feedbackEventId: string;
}

export type ListPendingGmailArchiveFeedbackResult =
  | {
    readonly ok: true;
    readonly candidates: readonly Readonly<PendingGmailArchiveFeedbackCandidate>[];
    readonly nextCursor: GmailArchiveFeedbackPendingCursor | null;
  }
  | { readonly ok: false; readonly error: 'invalid_input' | 'integrity_conflict' };

interface StableIds {
  readonly application: string;
  readonly profile: string;
  readonly profileVersion: string;
}

interface ProfileState {
  readonly preferences: JsonValue;
  readonly inferences: readonly JsonObject[];
  readonly risk_tolerance: JsonValue;
  readonly spend_norms: JsonValue;
  readonly communication_style: JsonValue;
  readonly routines: JsonValue;
  readonly domain_heuristics: JsonValue;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;
interface JsonObject { readonly [key: string]: JsonValue }

interface Projection {
  readonly changed: boolean;
  readonly output: ProfileState;
}

interface FeedbackWithTime extends FeedbackEventRow {
  created_at_text: string;
}

interface ApplicationWithTime extends Omit<TwinFeedbackApplicationRow,
  'input_profile_version' | 'output_profile_version'> {
  input_profile_version: unknown;
  output_profile_version: unknown;
  applied_at_text: string;
}

interface VersionWithTime extends Omit<TwinProfileVersionRow, 'version'> {
  version: unknown;
  created_at_text: string;
}

interface PendingRow {
  user_id: string;
  feedback_event_id: string;
  created_at_text: string;
}

interface CursorState {
  readonly createdAt: string;
  readonly feedbackEventId: string;
}

interface ApplicationHooks {
  readonly afterProfileWrite?: () => void | Promise<void>;
}

type ApplicationTransition = (
  client: PoolClient,
  input: Readonly<ApplyGmailArchiveApprovalFeedbackInput>,
  ids: Readonly<StableIds>,
  hooks?: ApplicationHooks,
) => Promise<ApplyGmailArchiveApprovalFeedbackResult>;

type TransactionRunner = <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;

class RollbackResult extends Error {
  constructor(readonly result: ApplyGmailArchiveApprovalFeedbackResult) {
    super('Gmail archive feedback application rolled back');
  }
}

function ownData(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Object.getOwnPropertyNames(descriptors).sort();
    const allowed = new Set([...required, ...optional]);
    if (required.some((key) => !names.includes(key)) || names.some((key) => !allowed.has(key))) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      snapshot[name] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function snapshotJson(value: unknown, seen = new Set<object>()): JsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).some((key) => key !== 'length' && !/^\d+$/.test(key))) {
        return null;
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return null;
        const item = snapshotJson(value[index], seen);
        if (item === null && value[index] !== null) return null;
        output.push(item);
      }
      return Object.freeze(output);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true) return null;
      const item = snapshotJson(descriptor.value, seen);
      if (item === null && descriptor.value !== null) return null;
      output[key] = item;
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as JsonObject;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/.exec(value);
  if (!match) return null;
  const micros = (match[3] ?? '').padEnd(6, '0');
  const fraction = micros.slice(3) === '000' ? micros.slice(0, 3) : micros;
  const canonical = `${match[1]}T${match[2]}.${fraction}Z`;
  try {
    const milliseconds = `${match[1]}T${match[2]}.${micros.slice(0, 3)}Z`;
    return new Date(milliseconds).toISOString() === milliseconds ? canonical : null;
  } catch {
    return null;
  }
}

function profileTimestamp(appliedAt: string): string {
  return new Date(appliedAt).toISOString();
}

function comparableTimestamp(value: string): string {
  return value.length === 24 ? `${value.slice(0, -1)}000Z` : value;
}

function safeVersion(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(parsed) && (parsed as number) > 0 ? parsed as number : null;
}

function snapshotApplyInput(value: unknown): Readonly<ApplyGmailArchiveApprovalFeedbackInput> | null {
  const input = ownData(value, ['feedbackEventId', 'userId']);
  if (!input || typeof input['feedbackEventId'] !== 'string' ||
      !UUID.test(input['feedbackEventId']) || typeof input['userId'] !== 'string' ||
      !UUID.test(input['userId'])) return null;
  return Object.freeze({
    feedbackEventId: input['feedbackEventId'],
    userId: input['userId'],
  });
}

function snapshotProfileState(value: unknown): ProfileState | null {
  const raw = ownData(value, PROFILE_FIELDS);
  if (!raw) return null;
  const fields: Record<string, JsonValue> = {};
  for (const key of PROFILE_FIELDS) {
    const item = snapshotJson(raw[key]);
    if (item === null && raw[key] !== null) return null;
    fields[key] = item;
  }
  if (!Array.isArray(fields['preferences']) || !Array.isArray(fields['inferences']) ||
      !Array.isArray(fields['routines']) || Array.isArray(fields['risk_tolerance']) ||
      Array.isArray(fields['spend_norms']) || Array.isArray(fields['communication_style']) ||
      Array.isArray(fields['domain_heuristics']) || fields['risk_tolerance'] === null ||
      fields['spend_norms'] === null || fields['communication_style'] === null ||
      fields['domain_heuristics'] === null || typeof fields['risk_tolerance'] !== 'object' ||
      typeof fields['spend_norms'] !== 'object' || typeof fields['communication_style'] !== 'object' ||
      typeof fields['domain_heuristics'] !== 'object') return null;
  const inferences = fields['inferences'];
  if (!inferences.every((item): item is JsonObject =>
    item !== null && typeof item === 'object' && !Array.isArray(item))) return null;
  return Object.freeze({
    preferences: fields['preferences'],
    inferences: Object.freeze(inferences),
    risk_tolerance: fields['risk_tolerance'],
    spend_norms: fields['spend_norms'],
    communication_style: fields['communication_style'],
    routines: fields['routines'],
    domain_heuristics: fields['domain_heuristics'],
  });
}

function profileStateFromRow(profile: TwinProfileRow): ProfileState | null {
  return snapshotProfileState(Object.fromEntries(PROFILE_FIELDS.map((key) => [key, profile[key]])));
}

function exactStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length;
}

function validInference(inference: JsonObject): boolean {
  const required = [
    'id', 'domain', 'key', 'value', 'confidence', 'supportingEvidenceIds',
    'contradictingEvidenceIds', 'reasoning', 'createdAt', 'updatedAt',
  ];
  return required.every((key) => Object.prototype.hasOwnProperty.call(inference, key)) &&
    typeof inference['id'] === 'string' && inference['id'].length > 0 &&
    typeof inference['domain'] === 'string' && inference['domain'].length > 0 &&
    typeof inference['key'] === 'string' && inference['key'].length > 0 &&
    CONFIDENCE_ORDER.includes(inference['confidence'] as typeof CONFIDENCE_ORDER[number]) &&
    exactStringArray(inference['supportingEvidenceIds']) &&
    exactStringArray(inference['contradictingEvidenceIds']) &&
    typeof inference['reasoning'] === 'string' && inference['reasoning'].length > 0 &&
    typeof inference['createdAt'] === 'string' && canonicalTimestamp(inference['createdAt']) !== null &&
    typeof inference['updatedAt'] === 'string' && canonicalTimestamp(inference['updatedAt']) !== null;
}

function projectProfile(
  state: ProfileState,
  action: 'approve' | 'reject',
  evidenceIds: ReadonlySet<string>,
  domain: string,
  appliedAt: string,
): Projection | null {
  if (!state.inferences.every(validInference)) return null;
  let changed = false;
  const updatedAt = profileTimestamp(appliedAt);
  const inferences = state.inferences.map((inference) => {
    const evidence = inference['supportingEvidenceIds'];
    const causal = inference['domain'] === domain && exactStringArray(evidence) &&
      evidence.some((id) => evidenceIds.has(id));
    if (!causal) return inference;
    const index = CONFIDENCE_ORDER.indexOf(
      inference['confidence'] as typeof CONFIDENCE_ORDER[number],
    );
    const nextIndex = action === 'approve'
      ? Math.min(CONFIDENCE_ORDER.length - 1, index + 1)
      : Math.max(0, index - 1);
    if (nextIndex === index) return inference;
    changed = true;
    return Object.freeze({
      ...inference,
      confidence: CONFIDENCE_ORDER[nextIndex]!,
      updatedAt,
    });
  });
  return Object.freeze({
    changed,
    output: Object.freeze({ ...state, inferences: Object.freeze(inferences) }),
  });
}

function outputDigest(profileId: string, userId: string, version: number, state: ProfileState): string {
  const json = snapshotJson({ profileId, userId, version, state });
  if (!json) throw new TypeError('profile output is not canonical JSON');
  return createHash('sha256')
    .update('skytwin.gmail-archive-feedback-projection/output/v1\0', 'utf8')
    .update(canonicalJson(json), 'utf8')
    .digest('hex');
}

function exactFeedback(
  feedback: FeedbackWithTime,
  state: GmailArchiveApprovalCanonicalState,
  input: Readonly<ApplyGmailArchiveApprovalFeedbackInput>,
  timestampMatches: boolean,
): boolean {
  return feedback.id === input.feedbackEventId && feedback.user_id === input.userId &&
    feedback.decision_id === state.decision.id &&
    feedback.approval_request_id === state.approval.id &&
    (feedback.type === 'approve' || feedback.type === 'reject') &&
    ownData(feedback.data, ['reason']) !== null &&
    feedback.data['reason'] === (state.approval.response?.['reason'] ?? null) &&
    state.approval.status === (feedback.type === 'approve' ? 'approved' : 'rejected') &&
    timestampMatches && canonicalTimestamp(feedback.created_at_text) !== null;
}

async function loadFeedback(
  client: PoolClient,
  input: Readonly<ApplyGmailArchiveApprovalFeedbackInput>,
  lock: boolean,
): Promise<FeedbackWithTime[]> {
  return (await client.query<FeedbackWithTime>(
    `SELECT feedback.*,
            (feedback.created_at AT TIME ZONE 'UTC')::STRING AS created_at_text
       FROM feedback_events feedback
      WHERE feedback.id = $1 AND feedback.user_id = $2
      ORDER BY feedback.id
      LIMIT 2${lock ? ' FOR UPDATE' : ''}`,
    [input.feedbackEventId, input.userId],
  )).rows;
}

function feedbackInput(feedback: FeedbackWithTime): {
  approvalId: string;
  userId: string;
  action: 'approve' | 'reject';
  reason?: string;
} | null {
  const data = ownData(feedback.data, ['reason']);
  if (!data || !feedback.approval_request_id || !UUID.test(feedback.approval_request_id) ||
      (feedback.type !== 'approve' && feedback.type !== 'reject') ||
      (data['reason'] !== null && typeof data['reason'] !== 'string')) return null;
  return {
    approvalId: feedback.approval_request_id,
    userId: feedback.user_id,
    action: feedback.type,
    ...(typeof data['reason'] === 'string' ? { reason: data['reason'] } : {}),
  };
}

function failIntegrity(): never {
  throw new RollbackResult(Object.freeze({ ok: false, error: 'integrity_conflict' }));
}

async function applicationTime(client: PoolClient): Promise<string | null> {
  const row = (await client.query<{ applied_at_text: string }>(
    `SELECT (statement_timestamp() AT TIME ZONE 'UTC')::STRING AS applied_at_text`,
  )).rows[0];
  return canonicalTimestamp(row?.applied_at_text);
}

function applicationSnapshot(row: ApplicationWithTime): GmailArchiveFeedbackApplication | null {
  const inputVersion = safeVersion(row.input_profile_version);
  const outputVersion = safeVersion(row.output_profile_version);
  const appliedAt = canonicalTimestamp(row.applied_at_text);
  if (!UUID.test(row.id) || !UUID.test(row.feedback_event_id) || !UUID.test(row.user_id) ||
      !UUID.test(row.decision_id) || !UUID.test(row.profile_id) || !inputVersion || !outputVersion ||
      typeof row.changed !== 'boolean' || !SHA256.test(row.output_digest) || !appliedAt ||
      (row.changed ? outputVersion !== inputVersion + 1 : outputVersion !== inputVersion)) return null;
  return Object.freeze({
    id: row.id,
    feedbackEventId: row.feedback_event_id,
    userId: row.user_id,
    decisionId: row.decision_id,
    profileId: row.profile_id,
    inputProfileVersion: inputVersion,
    outputProfileVersion: outputVersion,
    changed: row.changed,
    outputDigest: row.output_digest,
    appliedAt,
  });
}

async function loadApplications(
  client: PoolClient,
  feedbackEventId: string,
): Promise<ApplicationWithTime[]> {
  return (await client.query<ApplicationWithTime>(
    `SELECT application.*,
            (application.applied_at AT TIME ZONE 'UTC')::STRING AS applied_at_text
       FROM twin_feedback_applications application
      WHERE application.feedback_event_id = $1
      ORDER BY application.id
      LIMIT 2 FOR UPDATE`,
    [feedbackEventId],
  )).rows;
}

async function loadProfileVersion(
  client: PoolClient,
  profileId: string,
  version: number,
): Promise<VersionWithTime | null> {
  const rows = (await client.query<VersionWithTime>(
    `SELECT history.*,
            (history.created_at AT TIME ZONE 'UTC')::STRING AS created_at_text
       FROM twin_profile_versions history
      WHERE history.profile_id = $1 AND history.version = $2
      ORDER BY history.id
      LIMIT 2`,
    [profileId, version],
  )).rows;
  return rows.length === 1 ? rows[0]! : null;
}

async function stateAtVersion(
  client: PoolClient,
  profile: TwinProfileRow,
  version: number,
): Promise<ProfileState | null> {
  const currentVersion = safeVersion(profile.version);
  if (!currentVersion || currentVersion < version) return null;
  if (currentVersion === version) return profileStateFromRow(profile);
  const historical = await loadProfileVersion(client, profile.id, version);
  return historical ? snapshotProfileState(historical.snapshot) : null;
}

async function verifyReplay(
  client: PoolClient,
  source: GmailArchiveApprovalCanonicalState,
  feedback: FeedbackWithTime,
  row: ApplicationWithTime,
): Promise<GmailArchiveFeedbackApplication | null> {
  const application = applicationSnapshot(row);
  if (!application || application.feedbackEventId !== feedback.id ||
      application.userId !== source.approval.user_id ||
      application.decisionId !== source.decision.id) return null;
  const profiles = (await client.query<TwinProfileRow>(
    'SELECT * FROM twin_profiles WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [application.profileId, application.userId],
  )).rows;
  if (profiles.length !== 1) return null;
  const profile = profiles[0]!;
  const inputState = await stateAtVersion(
    client, profile, application.inputProfileVersion,
  );
  const outputState = await stateAtVersion(
    client, profile, application.outputProfileVersion,
  );
  if (!inputState || !outputState) return null;
  const evidenceIds = new Set([source.signal.id, source.signal.source_signal_id].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ));
  const projection = projectProfile(
    inputState,
    feedback.type as 'approve' | 'reject',
    evidenceIds,
    source.decision.domain,
    application.appliedAt,
  );
  if (!projection || projection.changed !== application.changed ||
      canonicalJson(snapshotJson(projection.output)!) !== canonicalJson(snapshotJson(outputState)!) ||
      outputDigest(
        application.profileId,
        application.userId,
        application.outputProfileVersion,
        outputState,
      ) !== application.outputDigest) return null;
  if (application.changed) {
    const history = await loadProfileVersion(
      client, application.profileId, application.inputProfileVersion,
    );
    if (!history || !UUID.test(history.id) || safeVersion(history.version) !== application.inputProfileVersion ||
        history.reason !== `gmail_archive_feedback:${feedback.id}` ||
        history.changed_fields.length !== 1 || history.changed_fields[0] !== 'inferences' ||
        canonicalTimestamp(history.created_at_text) !== application.appliedAt ||
        canonicalJson(snapshotJson(history.snapshot)!) !== canonicalJson(snapshotJson(inputState)!)) return null;
  }
  return application;
}

async function transition(
  client: PoolClient,
  input: Readonly<ApplyGmailArchiveApprovalFeedbackInput>,
  ids: Readonly<StableIds>,
  hooks: ApplicationHooks = {},
): Promise<ApplyGmailArchiveApprovalFeedbackResult> {
  const hints = await loadFeedback(client, input, false);
  if (hints.length === 0) return Object.freeze({ ok: false, error: 'not_found' });
  if (hints.length !== 1) failIntegrity();
  const sourceInput = feedbackInput(hints[0]!);
  if (!sourceInput) failIntegrity();

  // Fixed lock order: approval/proposal barrier, feedback, application, profile.
  const source = await loadCanonicalGmailArchiveApprovalState(
    client,
    sourceInput,
    { allowExecutionPlan: true },
  );
  if (!source || source.approval.reason !== GMAIL_ARCHIVE_PROPOSAL_REASON) failIntegrity();
  const lockedFeedback = await loadFeedback(client, input, true);
  if (lockedFeedback.length !== 1) failIntegrity();
  const timestamp = (await client.query<{ matches: boolean }>(
    `SELECT feedback.created_at = approval.responded_at AS matches
       FROM feedback_events feedback
       JOIN approval_requests approval ON approval.id = feedback.approval_request_id
      WHERE feedback.id = $1 AND feedback.user_id = $2`,
    [input.feedbackEventId, input.userId],
  )).rows[0];
  if (!exactFeedback(lockedFeedback[0]!, source, input, timestamp?.matches === true)) {
    failIntegrity();
  }

  const existing = await loadApplications(client, input.feedbackEventId);
  if (existing.length > 1) failIntegrity();
  if (existing.length === 1) {
    const application = await verifyReplay(client, source, lockedFeedback[0]!, existing[0]!);
    if (!application) failIntegrity();
    return Object.freeze({ ok: true, created: false, application });
  }

  await client.query(
    `INSERT INTO twin_profiles (id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [ids.profile, input.userId],
  );
  const profiles = (await client.query<TwinProfileRow>(
    'SELECT * FROM twin_profiles WHERE user_id = $1 FOR UPDATE',
    [input.userId],
  )).rows;
  if (profiles.length !== 1) failIntegrity();
  const profile = profiles[0]!;
  const inputVersion = safeVersion(profile.version);
  const inputState = profileStateFromRow(profile);
  const appliedAt = await applicationTime(client);
  if (!inputVersion || !inputState || !appliedAt) failIntegrity();
  const evidenceIds = new Set([source.signal.id, source.signal.source_signal_id].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  ));
  const projection = projectProfile(
    inputState,
    lockedFeedback[0]!.type as 'approve' | 'reject',
    evidenceIds,
    source.decision.domain,
    appliedAt,
  );
  if (!projection) failIntegrity();
  const outputVersion = inputVersion + (projection.changed ? 1 : 0);

  if (projection.changed) {
    const insertedVersion = (await client.query<TwinProfileVersionRow>(
      `INSERT INTO twin_profile_versions (
         id, profile_id, version, snapshot, changed_fields, reason, created_at
       ) VALUES ($1, $2, $3, $4, ARRAY['inferences']::STRING[], $5, $6::TIMESTAMPTZ)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        ids.profileVersion,
        profile.id,
        inputVersion,
        JSON.stringify(inputState),
        `gmail_archive_feedback:${input.feedbackEventId}`,
        appliedAt,
      ],
    )).rows;
    if (insertedVersion.length !== 1 || insertedVersion[0]!.id !== ids.profileVersion) {
      failIntegrity();
    }
    const updated = (await client.query<TwinProfileRow>(
      `UPDATE twin_profiles
          SET inferences = $1, version = $2, updated_at = $3::TIMESTAMPTZ
        WHERE id = $4 AND user_id = $5 AND version = $6
        RETURNING *`,
      [
        JSON.stringify(projection.output.inferences),
        outputVersion,
        appliedAt,
        profile.id,
        input.userId,
        inputVersion,
      ],
    )).rows;
    if (updated.length !== 1 ||
        outputDigest(profile.id, input.userId, outputVersion, profileStateFromRow(updated[0]!)!) !==
          outputDigest(profile.id, input.userId, outputVersion, projection.output)) failIntegrity();
  }

  await hooks.afterProfileWrite?.();
  const digest = outputDigest(profile.id, input.userId, outputVersion, projection.output);
  const inserted = (await client.query<ApplicationWithTime>(
    `INSERT INTO twin_feedback_applications (
       id, feedback_event_id, user_id, decision_id, profile_id,
       input_profile_version, output_profile_version, changed, output_digest, applied_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::TIMESTAMPTZ)
     ON CONFLICT DO NOTHING
     RETURNING *, (applied_at AT TIME ZONE 'UTC')::STRING AS applied_at_text`,
    [
      ids.application,
      input.feedbackEventId,
      input.userId,
      source.decision.id,
      profile.id,
      inputVersion,
      outputVersion,
      projection.changed,
      digest,
      appliedAt,
    ],
  )).rows;
  if (inserted.length !== 1 || inserted[0]!.id !== ids.application) failIntegrity();
  const application = applicationSnapshot(inserted[0]!);
  if (!application || application.outputDigest !== digest) failIntegrity();
  return Object.freeze({ ok: true, created: true, application });
}

async function applyWithTransition(
  submitted: ApplyGmailArchiveApprovalFeedbackInput,
  runTransition: ApplicationTransition = transition,
  runTransaction: TransactionRunner = withTransaction,
  hooks: ApplicationHooks = {},
): Promise<ApplyGmailArchiveApprovalFeedbackResult> {
  const input = snapshotApplyInput(submitted);
  if (!input) return Object.freeze({ ok: false, error: 'invalid_input' });
  const ids = Object.freeze({
    application: randomUUID(),
    profile: randomUUID(),
    profileVersion: randomUUID(),
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTransaction((client) => runTransition(client, input, ids, hooks));
    } catch (error) {
      if (error instanceof RollbackResult) return error.result;
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== '40001' || attempt >= 2) throw error;
    }
  }
}

function cursorChecksum(payload: string): string {
  return createHash('sha256').update(`${CURSOR_PREFIX}.${payload}`, 'utf8').digest('base64url');
}

function encodeCursor(state: CursorState): GmailArchiveFeedbackPendingCursor {
  const payload = Buffer.from(JSON.stringify([state.createdAt, state.feedbackEventId]), 'utf8')
    .toString('base64url');
  return `${CURSOR_PREFIX}.${payload}.${cursorChecksum(payload)}` as GmailArchiveFeedbackPendingCursor;
}

function parseCursor(value: unknown): CursorState | null {
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? '') ||
      parts[2] !== cursorChecksum(parts[1]!)) return null;
  try {
    const decoded = Buffer.from(parts[1]!, 'base64url');
    if (decoded.toString('base64url') !== parts[1]) return null;
    const payload = JSON.parse(decoded.toString('utf8')) as unknown;
    if (!Array.isArray(payload) || payload.length !== 2 ||
        !canonicalTimestamp(payload[0]) || typeof payload[1] !== 'string' ||
        !UUID.test(payload[1])) return null;
    const state = Object.freeze({ createdAt: canonicalTimestamp(payload[0])!, feedbackEventId: payload[1] });
    return encodeCursor(state) === value ? state : null;
  } catch {
    return null;
  }
}

function snapshotListInput(value: unknown): Readonly<ListPendingGmailArchiveFeedbackInput> | null {
  const input = ownData(value, ['limit']) ?? ownData(value, ['cursor', 'limit']);
  if (!input || !Number.isSafeInteger(input['limit']) || (input['limit'] as number) < 1 ||
      (input['limit'] as number) > MAX_PAGE_LIMIT ||
      (Object.prototype.hasOwnProperty.call(input, 'cursor') && typeof input['cursor'] !== 'string')) {
    return null;
  }
  return Object.freeze({
    limit: input['limit'] as number,
    ...(typeof input['cursor'] === 'string'
      ? { cursor: input['cursor'] as GmailArchiveFeedbackPendingCursor }
      : {}),
  });
}

async function listPendingWithQuery(
  submitted: ListPendingGmailArchiveFeedbackInput,
  queryFn: typeof query = query,
): Promise<ListPendingGmailArchiveFeedbackResult> {
  const input = snapshotListInput(submitted);
  if (!input) return Object.freeze({ ok: false, error: 'invalid_input' });
  const cursor = input.cursor === undefined ? null : parseCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) {
    return Object.freeze({ ok: false, error: 'invalid_input' });
  }
  const result = await queryFn<PendingRow>(
    `SELECT feedback.user_id::STRING AS user_id,
            feedback.id::STRING AS feedback_event_id,
            (feedback.created_at AT TIME ZONE 'UTC')::STRING AS created_at_text
       FROM feedback_events feedback
       JOIN approval_requests approval
         ON approval.id = feedback.approval_request_id
        AND approval.user_id = feedback.user_id
        AND approval.decision_id = feedback.decision_id
        AND approval.reason = $1
        AND approval.candidate_action->>'actionType' = 'archive_email'
       LEFT JOIN twin_feedback_applications application
         ON application.feedback_event_id = feedback.id
      WHERE application.feedback_event_id IS NULL
        AND feedback.type IN ('approve', 'reject')
        AND approval.status = CASE feedback.type
              WHEN 'approve' THEN 'approved' ELSE 'rejected' END
        AND ($2::BOOL = false OR
             (feedback.created_at, feedback.id) > ($3::TIMESTAMPTZ, $4::UUID))
      ORDER BY feedback.created_at ASC, feedback.id ASC
      LIMIT $5`,
    [
      GMAIL_ARCHIVE_PROPOSAL_REASON,
      cursor !== null,
      cursor?.createdAt ?? null,
      cursor?.feedbackEventId ?? null,
      input.limit,
    ],
  );
  if (!Array.isArray(result.rows) || result.rows.length > input.limit) {
    return Object.freeze({ ok: false, error: 'integrity_conflict' });
  }
  const candidates: Readonly<PendingGmailArchiveFeedbackCandidate>[] = [];
  let previous = cursor;
  for (const value of result.rows) {
    const row = ownData(value, ['created_at_text', 'feedback_event_id', 'user_id']);
    const createdAt = canonicalTimestamp(row?.['created_at_text']);
    const feedbackEventId = row?.['feedback_event_id'];
    const userId = row?.['user_id'];
    if (!createdAt || typeof feedbackEventId !== 'string' || !UUID.test(feedbackEventId) ||
        typeof userId !== 'string' || !UUID.test(userId) ||
        (previous && (comparableTimestamp(createdAt) < comparableTimestamp(previous.createdAt) ||
          (comparableTimestamp(createdAt) === comparableTimestamp(previous.createdAt) &&
           feedbackEventId <= previous.feedbackEventId)))) {
      return Object.freeze({ ok: false, error: 'integrity_conflict' });
    }
    previous = { createdAt, feedbackEventId };
    candidates.push(Object.freeze({ userId, feedbackEventId }));
  }
  const nextCursor = candidates.length === input.limit && previous
    ? encodeCursor(previous)
    : null;
  return Object.freeze({
    ok: true,
    candidates: Object.freeze(candidates),
    nextCursor,
  });
}

export async function applyGmailArchiveApprovalFeedbackOnce(
  input: ApplyGmailArchiveApprovalFeedbackInput,
): Promise<ApplyGmailArchiveApprovalFeedbackResult> {
  return applyWithTransition(input);
}

export const gmailArchiveFeedbackApplicationRepository = Object.freeze({
  applyOnce: applyGmailArchiveApprovalFeedbackOnce,
  listPending: listPendingWithQuery,
});

export const gmailArchiveFeedbackApplicationTestHooks = Object.freeze({
  applyWithTransition,
  encodeCursor,
  listPendingWithQuery,
  outputDigest,
  parseCursor,
  projectProfile,
  snapshotApplyInput,
  snapshotProfileState,
  transition,
});
