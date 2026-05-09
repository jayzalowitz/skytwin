-- 038-crisis-modes.sql
-- Crisis modes: recovery codes + vacation mode (#194 Child 3 partial).
--
-- RECOVERY CODES
--
-- At first run (or on user request), the API generates 10 single-use
-- recovery codes. The codes are SHA-256-hashed before persisting; the
-- plaintext is shown to the user exactly once and then dropped.
--
-- Redeeming a code rotates the vault passphrase to a fresh random one
-- and surfaces it to the user. The redeemed row is marked `used_at`;
-- the same code cannot be reused.
--
-- We do NOT store the plaintext code or any reversible representation.
-- The hash is what we compare against on redemption (timing-safe).

CREATE TABLE IF NOT EXISTS recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash BYTES NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  used_for STRING                  -- 'vault-unlock' | 'rotate-passphrase' | future
);

CREATE INDEX IF NOT EXISTS recovery_codes_user_active_idx
  ON recovery_codes (user_id, used_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS recovery_codes_user_all_idx
  ON recovery_codes (user_id, created_at DESC);

-- VACATION MODE
--
-- A timestamp on `users` indicating "I'm on vacation until <ts>" — when
-- present and in the future, the decision-engine reads this and shifts
-- the user's risk profile to act more autonomously within bounded spend
-- caps. Setting to NULL deactivates immediately.
--
-- Rather than a separate enum or boolean we use the deadline directly so
-- the decision engine can render a count-down ("vacation mode active for
-- 3 more days") without an extra column.

ALTER TABLE users ADD COLUMN IF NOT EXISTS vacation_mode_until TIMESTAMPTZ;
