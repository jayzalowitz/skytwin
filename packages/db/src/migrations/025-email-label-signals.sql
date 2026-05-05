-- 025-email-label-signals.sql
-- Per-user, per-sender label observations from Gmail history.
--
-- Issue #122: inferLabels() in decision-maker is a hardcoded subject-keyword
-- classifier — every user sees the same five `if (subject.includes(...))`
-- clauses. The Twin can't tell that mail from blackrockrangers.org gets a
-- 'rangers' label and reply, while mail from user.luma-mail.com gets archived.
--
-- This table accumulates the evidence: every Gmail message we observe (via
-- the history-API poll in @skytwin/connectors) contributes one row per
-- (sender, label) tuple, with a count we increment on subsequent observations.
-- The `decision-engine` queries `topLabelsForSender(userId, sender)` when
-- proposing a label_email candidate, replacing the keyword model.
--
-- Sender is normalized to the bare email address (no display name) — the
-- connector strips the `Display Name <addr@host>` form before recording.
-- list_id is the parsed RFC 2919 List-Id header value when present
-- (mailing-list traffic), null otherwise.
--
-- Compound primary key (user_id, sender, label) gives us idempotent UPSERT
-- on observation. The (user_id, sender) prefix supports the hot-path
-- "top labels for this sender" query without a separate index.

CREATE TABLE IF NOT EXISTS email_label_signals (
  user_id        UUID        NOT NULL,
  sender         STRING      NOT NULL,
  label          STRING      NOT NULL,
  list_id        STRING,
  count          INT         NOT NULL DEFAULT 1,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender, label)
);

-- Lookup by list_id (mailing-list traffic) when sender varies but List-Id
-- is stable. Used as a secondary signal in inferLabels().
CREATE INDEX IF NOT EXISTS email_label_signals_user_listid_idx
  ON email_label_signals (user_id, list_id)
  WHERE list_id IS NOT NULL;
