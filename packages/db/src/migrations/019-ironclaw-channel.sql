-- Per-user IronClaw channel preference for multi-channel execution.

ALTER TABLE users ADD COLUMN IF NOT EXISTS ironclaw_channel STRING DEFAULT 'skytwin';
