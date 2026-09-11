-- A synthetic identity is not readable until its complete fixture has passed
-- through the normal ingest boundary. The default keeps partial bootstraps
-- unavailable after a crash or failed ingest.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS demo_ready BOOLEAN NOT NULL DEFAULT false;
