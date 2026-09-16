-- 089-watch-scheduled-slots.sql
-- Make every scheduled Watch firing durable before the worker reads signals.
-- The slot carries immutable window bounds and a snapshot of the read-only
-- matching spec, so a lease retry evaluates the same work even after an edit.

ALTER TABLE watches ADD COLUMN IF NOT EXISTS schedule_revision UUID;

UPDATE watches SET schedule_revision = gen_random_uuid() WHERE schedule_revision IS NULL;

ALTER TABLE watches ALTER COLUMN schedule_revision SET DEFAULT gen_random_uuid();
ALTER TABLE watches ALTER COLUMN schedule_revision SET NOT NULL;

-- Normalize legacy/manual JSON into the same four-array shape accepted by the
-- API. Blank and non-string entries cannot narrow a match and are discarded;
-- unknown keys are not part of the Watch filter contract.
UPDATE watches
   SET filter = jsonb_build_object(
     'sources', COALESCE((
       SELECT jsonb_agg(value)
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(filter->'sources') = 'array'
             THEN filter->'sources' ELSE '[]'::JSONB END
         ) AS entry(value)
        WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> ''
     ), '[]'::JSONB),
     'fromContains', COALESCE((
       SELECT jsonb_agg(value)
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(filter->'fromContains') = 'array'
             THEN filter->'fromContains' ELSE '[]'::JSONB END
         ) AS entry(value)
        WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> ''
     ), '[]'::JSONB),
     'keywords', COALESCE((
       SELECT jsonb_agg(value)
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(filter->'keywords') = 'array'
             THEN filter->'keywords' ELSE '[]'::JSONB END
         ) AS entry(value)
        WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> ''
     ), '[]'::JSONB),
     'domains', COALESCE((
       SELECT jsonb_agg(value)
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(filter->'domains') = 'array'
             THEN filter->'domains' ELSE '[]'::JSONB END
         ) AS entry(value)
        WHERE jsonb_typeof(value) = 'string' AND btrim(value #>> '{}') <> ''
     ), '[]'::JSONB)
   );

-- Close the read/check/write race between activating a Watch and editing its
-- filter. Existing broad active rows are made inert before the invariant is
-- installed; drafts remain editable.
UPDATE watches
   SET status = 'draft', next_run_at = NULL, updated_at = now()
 WHERE status = 'active'
   AND jsonb_array_length(filter->'sources') = 0
   AND jsonb_array_length(filter->'fromContains') = 0
   AND jsonb_array_length(filter->'keywords') = 0
   AND jsonb_array_length(filter->'domains') = 0;

ALTER TABLE watches ADD CONSTRAINT IF NOT EXISTS watches_active_filter_chk
  CHECK (
    jsonb_typeof(filter) = 'object'
    AND jsonb_typeof(filter->'sources') = 'array'
    AND jsonb_typeof(filter->'fromContains') = 'array'
    AND jsonb_typeof(filter->'keywords') = 'array'
    AND jsonb_typeof(filter->'domains') = 'array'
    AND (filter - 'sources' - 'fromContains' - 'keywords' - 'domains') = '{}'::JSONB
    AND (
      status <> 'active'
      OR jsonb_array_length(filter->'sources') > 0
      OR jsonb_array_length(filter->'fromContains') > 0
      OR jsonb_array_length(filter->'keywords') > 0
      OR jsonb_array_length(filter->'domains') > 0
    )
  );

ALTER TABLE watches ADD CONSTRAINT IF NOT EXISTS watches_id_user_uniq UNIQUE (id, user_id);

ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS schedule_revision UUID;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS window_end TIMESTAMPTZ;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS watch_spec JSONB;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS slot_status STRING;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS attempt_count INT;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE watch_runs ADD COLUMN IF NOT EXISTS last_error STRING;

-- The Watch owns the slot. A historical owner mismatch cannot be relabelled:
-- its summary/evidence may have come from the other user's signals. Delete the
-- ambiguous row before installing the composite ownership foreign key.
DELETE FROM watch_runs AS wr
 USING watches AS w
 WHERE w.id = wr.watch_id
   AND wr.user_id <> w.user_id;

WITH legacy_slots AS (
  SELECT id,
         row_number() OVER (PARTITION BY watch_id ORDER BY ran_at, id) - 1 AS tie_offset
    FROM watch_runs
   WHERE scheduled_for IS NULL
)
UPDATE watch_runs AS wr
   SET schedule_revision = COALESCE(wr.schedule_revision, gen_random_uuid()),
       scheduled_for = COALESCE(
         wr.scheduled_for,
         wr.ran_at + (legacy_slots.tie_offset * INTERVAL '1 microsecond')
       ),
       window_start = COALESCE(wr.window_start, wr.ran_at),
       window_end = COALESCE(wr.window_end, wr.ran_at),
       watch_spec = COALESCE(
         wr.watch_spec,
         jsonb_build_object(
           'name', w.name,
           'cadence', w.cadence,
           'hourOfDay', w.hour_of_day,
           'dayOfWeek', w.day_of_week,
           'filter', w.filter,
           'action', w.action
         )
       ),
       slot_status = COALESCE(wr.slot_status, 'completed'),
       attempt_count = COALESCE(wr.attempt_count, 1),
       completed_at = COALESCE(wr.completed_at, wr.ran_at)
  FROM watches AS w, legacy_slots
 WHERE w.id = wr.watch_id
   AND legacy_slots.id = wr.id;

ALTER TABLE watch_runs ALTER COLUMN schedule_revision SET NOT NULL;
ALTER TABLE watch_runs ALTER COLUMN scheduled_for SET NOT NULL;
ALTER TABLE watch_runs ALTER COLUMN window_start SET NOT NULL;
ALTER TABLE watch_runs ALTER COLUMN window_end SET NOT NULL;
ALTER TABLE watch_runs ALTER COLUMN watch_spec SET NOT NULL;
ALTER TABLE watch_runs ALTER COLUMN slot_status SET DEFAULT 'processing';
ALTER TABLE watch_runs ALTER COLUMN slot_status SET NOT NULL;
ALTER TABLE watch_runs ALTER COLUMN attempt_count SET DEFAULT 0;
ALTER TABLE watch_runs ALTER COLUMN attempt_count SET NOT NULL;

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_scheduled_for_uniq
  UNIQUE (watch_id, scheduled_for);

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_watch_owner_fk
  FOREIGN KEY (watch_id, user_id) REFERENCES watches (id, user_id) ON DELETE CASCADE;

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_slot_status_chk
  CHECK (slot_status IN ('pending', 'processing', 'completed', 'failed'));

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_window_chk
  CHECK (window_start <= window_end);

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_attempt_count_chk
  CHECK (attempt_count >= 0);

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_processing_lease_chk
  CHECK (
    slot_status <> 'processing'
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_pending_lease_chk
  CHECK (
    slot_status <> 'pending'
    OR (lease_token IS NULL AND lease_expires_at IS NOT NULL)
  );

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_completed_at_chk
  CHECK (slot_status <> 'completed' OR completed_at IS NOT NULL);

ALTER TABLE watch_runs ADD CONSTRAINT IF NOT EXISTS watch_runs_failed_at_chk
  CHECK (slot_status <> 'failed' OR (failed_at IS NOT NULL AND last_error IS NOT NULL));

CREATE INDEX IF NOT EXISTS watch_runs_reclaim_idx
  ON watch_runs (slot_status, lease_expires_at, scheduled_for);

CREATE INDEX IF NOT EXISTS watch_runs_zero_match_gc_idx
  ON watch_runs (slot_status, matched_count, completed_at);
