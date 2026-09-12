-- Availability index for bounded, stable Gmail archive recovery discovery.
-- Discovery grants no recovery authority; exact lease acquisition still
-- validates the complete owner/approval graph and DB-clock grace.

CREATE INDEX IF NOT EXISTS pre_effect_barriers_gmail_archive_recovery_scan_idx
  ON pre_effect_barriers (updated_at, id)
  STORING (user_id, idempotency_key, status)
  WHERE effect_type = 'event_execution'
    AND status IN ('reserved', 'prepared', 'in_progress');
