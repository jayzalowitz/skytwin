/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../screens/ChatScreen.tsx', import.meta.url), 'utf8');

describe('mobile chat request identity lifecycle', () => {
  it('restores the pending owner-bound identity on remount', () => {
    expect(source).toContain('loadPendingAssistantRequest(session.userId)');
    expect(source).toContain('threadIdRef.current = pending.threadId ?? undefined');
    expect(source).toContain('setInput(pending.content)');
    expect(source).toContain('setRequestIdentityReady(true)');
    expect(source).toContain('!content || sending || !requestIdentityReady');
  });

  it('persists the identity before network dispatch', () => {
    expect(source.indexOf('savePendingAssistantRequest(session.userId, requestIdentity)'))
      .toBeLessThan(source.indexOf('client.sendAssistantMessage('));
  });

  it('retires stored identity only on definite outcomes or edits', () => {
    expect(source).toContain('shouldRetireAssistantRequestIdentity(result.statusCode, result.code)');
    expect(source).toContain('clearPendingAssistantRequest(pendingOwnerRef.current)');
  });
});
