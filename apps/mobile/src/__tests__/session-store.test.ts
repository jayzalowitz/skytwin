import { beforeEach, describe, expect, it, vi } from 'vitest';

const secure = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
const requestStore = vi.hoisted(() => ({ clearPendingAssistantRequestStrict: vi.fn() }));

vi.mock('expo-secure-store', () => secure);
vi.mock('../services/assistant-request-store', () => requestStore);

const { clearSession } = await import('../services/session-store');

describe('mobile session store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secure.getItemAsync.mockImplementation(async (key: string) =>
      key === 'skytwin_user_id' ? 'user-a' : null,
    );
  });

  it('clears pending assistant content before removing session identity', async () => {
    await clearSession();

    expect(requestStore.clearPendingAssistantRequestStrict).toHaveBeenCalledWith('user-a');
    expect(requestStore.clearPendingAssistantRequestStrict.mock.invocationCallOrder[0])
      .toBeLessThan(secure.deleteItemAsync.mock.invocationCallOrder[0]!);
  });

  it('keeps the session when pending content cannot be removed', async () => {
    requestStore.clearPendingAssistantRequestStrict.mockRejectedValueOnce(new Error('unavailable'));

    await expect(clearSession()).rejects.toThrow('unavailable');

    expect(secure.deleteItemAsync).not.toHaveBeenCalled();
  });
});
