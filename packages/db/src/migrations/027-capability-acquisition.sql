-- 027-capability-acquisition.sql
-- Foundation tables for the Capability Acquisition Loop epic (#195).
-- See docs/architecture-philosophy.md for the three-port thesis.
-- Issue references: #173 (this migration), #174 (capability inference),
-- #175 (idle miner), #178 (lifecycle), #183 (observability), #184 (provenance).
--
-- Additive only. Existing tables untouched. Down-migration drops the new
-- tables in reverse FK order.

-- ============================================================================
-- mcp_servers — installed MCP server instances per user
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registry_id STRING,                              -- e.g. "@modelcontextprotocol/server-filesystem"
  display_name STRING NOT NULL,
  transport STRING NOT NULL CHECK (transport IN ('stdio','http','sse')),
  command STRING,
  args JSONB NOT NULL DEFAULT '[]'::JSONB,
  env JSONB NOT NULL DEFAULT '{}'::JSONB,
  url STRING,
  oauth_provider STRING,
  oauth_token_id UUID REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  trust_tier STRING NOT NULL DEFAULT 'observer'
    CHECK (trust_tier IN ('observer','suggest','low_autonomy','moderate_autonomy','high_autonomy')),
  per_app_spend_per_action_cents INT,
  per_app_daily_spend_cents INT,
  per_app_monthly_spend_cents INT,
  per_app_monthly_rollover BOOL NOT NULL DEFAULT FALSE,
  per_app_irreversible_requires_approval BOOL,
  zero_trust_mode BOOL NOT NULL DEFAULT FALSE,
  status STRING NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered','installing','installed','authorized',
                      'active','paused','dormant','failed','uninstalled')),
  last_health_check_at TIMESTAMPTZ,
  health_status STRING,
  last_active_at TIMESTAMPTZ,
  installed_at TIMESTAMPTZ,
  uninstalled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, registry_id),
  INDEX (user_id, status)
);
-- Partial index — pulled out of CREATE TABLE because some CRDB versions
-- choke on inline `INDEX (...) WHERE ...`. Standalone form (matches the
-- pattern in 011-sessions.sql).
CREATE INDEX IF NOT EXISTS mcp_servers_active_last_active_idx
  ON mcp_servers (last_active_at) WHERE status = 'active';

-- ============================================================================
-- mcp_server_skills — cache of list_tools() results per installed server
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_server_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  skill_name STRING NOT NULL,
  skill_description STRING,
  input_schema JSONB,
  output_schema JSONB,
  is_destructive BOOL NOT NULL DEFAULT FALSE,
  is_irreversible BOOL NOT NULL DEFAULT FALSE,
  estimated_cost_cents INT,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, skill_name)
);

