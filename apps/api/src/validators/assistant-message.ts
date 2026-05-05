/**
 * Runtime validation for `POST /api/assistant/messages` payloads.
 *
 * Hand-rolled to match the convention set by `event-ingest.ts` — adding
 * Zod for one more endpoint isn't worth the runtime dep yet. Issue #135
 * phase 1.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Maximum bytes for a single user message. Generous (this is conversational
 * input, not bulk paste) but bounded so a client can't ship a 10MB blob
 * that costs a fortune in LLM tokens AND clogs the DB row size. CRDB string
 * columns are bounded by `kv.raft.command.max_size` in practice — 16K is
 * well under that.
 */
const MAX_CONTENT_BYTES = 16_000;

export type AssistantMessageValidationResult =
  | {
      ok: true;
      userId: string;
      content: string;
      threadId: string | null;
    }
  | {
      ok: false;
      errors: Array<{ field: string; message: string }>;
    };

export function validateAssistantMessage(raw: unknown): AssistantMessageValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [{ field: '_body', message: 'Request body must be a JSON object' }],
    };
  }

  const body = raw as Record<string, unknown>;
  const userId = body['userId'];
  const content = body['content'];
  const threadId = body['threadId'];

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    errors.push({ field: 'userId', message: 'userId is required and must be a non-empty string' });
  } else if (!UUID_REGEX.test(userId)) {
    errors.push({ field: 'userId', message: 'userId must be a valid UUID' });
  }

  if (typeof content !== 'string') {
    errors.push({ field: 'content', message: 'content is required and must be a string' });
  } else {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      errors.push({ field: 'content', message: 'content cannot be empty or whitespace only' });
    } else if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      errors.push({
        field: 'content',
        message: `content exceeds the ${MAX_CONTENT_BYTES} byte limit`,
      });
    }
  }

  // threadId is optional — a missing/null value means "start a new thread."
  // Empty string is rejected explicitly so a malformed client request
  // doesn't silently get a fresh thread when the user expected to continue
  // an existing one.
  let normalizedThreadId: string | null = null;
  if (threadId !== undefined && threadId !== null) {
    if (typeof threadId !== 'string') {
      errors.push({ field: 'threadId', message: 'threadId must be a string when provided' });
    } else if (threadId.trim().length === 0) {
      errors.push({
        field: 'threadId',
        message: 'threadId cannot be empty — omit the field to start a new thread',
      });
    } else if (!UUID_REGEX.test(threadId)) {
      errors.push({ field: 'threadId', message: 'threadId must be a valid UUID' });
    } else {
      normalizedThreadId = threadId;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    userId: userId as string,
    content: (content as string).trim(),
    threadId: normalizedThreadId,
  };
}
