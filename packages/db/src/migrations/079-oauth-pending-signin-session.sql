-- Keep the pending handoff available for a bounded idempotency window. The
-- session bearer is deterministically derived server-side from the pending
-- capability, while this FK records whether its session was already minted.
ALTER TABLE oauth_pending_signin
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions(id) ON DELETE SET NULL;

-- Migration 059 stored the raw UUID capability in pending_key. The handoff has
-- a five-minute TTL, so invalidate only those legacy-shaped rows during the
-- digest transition. This predicate is deliberately idempotent: the migration
-- runner may revisit SQL files, and canonical 64-hex digest rows must survive.
DELETE FROM oauth_pending_signin
 WHERE length(pending_key) <> 64
    OR pending_key !~ '^[0-9a-f]{64}$';

CREATE INDEX IF NOT EXISTS oauth_pending_signin_session_idx
  ON oauth_pending_signin (session_id)
  WHERE session_id IS NOT NULL;