-- ============================================================================
-- app_suggestions — surfaced "want to install X?" rows
-- Populated by the capability inference engine (#174).
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registry_id STRING NOT NULL,
  display_name STRING NOT NULL,
  evidence_count INT NOT NULL DEFAULT 0,
  evidence_sources JSONB NOT NULL DEFAULT '[]'::JSONB,
  evidence_kinds_distinct INT NOT NULL DEFAULT 0,
  first_evidence_at TIMESTAMPTZ NOT NULL,
  last_evidence_at TIMESTAMPTZ NOT NULL,
  confidence_score DECIMAL(3,2) NOT NULL DEFAULT 0.0,
  status STRING NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dismissed','accepted','snoozed','superseded','auto-installed')),
  snoozed_until TIMESTAMPTZ,
  reason_summary STRING,
  push_notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Pulled out of CREATE TABLE for the same CRDB-compat reason as above.
CREATE INDEX IF NOT EXISTS app_suggestions_user_pending_idx
  ON app_suggestions (user_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS app_suggestions_user_pending_unique
  ON app_suggestions (user_id, registry_id) WHERE status = 'pending';

-- ============================================================================
-- capability_provenance_nodes/edges — graph of decisions, signals, actions
-- Populated by every capability-related event for the provenance feature (#184).
-- ============================================================================
CREATE TABLE IF NOT EXISTS capability_provenance_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_type STRING NOT NULL CHECK (node_type IN
    ('signal','entity','suggestion','install','tier_promotion','action','feedback','uninstall','external_agent')),
  ref_table STRING NOT NULL,
  ref_id UUID NOT NULL,
  server_id UUID REFERENCES mcp_servers(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, server_id, occurred_at)
);

CREATE TABLE IF NOT EXISTS capability_provenance_edges (
  from_node_id UUID NOT NULL REFERENCES capability_provenance_nodes(id) ON DELETE CASCADE,
  to_node_id UUID NOT NULL REFERENCES capability_provenance_nodes(id) ON DELETE CASCADE,
  edge_type STRING NOT NULL CHECK (edge_type IN
    ('contributed_to','triggered','authorized','executed_via','undid','superseded','delegated_via')),
  PRIMARY KEY (from_node_id, to_node_id, edge_type)
);

-- ============================================================================
-- fs_scan_roots / fs_file_index — idle filesystem miner state (#175)
-- ============================================================================
CREATE TABLE IF NOT EXISTS fs_scan_roots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_path STRING NOT NULL,
  enabled BOOL NOT NULL DEFAULT TRUE,
  source STRING NOT NULL DEFAULT 'fs' CHECK (source IN ('fs','browser_history')),
  last_scan_at TIMESTAMPTZ,
  last_scan_completed BOOL NOT NULL DEFAULT FALSE,
  resume_cursor STRING,
  bytes_today INT8 NOT NULL DEFAULT 0,
  bytes_total INT8 NOT NULL DEFAULT 0,
  files_total INT8 NOT NULL DEFAULT 0,
  rolling_day_started_at DATE NOT NULL DEFAULT current_date,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, root_path)
);

CREATE TABLE IF NOT EXISTS fs_file_index (
  root_id UUID NOT NULL REFERENCES fs_scan_roots(id) ON DELETE CASCADE,
  relative_path STRING NOT NULL,
  content_hash BYTES,
  size_bytes INT8 NOT NULL,
  mime_type STRING,
  last_seen_at TIMESTAMPTZ NOT NULL,
  skipped_reason STRING,
  PRIMARY KEY (root_id, relative_path)
);

-- ============================================================================
-- capability_recipes — curated bundles ("Developer pack", etc.)
-- Note: per architecture-philosophy, recipes will become prompt-driven (#189);
-- this table is a v1 vehicle for the static JSON recipes shipped in #181.
-- ============================================================================
CREATE TABLE IF NOT EXISTS capability_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug STRING NOT NULL UNIQUE,
  display_name STRING NOT NULL,
  description STRING NOT NULL,
  registry_ids STRING[] NOT NULL,
  category STRING,
  is_featured BOOL NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- twin_briefings — daily/weekly LLM-prose summaries (#177)
-- ============================================================================
CREATE TABLE IF NOT EXISTS twin_briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cadence STRING NOT NULL CHECK (cadence IN ('daily','weekly')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prose_markdown STRING NOT NULL,
  source_event_count INT NOT NULL,
  llm_provider STRING,
  llm_cost_cents INT,
  read_at TIMESTAMPTZ,
  UNIQUE (user_id, cadence, generated_at)
);

-- ============================================================================
-- mcp_server_metrics — per-server rollup for observability (#183)
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_server_metrics (
  server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  bucket_started_at TIMESTAMPTZ NOT NULL,
  bucket_duration STRING NOT NULL CHECK (bucket_duration IN ('1m','1h','1d')),
  invocations_total INT NOT NULL DEFAULT 0,
  invocations_failed INT NOT NULL DEFAULT 0,
  latency_p50_ms INT,
  latency_p95_ms INT,
  latency_p99_ms INT,
  bytes_in INT8 NOT NULL DEFAULT 0,
  bytes_out INT8 NOT NULL DEFAULT 0,
  spend_cents INT NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, bucket_started_at, bucket_duration)
);

-- ============================================================================
-- dxt_exports — DXT artifact store (#180)
-- ============================================================================
CREATE TABLE IF NOT EXISTS dxt_exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  artifact_blob BYTES NOT NULL,
  artifact_sha256 BYTES NOT NULL
);
