-- 030-onboarding-state.sql
-- Tracks whether a user has completed the first-run wizard.
-- first_run_choice records which onboarding path the user took.
-- selected_recipe_slug stores the recipe they were presented with (if any).

CREATE TABLE IF NOT EXISTS user_onboarding_state (
  user_id          UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_first_run     BOOL        NOT NULL DEFAULT TRUE,
  first_run_choice STRING      CHECK (first_run_choice IN ('email','computer','about-me')),
  selected_recipe_slug STRING,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
