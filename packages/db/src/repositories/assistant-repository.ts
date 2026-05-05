import { query, withTransaction } from '../connection.js';

/**
 * Public message shape returned from the repo. Mirrors the DB row but with
 * camelCase + Date-typed timestamps so callers don't have to repeat the
 * snake_case → camelCase juggle. Issue #135 phase 1.
 */
export interface AssistantMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
}

export interface AssistantThread {
  id: string;
  userId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

interface AssistantThreadRow {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface AssistantMessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: Date;
  metadata: Record<string, unknown> | null;
}

function rowToThread(row: AssistantThreadRow): AssistantThread {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: AssistantMessageRow): AssistantMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as AssistantMessage['role'],
    content: row.content,
    createdAt: row.created_at,
    metadata: row.metadata,
  };
}

/**
 * Compose a thread title from the first user message.
 *
 * Capped at 80 chars for the threads list UI; first newline ends the title.
 * Trimmed. If the message is empty (shouldn't happen after validation) we
 * fall back to a generic label so the title column is never empty.
 */
export function deriveThreadTitle(firstMessage: string): string {
  const firstLine = firstMessage.split(/\r?\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  if (trimmed.length === 0) return 'New conversation';
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}…`;
}

/**
 * CRUD for the conversational assistant. Issue #135 phase 1.
 *
 * Threads are per-user (no sharing). Messages are append-only inside a
 * thread; deletion happens at the thread granularity (cascades messages).
 *
 * The repo never enforces ownership — that's the route layer's job (via
 * `requireOwnership` middleware). Repo callers are responsible for passing
 * a `userId` they've already verified the request authenticates against.
 */
export const assistantRepository = {
  /** Create a new thread, deriving a title from the first user message. */
  async createThread(userId: string, firstMessage: string): Promise<AssistantThread> {
    const result = await query<AssistantThreadRow>(
      `INSERT INTO assistant_threads (user_id, title)
       VALUES ($1, $2)
       RETURNING id, user_id, title, created_at, updated_at`,
      [userId, deriveThreadTitle(firstMessage)],
    );
    return rowToThread(result.rows[0]!);
  },

  /** List a user's threads, most-recently-active first. */
  async listThreads(userId: string, limit = 50): Promise<AssistantThread[]> {
    const result = await query<AssistantThreadRow>(
      `SELECT id, user_id, title, created_at, updated_at
         FROM assistant_threads
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(rowToThread);
  },

  /**
   * Fetch one thread + its messages. Returns null when the thread doesn't
   * exist OR when it exists but isn't owned by `userId` — callers cannot
   * distinguish, which is intentional (information-leak hygiene: don't tell
   * a probing caller "this thread exists, you just can't see it").
   */
  async getThread(
    userId: string,
    threadId: string,
  ): Promise<{ thread: AssistantThread; messages: AssistantMessage[] } | null> {
    const threadResult = await query<AssistantThreadRow>(
      `SELECT id, user_id, title, created_at, updated_at
         FROM assistant_threads
        WHERE id = $1 AND user_id = $2`,
      [threadId, userId],
    );
    const threadRow = threadResult.rows[0];
    if (!threadRow) return null;

    const msgResult = await query<AssistantMessageRow>(
      `SELECT id, thread_id, role, content, created_at, metadata
         FROM assistant_messages
        WHERE thread_id = $1
        ORDER BY created_at ASC`,
      [threadId],
    );
    return {
      thread: rowToThread(threadRow),
      messages: msgResult.rows.map(rowToMessage),
    };
  },

  /**
   * Delete a thread (and cascade its messages). Returns true if a row was
   * removed; false if the thread didn't exist or wasn't owned by the user.
   * Same don't-leak-existence semantics as `getThread`.
   */
  async deleteThread(userId: string, threadId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM assistant_threads WHERE id = $1 AND user_id = $2`,
      [threadId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Append a message to a thread and bump its `updated_at` so it sorts to
   * the top of the threads list. Returns the inserted message.
   *
   * Wrapped in a transaction so the message insert and the parent
   * `updated_at` bump are atomic — without the transaction, a race could
   * leave a thread with messages but a stale `updated_at`, demoting it
   * unfairly in the list ordering.
   */
  async appendMessage(
    threadId: string,
    role: AssistantMessage['role'],
    content: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<AssistantMessage> {
    return withTransaction(async (client) => {
      const inserted = await client.query<AssistantMessageRow>(
        `INSERT INTO assistant_messages (thread_id, role, content, metadata)
         VALUES ($1, $2, $3, $4)
         RETURNING id, thread_id, role, content, created_at, metadata`,
        [threadId, role, content, metadata ? JSON.stringify(metadata) : null],
      );
      await client.query(
        `UPDATE assistant_threads SET updated_at = now() WHERE id = $1`,
        [threadId],
      );
      return rowToMessage(inserted.rows[0]!);
    });
  },
};
