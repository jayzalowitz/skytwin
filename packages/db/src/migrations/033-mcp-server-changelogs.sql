-- 033-mcp-server-changelogs.sql
-- Stores the most recent changelog snapshot for each installed MCP server.
-- One row per server. Updated on install, on list_tools refresh, and on the
-- weekly worker sweep.
--
-- Issue #184 AC#2 — Capability changelog flow + new-skill opt-in.

CREATE TABLE IF NOT EXISTS mcp_server_changelogs (
  server_id UUID PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
  current_version STRING,
  raw_text STRING,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_skills JSONB NOT NULL DEFAULT '[]',
  last_known_destructive_skills JSONB NOT NULL DEFAULT '[]'
);

-- Pending opt-in prompts for newly added destructive skills. The user must
-- explicitly accept before the new skill becomes callable on this server.
CREATE TABLE IF NOT EXISTS pending_skill_opt_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  skill_name STRING NOT NULL,
  changelog_version STRING,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  UNIQUE (server_id, skill_name)
);

CREATE INDEX IF NOT EXISTS pending_skill_opt_ins_pending_idx
  ON pending_skill_opt_ins (server_id) WHERE accepted_at IS NULL AND rejected_at IS NULL;
