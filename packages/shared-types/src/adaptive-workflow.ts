import { createHash } from 'node:crypto';
import type { ReasoningMode } from './reasoning-mode.js';

export type WorkflowJsonPrimitive = string | number | boolean | null;
export type WorkflowJsonValue =
  | WorkflowJsonPrimitive
  | WorkflowJsonValue[]
  | { [key: string]: WorkflowJsonValue };
export interface WorkflowJsonObject {
  [key: string]: WorkflowJsonValue;
}

export type WorkflowAuthoringSource =
  | 'user'
  | 'llm_assisted'
  | 'feedback_revision'
  | 'migration'
  | 'import';

export type WorkflowSourceReferenceKind =
  | 'message'
  | 'signal'
  | 'feedback'
  | 'watch'
  | 'import';

export interface WorkflowSourceReferenceV1 {
  kind: WorkflowSourceReferenceKind;
  id: string;
}

/**
 * Closed, portable authoring metadata. It deliberately carries references,
 * never source bodies, prompts, credentials, tokens, or provider responses.
 */
export interface WorkflowAuthoringMetadataV1 {
  version: 1;
  source: WorkflowAuthoringSource;
  sourceReferences: WorkflowSourceReferenceV1[];
}

/**
 * Audit-safe inference identity for an authored version. Raw requests,
 * responses, endpoints, API keys, and chain-of-thought are not representable.
 */
export interface WorkflowInferenceMetadataV1 {
  version: 1;
  reasoningMode: ReasoningMode;
  provider: string;
  model: string;
  runtimeVersion: string;
  /** Exact digest of a verified managed local model artifact, when applicable. */
  modelArtifactSha256?: string;
  promptVersion: string;
  outputSchemaVersion: string;
  requestSha256?: string;
  responseSha256?: string;
}

