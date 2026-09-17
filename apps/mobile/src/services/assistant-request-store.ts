import * as SecureStore from 'expo-secure-store';
import type { AssistantRequestIdentity } from './api-client';

const KEY_PREFIX = 'skytwin_assistant_pending_request_';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let operationQueue: Promise<void> = Promise.resolve();

interface StoredAssistantRequest extends AssistantRequestIdentity {
  userId: string;
}

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function isValid(value: unknown, userId: string): value is StoredAssistantRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate['userId'] === userId &&
    typeof candidate['requestId'] === 'string' && UUID_V4.test(candidate['requestId']) &&
    typeof candidate['content'] === 'string' && candidate['content'].length > 0 &&
    candidate['content'].trim() === candidate['content'] &&
    (candidate['threadId'] === null || candidate['threadId'] === undefined ||
      typeof candidate['threadId'] === 'string');
}

export async function loadPendingAssistantRequest(
  userId: string,
): Promise<AssistantRequestIdentity | null> {
  return enqueueOperation(async () => {
    const key = keyFor(userId);
    let raw: string | null;
    try {
      raw = await SecureStore.getItemAsync(key);
    } catch {
      throw new Error('assistant_request_store_unavailable');
    }
    if (!raw) return null;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      await SecureStore.deleteItemAsync(key);
      return null;
    }
    if (!isValid(value, userId)) {
      await SecureStore.deleteItemAsync(key);
      return null;
    }
    return {
      requestId: value.requestId,
      content: value.content,
      threadId: value.threadId ?? null,
    };
  });
}

export async function savePendingAssistantRequest(
  userId: string,
  identity: AssistantRequestIdentity,
): Promise<void> {
  const value: StoredAssistantRequest = { userId, ...identity };
  if (!isValid(value, userId)) throw new Error('invalid_assistant_request_identity');
  await enqueueOperation(() => SecureStore.setItemAsync(keyFor(userId), JSON.stringify(value)));
}

async function deletePendingAssistantRequest(
  userId: string | null,
  expectedRequestId: string | null = null,
): Promise<void> {
  if (!userId) return;
  await enqueueOperation(async () => {
    const key = keyFor(userId);
    if (expectedRequestId) {
      const raw = await SecureStore.getItemAsync(key);
      if (!raw) return;
      try {
        const current = JSON.parse(raw) as { requestId?: unknown };
        if (current.requestId !== expectedRequestId) return;
      } catch {
        return;
      }
    }
    await SecureStore.deleteItemAsync(key);
  });
}

export async function clearPendingAssistantRequest(
  userId: string | null,
  expectedRequestId: string | null = null,
): Promise<void> {
  try {
    await deletePendingAssistantRequest(userId, expectedRequestId);
  } catch {
    // A stale identity can only cause a completed replay, not a new action.
  }
}

/** Explicit account exit must confirm content deletion before dropping ownership. */
export async function clearPendingAssistantRequestStrict(
  userId: string | null,
): Promise<void> {
  await deletePendingAssistantRequest(userId);
}
