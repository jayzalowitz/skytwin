-- 064-users-is-demo.sql
-- Identity-isolation marker for the launch demo fixture (spec 09, #482).
--
-- The demo fixture (opt-in, local-only) writes synthetic data ONLY under users
-- flagged is_demo = true; its guard refuses to touch any is_demo = false (real)
-- user, and --reset deletes only is_demo = true rows. Real users default false,
-- so a brand-new user ("grandma") can never be mistaken for a demo user even if
-- the fixture is mis-invoked. Additive + nullable-safe (DEFAULT false).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
