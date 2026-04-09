-- AI provider settings: stores per-user LLM provider configuration
-- for the inference pipeline. Users can configure multiple providers
-- in a priority-ordered fallback chain (e.g., Anthropic primary,
-- Ollama local fallback).

CREATE TABLE IF NOT EXISTS ai_provider_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider STRING NOT NULL,
  api_key STRING NOT NULL DEFAULT '',
  model STRING NOT NULL,
  base_url STRING,
  priority INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider)
);

CREATE INDEX idx_ai_provider_settings_user ON ai_provider_settings (user_id, priority);
