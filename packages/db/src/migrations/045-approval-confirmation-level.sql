-- Dual-confirmation support for the documentary-poisoning injection guard.
--
-- The injection guard (packages/policy-engine checkInjectionGuard) escalates
-- extreme-severity actions — shell execution, recursive filesystem deletion,
-- DB drops, account deletion — to a TWO-step confirmation. A single click is
-- not enough; the user must confirm, receive a one-time token, and confirm
-- again with that token before the action executes.
--
-- `confirmation_level` defaults to 'single' so every pre-existing approval and
-- every ordinary escalation behaves exactly as before — only actions the guard
-- flags as extreme are written with 'dual'.

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS confirmation_level STRING NOT NULL DEFAULT 'single';

-- Set when the first of a dual-confirmation pair lands. NULL means no first
-- confirmation yet (or the request is single-confirmation).
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS first_confirmed_at TIMESTAMPTZ;

-- One-time token issued on the first confirmation of a dual request. The
-- second confirmation must present this exact token, which proves two
-- distinct deliberate actions rather than one double-fired click.
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS confirmation_token STRING;
