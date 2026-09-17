import { assistantPendingRequestKey } from './storage-keys.js';
import { SAMPLE_USER_ID } from './sample-session.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validIdentity(value, userId) {
  return value && typeof value === 'object' && value.userId === userId &&
    typeof value.requestId === 'string' && UUID_V4.test(value.requestId) &&
    typeof value.content === 'string' && value.content.trim() === value.content &&
    value.content.length > 0 &&
    (value.threadId === null || typeof value.threadId === 'string');
}

function requestStorage(userId) {
  return userId === SAMPLE_USER_ID ? sessionStorage : localStorage;
}

/** Restore only a structurally valid identity belonging to the active user. */
export function readPendingAssistantRequest(userId) {
  const key = assistantPendingRequestKey(userId);
  const storage = requestStorage(userId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!validIdentity(value, userId)) {
      storage.removeItem(key);
      return null;
    }
    return {
      requestId: value.requestId,
      content: value.content,
      threadId: value.threadId,
    };
  } catch {
    try { storage.removeItem(key); } catch { /* unavailable storage */ }
    return null;
  }
}

/** Persist before dispatch; false means the caller must fail closed. */
export function writePendingAssistantRequest(userId, identity) {
  if (!validIdentity({ ...identity, userId }, userId)) return false;
  const storage = requestStorage(userId);
  try {
    storage.setItem(
      assistantPendingRequestKey(userId),
      JSON.stringify({ userId, ...identity }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearPendingAssistantRequest(userId, expectedRequestId = null) {
  const key = assistantPendingRequestKey(userId);
  const storage = requestStorage(userId);
  try {
    if (expectedRequestId) {
      const raw = storage.getItem(key);
      if (!raw) return;
      const current = JSON.parse(raw);
      if (current?.requestId !== expectedRequestId) return;
    }
    storage.removeItem(key);
  } catch { /* noop */ }
}
