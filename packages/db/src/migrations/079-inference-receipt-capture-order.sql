-- Preserve provider-call order independently of transaction timestamps. Every
-- row inserted by one atomic capture otherwise receives the same now().
ALTER TABLE inference_receipts
  ADD COLUMN IF NOT EXISTS capture_ordinal INT;

WITH ranked AS (
  SELECT id,
    (row_number() OVER (
      PARTITION BY decision_id ORDER BY created_at ASC, id ASC
    ) - 1)::INT AS capture_ordinal
  FROM inference_receipts
)
UPDATE inference_receipts AS receipt
SET capture_ordinal = ranked.capture_ordinal
FROM ranked
WHERE receipt.id = ranked.id AND receipt.capture_ordinal IS NULL;

ALTER TABLE inference_receipts
  ALTER COLUMN capture_ordinal SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS inference_receipts_decision_capture_ordinal_key
  ON inference_receipts (decision_id, capture_ordinal);