export interface AdaptiveWorkflow {
  id: string;
  userId: string;
  providerKey: string;
  activeVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdaptiveWorkflowVersion {
  id: string;
  workflowId: string;
  userId: string;
  versionNumber: number;
  providerKey: string;
  providerSchemaVersion: string;
  canonicalPayload: WorkflowJsonObject;
  contentHash: string;
  parentVersionId: string | null;
  authoring: WorkflowAuthoringMetadataV1;
  inference: WorkflowInferenceMetadataV1 | null;
  createdAt: Date;
}

export type WorkflowProposalKind = 'initial' | 'edit' | 'feedback' | 'import';

export interface AdaptiveWorkflowProposal {
  id: string;
  workflowId: string;
  userId: string;
  baseVersionId: string | null;
  proposedVersionId: string;
  kind: WorkflowProposalKind;
  createdAt: Date;
}

export type WorkflowActivationKind = 'activate' | 'rollback';

export interface WorkflowActivationEvent {
  id: string;
  workflowId: string;
  userId: string;
  /** Monotonic, one-based transition order within the workflow. */
  sequence: number;
  previousVersionId: string | null;
  activatedVersionId: string;
  proposalId: string | null;
  kind: WorkflowActivationKind;
  createdAt: Date;
}

export const MAX_WORKFLOW_PAYLOAD_BYTES = 256 * 1024;
export const MAX_WORKFLOW_PAYLOAD_DEPTH = 64;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const REASONING_MODES: ReadonlySet<ReasoningMode> = new Set([
  'on_device',
  'verified_private_cloud',
  'bring_your_own_provider',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): WorkflowJsonValue {
  if (depth > MAX_WORKFLOW_PAYLOAD_DEPTH) {
    throw new RangeError(`Workflow payload exceeds ${MAX_WORKFLOW_PAYLOAD_DEPTH} levels`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Workflow payload numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Workflow payload must contain only JSON values');
  }
  if (ancestors.has(value)) throw new TypeError('Workflow payload must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalizeValue(entry, ancestors, depth + 1));
    }
    if (!isPlainObject(value)) {
      throw new TypeError('Workflow payload objects must be plain JSON objects');
    }
    const canonical: WorkflowJsonObject = {};
    for (const key of Object.keys(value).sort()) {
      canonical[key] = canonicalizeValue(value[key], ancestors, depth + 1);
    }
    return canonical;
  } finally {
    ancestors.delete(value);
  }
}

/** Return a detached, key-sorted JSON object suitable for hashing and JSONB. */
export function canonicalizeWorkflowPayload(value: unknown): WorkflowJsonObject {
  if (!isPlainObject(value)) throw new TypeError('Workflow payload must be a JSON object');
  const canonical = canonicalizeValue(value, new Set(), 0);
  const encoded = JSON.stringify(canonical);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_WORKFLOW_PAYLOAD_BYTES) {
    throw new RangeError(`Workflow payload exceeds ${MAX_WORKFLOW_PAYLOAD_BYTES} bytes`);
  }
  return canonical as WorkflowJsonObject;
}

export function assertWorkflowProviderIdentity(
  providerKey: string,
  providerSchemaVersion: string,
): void {
  if (!KEY_PATTERN.test(providerKey)) {
    throw new TypeError('Workflow provider key has an invalid shape');
  }
  if (!VERSION_PATTERN.test(providerSchemaVersion)) {
    throw new TypeError('Workflow provider schema version has an invalid shape');
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new TypeError(`${name} contains an unsupported field`);
  }
}

export function snapshotWorkflowAuthoringMetadata(
  value: WorkflowAuthoringMetadataV1,
): WorkflowAuthoringMetadataV1 {
  if (!isPlainObject(value)) throw new TypeError('Workflow authoring metadata must be an object');
  assertExactKeys(value, ['version', 'source', 'sourceReferences'], 'Workflow authoring metadata');
  const sources: readonly WorkflowAuthoringSource[] = [
    'user', 'llm_assisted', 'feedback_revision', 'migration', 'import',
  ];
  if (value.version !== 1 || !sources.includes(value.source)) {
    throw new TypeError('Workflow authoring metadata has an unsupported version or source');
  }
  if (!Array.isArray(value.sourceReferences) || value.sourceReferences.length > 256) {
    throw new TypeError('Workflow authoring source references must be a bounded array');
  }
  const referenceKinds: readonly WorkflowSourceReferenceKind[] = [
    'message', 'signal', 'feedback', 'watch', 'import',
  ];
  const sourceReferences = value.sourceReferences.map((reference) => {
    if (!isPlainObject(reference)) throw new TypeError('Workflow source reference must be an object');
    assertExactKeys(reference, ['kind', 'id'], 'Workflow source reference');
    if (!referenceKinds.includes(reference.kind as WorkflowSourceReferenceKind)
      || typeof reference.id !== 'string'
      || !REFERENCE_ID_PATTERN.test(reference.id)) {
      throw new TypeError('Workflow source reference has an invalid shape');
    }
    return { kind: reference.kind as WorkflowSourceReferenceKind, id: reference.id };
  });
  return { version: 1, source: value.source, sourceReferences };
}

export function snapshotWorkflowInferenceMetadata(
  value: WorkflowInferenceMetadataV1 | null | undefined,
): WorkflowInferenceMetadataV1 | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new TypeError('Workflow inference metadata must be an object');
  assertExactKeys(value, [
    'version', 'reasoningMode', 'provider', 'model', 'runtimeVersion', 'modelArtifactSha256',
    'promptVersion', 'outputSchemaVersion', 'requestSha256', 'responseSha256',
  ], 'Workflow inference metadata');
  if (value.version !== 1 || !REASONING_MODES.has(value.reasoningMode)) {
    throw new TypeError('Workflow inference metadata has an unsupported version or reasoning mode');
  }
  for (const [name, entry] of Object.entries({
    provider: value.provider,
    model: value.model,
    runtimeVersion: value.runtimeVersion,
    promptVersion: value.promptVersion,
    outputSchemaVersion: value.outputSchemaVersion,
  })) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256) {
      throw new TypeError(`Workflow inference ${name} has an invalid shape`);
    }
  }
  for (const digest of [value.modelArtifactSha256, value.requestSha256, value.responseSha256]) {
    if (digest !== undefined && !SHA256_PATTERN.test(digest)) {
      throw new TypeError('Workflow inference digest must be lowercase SHA-256');
    }
  }
  return {
    version: 1,
    reasoningMode: value.reasoningMode,
    provider: value.provider,
    model: value.model,
    runtimeVersion: value.runtimeVersion,
    ...(value.modelArtifactSha256 === undefined
      ? {}
      : { modelArtifactSha256: value.modelArtifactSha256 }),
    promptVersion: value.promptVersion,
    outputSchemaVersion: value.outputSchemaVersion,
    ...(value.requestSha256 === undefined ? {} : { requestSha256: value.requestSha256 }),
    ...(value.responseSha256 === undefined ? {} : { responseSha256: value.responseSha256 }),
  };
}

export function workflowVersionContentHash(input: {
  providerKey: string;
  providerSchemaVersion: string;
  canonicalPayload: WorkflowJsonObject;
}): string {
  assertWorkflowProviderIdentity(input.providerKey, input.providerSchemaVersion);
  const canonicalPayload = canonicalizeWorkflowPayload(input.canonicalPayload);
  return createHash('sha256').update(JSON.stringify({
    providerKey: input.providerKey,
    providerSchemaVersion: input.providerSchemaVersion,
    canonicalPayload,
  }), 'utf8').digest('hex');
}
