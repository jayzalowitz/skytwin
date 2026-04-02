-- Migration 010: Preference Evolution History
-- Tracks how preferences change over time with attribution to the feedback
-- or evidence that caused the change.

-- Step 1: Create the table
CREATE TABLE IF NOT EXISTS preference_history (
  id STRING PRIMARY KEY DEFAULT gen_random_uuid()::STRING,
  preference_id STRING NOT NULL,
  user_id STRING NOT NULL,
  previous_value JSONB,
  new_value JSONB NOT NULL,
  previous_confidence STRING,
  new_confidence STRING NOT NULL,
  attribution_type STRING NOT NULL,  -- 'feedback', 'evidence', 'explicit', 'inference'
  attribution_id STRING,             -- ID of the feedback event or evidence that triggered the change
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  INDEX idx_preference_history_preference (preference_id, changed_at DESC),
  INDEX idx_preference_history_user (user_id, changed_at DESC),
  INDEX idx_preference_history_attribution (attribution_type, attribution_id)
);

-- Step 2: Verify the table exists
SELECT count(*) FROM preference_history WHERE 1 = 0;
