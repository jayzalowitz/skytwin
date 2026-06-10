-- 063-user-locale-timezone.sql
-- Per-user language + timezone (spec 12, #486).
--
-- `language` drives the daily-briefing prose locale (was hardcoded 'en' in
-- briefing-generator.ts) and lets the extraction layer route non-English
-- content to the LLM path instead of the English-only rule fallbacks.
-- `timezone` resolves relative deadlines (spec 03 — "by Friday", "end of day")
-- to the user's clock instead of UTC.
--
-- Both nullable: populated from the connector identity (Google profile locale,
-- primary-calendar timezone) when available, with safe fallbacks resolved in
-- code (language -> 'en', timezone -> 'UTC' with a logged warning). Existing
-- rows backfill NULL and fall back at read time — no data migration needed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language STRING;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone STRING;
