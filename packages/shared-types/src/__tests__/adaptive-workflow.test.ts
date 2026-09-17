import { describe, expect, it } from 'vitest';
import {
  canonicalizeWorkflowPayload,
  snapshotWorkflowAuthoringMetadata,
  snapshotWorkflowInferenceMetadata,
  workflowVersionContentHash,
} from '../adaptive-workflow.js';

describe('adaptive workflow persistence values', () => {
  it('canonicalizes nested payload keys without mutating the caller', () => {
    const input = { z: [{ b: 2, a: 1 }], a: -0 };
    const canonical = canonicalizeWorkflowPayload(input);
    expect(JSON.stringify(canonical)).toBe('{"a":0,"z":[{"a":1,"b":2}]}');
    expect(Object.keys(input)).toEqual(['z', 'a']);
  });

  it('rejects non-JSON and cyclic payload values', () => {
    expect(() => canonicalizeWorkflowPayload({ missing: undefined })).toThrow(/only JSON values/);
    expect(() => canonicalizeWorkflowPayload({ date: new Date() })).toThrow(/plain JSON objects/);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalizeWorkflowPayload(cyclic)).toThrow(/cycles/);
    let deeplyNested: Record<string, unknown> = {};
    const root = deeplyNested;
    for (let depth = 0; depth < 70; depth += 1) {
      const child: Record<string, unknown> = {};
      deeplyNested['child'] = child;
      deeplyNested = child;
    }
    expect(() => canonicalizeWorkflowPayload(root)).toThrow(/64 levels/);
  });

  it('hashes semantic content independently of object insertion order', () => {
    const first = workflowVersionContentHash({
      providerKey: 'signal_digest',
      providerSchemaVersion: 'v1',
      canonicalPayload: { schedule: { hour: 8, timezone: 'UTC' }, keywords: ['invoice'] },
    });
    const second = workflowVersionContentHash({
      providerKey: 'signal_digest',
      providerSchemaVersion: 'v1',
      canonicalPayload: { keywords: ['invoice'], schedule: { timezone: 'UTC', hour: 8 } },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allows only closed, reference-only authoring metadata', () => {
    expect(snapshotWorkflowAuthoringMetadata({
      version: 1,
      source: 'llm_assisted',
      sourceReferences: [{ kind: 'message', id: 'thread/message-1' }],
    })).toEqual({
      version: 1,
      source: 'llm_assisted',
      sourceReferences: [{ kind: 'message', id: 'thread/message-1' }],
    });
    expect(() => snapshotWorkflowAuthoringMetadata({
      version: 1,
      source: 'user',
      sourceReferences: [],
      prompt: 'secret',
    } as never)).toThrow(/unsupported field/);
  });

  it('snapshots inference identity while rejecting raw or malformed fields', () => {
    const metadata = {
      version: 1 as const,
      reasoningMode: 'on_device' as const,
      provider: 'embedded',
      model: 'local-model',
      runtimeVersion: 'llama.cpp-1',
      promptVersion: 'signal-digest-authoring.v1',
      outputSchemaVersion: 'v1',
      requestSha256: 'a'.repeat(64),
    };
    expect(snapshotWorkflowInferenceMetadata(metadata)).toEqual(metadata);
    expect(() => snapshotWorkflowInferenceMetadata({
      ...metadata,
      rawResponse: 'not allowed',
    } as never)).toThrow(/unsupported field/);
    expect(() => snapshotWorkflowInferenceMetadata({
      ...metadata,
      requestSha256: 'not-a-digest',
    })).toThrow(/lowercase SHA-256/);
  });
});
