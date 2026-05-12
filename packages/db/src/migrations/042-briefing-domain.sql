-- 042-briefing-domain.sql
-- #193 follow-up: per-Lifebook briefings.
--
-- Today every twin_briefings row is a *global* briefing summarizing
-- the user's whole capability surface. The Emergent Lifebooks epic
-- (#193 Child 1) wants a per-domain variant: a briefing scoped to one
-- detected life domain, rendered on the Lifebook page so the user can
-- see what their twin has been up to within Health, Money, etc.
--
-- Schema-wise: a nullable `domain_name` column on the existing table.
-- NULL means "global briefing" (the existing semantic, untouched). A
-- string value means "per-Lifebook briefing scoped to that domain
-- name" — matching the canonical name used elsewhere
-- (lifebooks.domain_name).
--
-- We deliberately don't FK to lifebooks(domain_name) because:
--   1. (user_id, domain_name) on lifebooks is UNIQUE, but the
--      lifebooks row may be soft-hidden (hidden_at NOT NULL) — the
--      briefing should survive the hide so the user's history is
--      preserved.
--   2. If the domain extractor renames a domain in a future run, the
--      briefing's domain_name becomes orphaned but still readable as
--      a historical artifact.
-- Both behaviors are intentional. Use the index below to fetch
-- per-domain briefings efficiently.

ALTER TABLE twin_briefings
  ADD COLUMN IF NOT EXISTS domain_name STRING;

-- Partial index keyed on (user_id, domain_name, generated_at DESC).
-- Only domain-scoped rows participate; global briefings (domain_name
-- IS NULL) stay served by the existing (user_id, generated_at)
-- ordering. Partial index keeps storage and write overhead minimal.
CREATE INDEX IF NOT EXISTS twin_briefings_user_domain_idx
  ON twin_briefings (user_id, domain_name, generated_at DESC)
  WHERE domain_name IS NOT NULL;
