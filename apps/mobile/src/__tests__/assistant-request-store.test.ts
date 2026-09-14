import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { values.delete(key); }),
}));

const {
  clearPendingAssistantRequest,
  clearPendingAssistantRequestStrict,
  loadPendingAssistantRequest,
  savePendingAssistantRequest,
} = await import('../services/assistant-request-store');

const IDENTITY = {
  requestId: '11111111-2222-4333-8444-555555555555',
  content: 'archive that message',
  threadId: 'thread-1',
};

describe('mobile assistant request store', () => {
  beforeEach(() => values.clear());

  it('restores the same owner-bound identity after remount', async () => {
    await savePendingAssistantRequest('user-a', IDENTITY);
    await expect(loadPendingAssistantRequest('user-a')).resolves.toEqual(IDENTITY);
    await expect(loadPendingAssistantRequest('user-b')).resolves.toBeNull();
  });

  it('retains an updated thread binding', async () => {
    await savePendingAssistantRequest('user-a', { ...IDENTITY, threadId: null });
    await savePendingAssistantRequest('user-a', IDENTITY);
    await expect(loadPendingAssistantRequest('user-a')).resolves.toMatchObject({
      requestId: IDENTITY.requestId,
      threadId: 'thread-1',
    });
  });

  it('clears only the selected owner identity', async () => {
    await savePendingAssistantRequest('user-a', IDENTITY);
    await savePendingAssistantRequest('user-b', { ...IDENTITY, content: 'different owner' });
    await clearPendingAssistantRequest('user-a');
    await expect(loadPendingAssistantRequest('user-a')).resolves.toBeNull();
    await expect(loadPendingAssistantRequest('user-b')).resolves.not.toBeNull();
  });

  it('serializes an edit clear before the next dispatch save', async () => {
    await savePendingAssistantRequest('user-a', IDENTITY);
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const secureStore = await import('expo-secure-store');
    vi.mocked(secureStore.deleteItemAsync).mockImplementationOnce(async (key: string) => {
      await deleteGate;
      values.delete(key);
    });

    const clearing = clearPendingAssistantRequest('user-a');
    const nextIdentity = { ...IDENTITY, content: 'edited message' };
    const saving = savePendingAssistantRequest('user-a', nextIdentity);
    releaseDelete?.();
    await Promise.all([clearing, saving]);

    await expect(loadPendingAssistantRequest('user-a')).resolves.toEqual(nextIdentity);
  });

  it('does not let an older completion erase a newer request identity', async () => {
    await savePendingAssistantRequest('user-a', IDENTITY);
    const newer = {
      ...IDENTITY,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content: 'new logical message',
    };
    await savePendingAssistantRequest('user-a', newer);

    await clearPendingAssistantRequest('user-a', IDENTITY.requestId);

    await expect(loadPendingAssistantRequest('user-a')).resolves.toEqual(newer);
  });

  it('does not treat an unavailable secure store as an empty identity slot', async () => {
    const secureStore = await import('expo-secure-store');
    vi.mocked(secureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(loadPendingAssistantRequest('user-a')).rejects.toThrow(
      'assistant_request_store_unavailable',
    );
  });

  it('reports a strict account-exit deletion failure and retains the record', async () => {
    await savePendingAssistantRequest('user-a', IDENTITY);
    const secureStore = await import('expo-secure-store');
    vi.mocked(secureStore.deleteItemAsync).mockRejectedValueOnce(new Error('keychain unavailable'));

    await expect(clearPendingAssistantRequestStrict('user-a')).rejects.toThrow(
      'keychain unavailable',
    );
    await expect(loadPendingAssistantRequest('user-a')).resolves.toEqual(IDENTITY);
  });
});
