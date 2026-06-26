import { describe, expect, it } from 'vitest';
import { buildExecutableActionPlan } from '../action-capabilities.js';
import { buildMemoryActionFingerprint } from '../memory-action-loop.js';

describe('buildMemoryActionFingerprint', () => {
  it('is stable regardless of memory ref ordering', () => {
    const a = buildMemoryActionFingerprint({
      actionPlan: buildExecutableActionPlan('draft_email', 'draft reply'),
      memoryRefs: ['page-b', 'page-a'],
      sourceRefs: [],
      novelty: 'connection',
    });
    const b = buildMemoryActionFingerprint({
      actionPlan: buildExecutableActionPlan('draft_email', 'draft reply'),
      memoryRefs: ['page-a', 'page-b'],
      sourceRefs: [],
      novelty: 'connection',
    });
    expect(a).toBe(b);
  });

  it('changes when the action type changes', () => {
    const refs = ['page-a'];
    expect(buildMemoryActionFingerprint({
      actionPlan: buildExecutableActionPlan('draft_email', 'draft reply'),
      memoryRefs: refs,
      sourceRefs: [],
      novelty: 'resurface',
    })).not.toBe(buildMemoryActionFingerprint({
      actionPlan: buildExecutableActionPlan('create_task', 'create task'),
      memoryRefs: refs,
      sourceRefs: [],
      novelty: 'resurface',
    }));
  });
});
