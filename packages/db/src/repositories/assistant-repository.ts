import { query, withTransaction } from '../connection.js';
import { randomUUID } from 'node:crypto';

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
  clientRequestId?: string | null;
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
  client_request_id?: string | null;
  request_processing_token?: string | null;
  request_processing_started_at?: Date | null;
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
    clientRequestId: row.client_request_id ?? null,
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
 * Legacy thread CRUD relies on route-layer ownership checks. The idempotent
 * request-key methods additionally bind every lookup and insert to the owning
 * user in SQL, because that key is part of the execution safety boundary.
 */
export const assistantRepository = {
  /** Atomically create a new thread and its first idempotent user message. */
  async createThreadWithUserMessage(
    userId: string,
    content: string,
    clientRequestId: string,
  ): Promise<{ thread: AssistantThread; message: AssistantMessage; created: boolean }> {
    const processingToken = randomUUID();
    try {
      return await withTransaction(async (client) => {
        const threadResult = await client.query<AssistantThreadRow>(
          `INSERT INTO assistant_threads (user_id, title)
           VALUES ($1, $2)
           RETURNING id, user_id, title, created_at, updated_at`,
          [userId, deriveThreadTitle(content)],
        );
        const thread = rowToThread(threadResult.rows[0]!);
        const messageResult = await client.query<AssistantMessageRow>(
          `INSERT INTO assistant_messages
             (thread_id, role, content, metadata, user_id, client_request_id,
              request_processing_token, request_processing_started_at)
           VALUES ($1, 'user', $2, NULL, $3, $4, $5, now())
           ON CONFLICT (user_id, client_request_id, role) WHERE client_request_id IS NOT NULL
           DO NOTHING
           RETURNING id, thread_id, role, content, created_at, metadata, client_request_id,
                     request_processing_token`,
          [thread.id, content, userId, clientRequestId, processingToken],
        );
        if (!messageResult.rows[0]) throw new Error('assistant_request_already_owned');
        return { thread, message: rowToMessage(messageResult.rows[0]), created: true };
      });
    } catch {
      const existing = await query<AssistantMessageRow>(
        `SELECT id, thread_id, role, content, created_at, metadata, client_request_id,
                request_processing_token
           FROM assistant_messages
          WHERE user_id = $1 AND client_request_id = $2 AND role = 'user'`,
        [userId, clientRequestId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('assistant_message_append_failed');
      const thread = await this.getThread(userId, row.thread_id);
      if (!thread) throw new Error('assistant_message_append_failed');
      return {
        thread: thread.thread,
        message: rowToMessage(row),
        created: row.request_processing_token === processingToken,
      };
    }
  },

  /** Find the durable user message for a client retry key, scoped to its owner. */
  async findUserMessageByRequestId(
    userId: string,
    clientRequestId: string,
  ): Promise<AssistantMessage | null> {
    const result = await query<AssistantMessageRow>(
      `SELECT id, thread_id, role, content, created_at, metadata, client_request_id
         FROM assistant_messages
        WHERE user_id = $1 AND client_request_id = $2 AND role = 'user'`,
      [userId, clientRequestId],
    );
    return result.rows[0] ? rowToMessage(result.rows[0]) : null;
  },

  async findAssistantMessageByRequestId(
    userId: string,
    clientRequestId: string,
  ): Promise<AssistantMessage | null> {
    const result = await query<AssistantMessageRow>(
      `SELECT id, thread_id, role, content, created_at, metadata, client_request_id
         FROM assistant_messages
        WHERE user_id = $1 AND client_request_id = $2 AND role = 'assistant'`,
      [userId, clientRequestId],
    );
    return result.rows[0] ? rowToMessage(result.rows[0]) : null;
  },

  /**
   * Append a user message once. A retry (including after a lost commit
   * response) receives the already-committed message and therefore reuses the
   * same downstream decision/barrier idempotency key.
   */
  async appendOrGetUserMessage(
    userId: string,
    threadId: string,
    content: string,
    clientRequestId: string,
  ): Promise<{ message: AssistantMessage; created: boolean }> {
    const processingToken = randomUUID();
    try {
      return await withTransaction(async (client) => {
        const inserted = await client.query<AssistantMessageRow>(
          `INSERT INTO assistant_messages
             (thread_id, role, content, metadata, user_id, client_request_id,
              request_processing_token, request_processing_started_at)
           SELECT $1, 'user', $2, NULL, $3, $4, $5, now()
             FROM assistant_threads
            WHERE id = $1 AND user_id = $3
           ON CONFLICT (user_id, client_request_id, role) WHERE client_request_id IS NOT NULL
           DO NOTHING
           RETURNING id, thread_id, role, content, created_at, metadata, client_request_id,
                     request_processing_token`,
          [threadId, content, userId, clientRequestId, processingToken],
        );
        const row = inserted.rows[0];
        if (row) {
          await client.query(
            `UPDATE assistant_threads SET updated_at = now() WHERE id = $1 AND user_id = $2`,
            [threadId, userId],
          );
          return { message: rowToMessage(row), created: true };
        }
        const existing = await client.query<AssistantMessageRow>(
          `SELECT id, thread_id, role, content, created_at, metadata, client_request_id,
                    request_processing_token
             FROM assistant_messages
            WHERE user_id = $1 AND client_request_id = $2 AND role = 'user'`,
          [userId, clientRequestId],
        );
        if (!existing.rows[0]) throw new Error('assistant_idempotency_conflict');
        return {
          message: rowToMessage(existing.rows[0]),
          created: existing.rows[0].request_processing_token === processingToken,
        };
      });
    } catch {
      const existing = await query<AssistantMessageRow>(
        `SELECT id, thread_id, role, content, created_at, metadata, client_request_id,
                request_processing_token
           FROM assistant_messages
          WHERE user_id = $1 AND client_request_id = $2 AND role = 'user'`,
        [userId, clientRequestId],
      );
      if (existing.rows[0]) return {
        message: rowToMessage(existing.rows[0]),
        created: existing.rows[0].request_processing_token === processingToken,
      };
      throw new Error('assistant_message_append_failed');
    }
  },

  /** Adopt a request whose prior owner stopped before writing a response. */
  async claimStaleUserMessageRequest(
    userId: string,
    clientRequestId: string,
  ): Promise<boolean> {
    const processingToken = randomUUID();
    const result = await query<{ id: string }>(
      `UPDATE assistant_messages
          SET request_processing_token = $3, request_processing_started_at = now()
        WHERE user_id = $1 AND client_request_id = $2 AND role = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM assistant_messages response
             WHERE response.user_id = $1
               AND response.client_request_id = $2
               AND response.role = 'assistant'
          )
          AND request_processing_started_at < now() - INTERVAL '30 seconds'
        RETURNING id`,
      [userId, clientRequestId, processingToken],
    );
    return Boolean(result.rows[0]);
  },

  async appendOrGetAssistantMessage(
    userId: string,
    threadId: string,
    content: string,
    clientRequestId: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<AssistantMessage> {
    try {
      const inserted = await withTransaction(async (client) => {
        const result = await client.query<AssistantMessageRow>(
          `INSERT INTO assistant_messages
             (thread_id, role, content, metadata, user_id, client_request_id)
           SELECT $1, 'assistant', $2, $3, $4, $5
             FROM assistant_threads
            WHERE id = $1 AND user_id = $4
           ON CONFLICT (user_id, client_request_id, role) WHERE client_request_id IS NOT NULL
           DO NOTHING
           RETURNING id, thread_id, role, content, created_at, metadata, client_request_id`,
          [threadId, content, metadata ? JSON.stringify(metadata) : null, userId, clientRequestId],
        );
        if (!result.rows[0]) return null;
        await client.query(
          `UPDATE assistant_threads SET updated_at = now() WHERE id = $1 AND user_id = $2`,
          [threadId, userId],
        );
        return rowToMessage(result.rows[0]);
      });
      if (inserted) return inserted;
    } catch {
      // The insert may have committed before its response was lost.
    }
    const existing = await this.findAssistantMessageByRequestId(userId, clientRequestId);
    if (existing?.threadId === threadId) return existing;
    throw new Error('assistant_message_append_failed');
  },

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
