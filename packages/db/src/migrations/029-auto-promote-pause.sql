-- 029-auto-promote-pause.sql
-- Adds auto_promote_paused_until column to mcp_servers for the tier promotion
-- ceremony decline flow (issue #177). When set, the server will not have
-- auto-promotion ceremony surfaced until after this timestamp.
--
-- Additive only. Existing rows get NULL (promotion ceremony not paused).

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS auto_promote_paused_until TIMESTAMPTZ;
