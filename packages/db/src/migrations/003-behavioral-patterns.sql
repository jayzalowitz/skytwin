-- Behavioral patterns and cross-domain traits for richer twin modeling

CREATE TABLE IF NOT EXISTS behavioral_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  pattern_type STRING NOT NULL,
  description STRING NOT NULL,
  trigger_config JSONB NOT NULL,
  observed_action STRING NOT NULL,
  frequency INT NOT NULL DEFAULT 1,
  confidence STRING NOT NULL DEFAULT 'speculative',
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}',
  INDEX (user_id, pattern_type),
  INDEX (user_id, confidence)
);

CREATE TABLE IF NOT EXISTS cross_domain_traits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  trait_name STRING NOT NULL,
  confidence STRING NOT NULL DEFAULT 'speculative',
  supporting_domains STRING[] NOT NULL DEFAULT '{}',
  evidence_count INT NOT NULL DEFAULT 0,
  description STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, trait_name)
);

ALTER TABLE twin_profiles ADD COLUMN IF NOT EXISTS temporal_profile JSONB NOT NULL DEFAULT '{}';
