-- 031-external-agent-tokens.sql
-- Tokens that allow external MCP agents (Claude Desktop, Cursor, Cline)
-- to authenticate to the SkyTwin Twin MCP server (issue #182).
--
-- Tokens are 32-byte random hex values. Only the SHA-256 hash is stored here.
-- The plaintext is returned once at issuance and never stored.
-- Revocation is immediate: lookup checks revoked_at IS NULL.

CREATE TABLE IF NOT EXISTS external_agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTES NOT NULL,
  scope STRING NOT NULL CHECK (scope IN ('read', 'propose', 'subscribe')),
  agent_name STRING NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS external_agent_tokens_user_idx
  ON external_agent_tokens (user_id) WHERE revoked_at IS NULL;
