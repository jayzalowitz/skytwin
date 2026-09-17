-- Bind authoring mutations to a durable per-user key so a lost HTTP response
-- cannot create a second immutable version or proposal on retry (#753).

ALTER TABLE workflow_proposals
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

ALTER TABLE workflow_proposals
  ADD COLUMN IF NOT EXISTS request_hash STRING;

ALTER TABLE workflow_proposals
  ADD CONSTRAINT IF NOT EXISTS workflow_proposals_idempotency_shape CHECK (
    (idempotency_key IS NULL AND request_hash IS NULL)
    OR (idempotency_key IS NOT NULL AND request_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX IF NOT EXISTS workflow_proposals_user_idempotency_unique
  ON workflow_proposals (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
