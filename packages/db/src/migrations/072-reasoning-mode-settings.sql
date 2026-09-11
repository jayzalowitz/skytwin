-- Persist the user's reasoning-location choice independently from provider
-- labels and endpoint URLs. NULL means legacy state needs an explicit choice.
CREATE TABLE IF NOT EXISTS reasoning_mode_settings (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode STRING,
  requires_confirmation BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reasoning_mode_settings_mode_check CHECK (
    mode IS NULL OR mode IN (
      'on_device',
      'verified_private_cloud',
      'bring_your_own_provider'
    )
  ),
  CONSTRAINT reasoning_mode_settings_confirmation_check CHECK (
    (mode IS NULL AND requires_confirmation = true)
    OR (mode IS NOT NULL AND requires_confirmation = false)
  )
);

-- Deterministic legacy migration:
--   * no enabled providers, or only provably local adapters -> on_device
--   * only conventional hosted adapters -> bring_your_own_provider
--   * mixed chains or custom Ollama URLs -> explicit confirmation required
INSERT INTO reasoning_mode_settings (user_id, mode, requires_confirmation)
SELECT
  u.id,
  CASE
    WHEN count(a.id) FILTER (WHERE a.enabled) = 0 THEN 'on_device'
    WHEN count(a.id) FILTER (WHERE a.enabled) = count(a.id) FILTER (
      WHERE a.enabled AND (
        a.provider = 'embedded'
        OR (
          a.provider = 'ollama'
          AND (
            a.base_url IS NULL
            OR a.base_url ~* '^https?://(localhost|127\.0\.0\.1|\[::1\])(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?([/?#].*)?$'
          )
        )
      )
    ) THEN 'on_device'
    WHEN count(a.id) FILTER (WHERE a.enabled) = count(a.id) FILTER (
      WHERE a.enabled AND a.provider IN ('anthropic', 'openai', 'google')
    ) THEN 'bring_your_own_provider'
    ELSE NULL
  END,
  CASE
    WHEN count(a.id) FILTER (WHERE a.enabled) = 0 THEN false
    WHEN count(a.id) FILTER (WHERE a.enabled) = count(a.id) FILTER (
      WHERE a.enabled AND (
        a.provider = 'embedded'
        OR (
          a.provider = 'ollama'
          AND (
            a.base_url IS NULL
            OR a.base_url ~* '^https?://(localhost|127\.0\.0\.1|\[::1\])(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?([/?#].*)?$'
          )
        )
      )
    ) THEN false
    WHEN count(a.id) FILTER (WHERE a.enabled) = count(a.id) FILTER (
      WHERE a.enabled AND a.provider IN ('anthropic', 'openai', 'google')
    ) THEN false
    ELSE true
  END
FROM users u
LEFT JOIN ai_provider_settings a ON a.user_id = u.id
GROUP BY u.id
ON CONFLICT (user_id) DO NOTHING;
