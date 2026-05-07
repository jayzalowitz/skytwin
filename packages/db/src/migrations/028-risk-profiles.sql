-- 028-risk-profiles.sql
-- User-stated risk profile for the Capability Acquisition Loop (#190).
-- See docs/architecture-philosophy.md "Risk profile" section.
--
-- Free-form text describing autonomy preferences in plain English.
-- The text is the canonical source of truth; interpreted_caps is a
-- hot-path-readable structured projection produced by the LLM
-- risk-profile-interpretation prompt (#185).
--
-- Hard rails are NEVER subject to the risk profile, even on maximum
-- boldness. The interpreted_caps may only narrow autonomy below the
-- user-global AutonomySettings caps; it cannot widen.

CREATE TABLE IF NOT EXISTS user_risk_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_text STRING NOT NULL DEFAULT '',
  interpreted_caps JSONB NOT NULL DEFAULT '{}'::JSONB,
  last_interpreted_at TIMESTAMPTZ,
  last_model_version STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
