-- Tracks when SkyTwin service credentials were last synced into IronClaw.

ALTER TABLE service_credentials ADD COLUMN IF NOT EXISTS ironclaw_synced_at TIMESTAMPTZ;
