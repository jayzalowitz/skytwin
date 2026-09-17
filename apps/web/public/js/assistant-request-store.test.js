// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingAssistantRequest,
  readPendingAssistantRequest,
  writePendingAssistantRequest,
} from './assistant-request-store.js';
import { clearSampleSession, SAMPLE_USER_ID } from './sample-session.js';

const IDENTITY = {
  requestId: '11111111-2222-4333-8444-555555555555',
  content: 'archive that message',
  threadId: 'thread-1',
};

describe('assistant request identity store', () => {
  const values = new Map();
  const sampleValues = new Map();

  beforeEach(() => {
    values.clear();
    sampleValues.clear();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sampleValues.get(key) ?? null),
      setItem: vi.fn((key, value) => sampleValues.set(key, String(value))),
      removeItem: vi.fn((key) => sampleValues.delete(key)),
    });
  });

  it('restores an owner-bound identity after module state is lost', () => {
    expect(writePendingAssistantRequest('user-a', IDENTITY)).toBe(true);
    expect(readPendingAssistantRequest('user-a')).toEqual(IDENTITY);
    expect(readPendingAssistantRequest('user-b')).toBeNull();
  });

  it('persists a thread binding learned after dispatch', () => {
    expect(writePendingAssistantRequest('user-a', { ...IDENTITY, threadId: null })).toBe(true);
    expect(writePendingAssistantRequest('user-a', IDENTITY)).toBe(true);
    expect(readPendingAssistantRequest('user-a')?.threadId).toBe('thread-1');
  });

  it('rejects malformed stored identities instead of reusing them', () => {
    values.set('skytwin_assistant_pending_request_user-a', JSON.stringify({
      userId: 'user-a', requestId: 'not-a-uuid', content: 'archive that message', threadId: null,
    }));
    expect(readPendingAssistantRequest('user-a')).toBeNull();
  });

  it('clears a terminal identity', () => {
    expect(writePendingAssistantRequest('user-a', IDENTITY)).toBe(true);
    clearPendingAssistantRequest('user-a');
    expect(readPendingAssistantRequest('user-a')).toBeNull();
  });

  it('does not let an older completion erase a newer request identity', () => {
    expect(writePendingAssistantRequest('user-a', IDENTITY)).toBe(true);
    const newer = {
      ...IDENTITY,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content: 'new logical message',
    };
    expect(writePendingAssistantRequest('user-a', newer)).toBe(true);

    clearPendingAssistantRequest('user-a', IDENTITY.requestId);

    expect(readPendingAssistantRequest('user-a')).toEqual(newer);
  });

  it('keeps sample content tab-local and removes it on sample exit', () => {
    expect(writePendingAssistantRequest(SAMPLE_USER_ID, IDENTITY)).toBe(true);
    expect(values.size).toBe(0);
    expect(readPendingAssistantRequest(SAMPLE_USER_ID)).toEqual(IDENTITY);

    clearSampleSession();

    expect(readPendingAssistantRequest(SAMPLE_USER_ID)).toBeNull();
  });
});
