-- User-scoped client request identity for retry-safe assistant action routing.
ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS user_id UUID;

ALTER TABLE assistant_messages
  ADD CONSTRAINT IF NOT EXISTS assistant_messages_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS client_request_id UUID;

ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS request_processing_token UUID;

ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS request_processing_started_at TIMESTAMPTZ;

UPDATE assistant_messages
   SET request_processing_started_at = created_at
 WHERE client_request_id IS NOT NULL
   AND role = 'user'
   AND request_processing_started_at IS NULL;

UPDATE assistant_messages AS message
   SET user_id = thread.user_id
  FROM assistant_threads AS thread
  JOIN users AS owner ON owner.id = thread.user_id
 WHERE message.thread_id = thread.id
   AND message.user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assistant_messages_user_request_unique_idx
  ON assistant_messages (user_id, client_request_id, role)
  WHERE client_request_id IS NOT NULL;
