import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const cockroachAvailable = spawnSync('cockroach', ['version'], { encoding: 'utf8' }).status === 0;

describe.runIf(cockroachAvailable)('reasoning mode migration on CockroachDB', () => {
  it('classifies legacy provider matrices deterministically and is idempotent', () => {
    const migration = readFileSync(
      new URL('../migrations/072-reasoning-mode-settings.sql', import.meta.url),
      'utf8',
    );
    const setup = `
      CREATE TABLE users (id UUID PRIMARY KEY, display_name STRING NOT NULL);
      CREATE TABLE ai_provider_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        provider STRING NOT NULL,
        api_key STRING NOT NULL DEFAULT '',
        model STRING NOT NULL,
        base_url STRING,
        priority INT NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT true
      );
      INSERT INTO users (id, display_name) VALUES
        ('00000000-0000-0000-0000-000000000001', 'hosted'),
        ('00000000-0000-0000-0000-000000000002', 'embedded'),
        ('00000000-0000-0000-0000-000000000003', 'loopback'),
        ('00000000-0000-0000-0000-000000000004', 'mixed'),
        ('00000000-0000-0000-0000-000000000005', 'custom'),
        ('00000000-0000-0000-0000-000000000006', 'disabled'),
        ('00000000-0000-0000-0000-000000000007', 'none'),
        ('00000000-0000-0000-0000-000000000008', 'invalid-port'),
        ('00000000-0000-0000-0000-000000000009', 'alternate-port'),
        ('00000000-0000-0000-0000-000000000010', 'trailing-dot'),
        ('00000000-0000-0000-0000-000000000011', 'ipv4-root-dot'),
        ('00000000-0000-0000-0000-000000000012', 'short-ipv4');
      INSERT INTO ai_provider_settings (user_id, provider, model, base_url, enabled) VALUES
        ('00000000-0000-0000-0000-000000000001', 'openai', 'gpt', NULL, true),
        ('00000000-0000-0000-0000-000000000002', 'embedded', 'managed', NULL, true),
        ('00000000-0000-0000-0000-000000000003', 'ollama', 'qwen', 'http://localhost:11434', true),
        ('00000000-0000-0000-0000-000000000004', 'embedded', 'managed', NULL, true),
        ('00000000-0000-0000-0000-000000000004', 'openai', 'gpt', NULL, true),
        ('00000000-0000-0000-0000-000000000005', 'ollama', 'qwen', 'https://ollama.example', true),
        ('00000000-0000-0000-0000-000000000006', 'openai', 'gpt', NULL, false),
        ('00000000-0000-0000-0000-000000000008', 'ollama', 'qwen', 'http://localhost:99999', true),
        ('00000000-0000-0000-0000-000000000009', 'ollama', 'qwen', 'http://localhost:12345', true),
        ('00000000-0000-0000-0000-000000000010', 'ollama', 'qwen', 'http://localhost.:11434', true),
        ('00000000-0000-0000-0000-000000000011', 'ollama', 'qwen', 'http://127.0.0.1.:11434', true),
        ('00000000-0000-0000-0000-000000000012', 'ollama', 'qwen', 'http://127.1:11434', true);
    `;
    const verify = `
      SELECT u.display_name, r.mode, r.requires_confirmation
      FROM users u
      JOIN reasoning_mode_settings r ON r.user_id = u.id
      ORDER BY u.display_name;
    `;
    const result = spawnSync(
      'cockroach',
      ['demo', '--empty', '--insecure', '--format=csv', '--execute', `${setup}\n${migration}\n${migration}\n${verify}`],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('alternate-port,on_device,f');
    expect(result.stdout).toContain('custom,NULL,t');
    expect(result.stdout).toContain('disabled,on_device,f');
    expect(result.stdout).toContain('embedded,on_device,f');
    expect(result.stdout).toContain('hosted,bring_your_own_provider,f');
    expect(result.stdout).toContain('invalid-port,NULL,t');
    expect(result.stdout).toContain('ipv4-root-dot,on_device,f');
    expect(result.stdout).toContain('loopback,on_device,f');
    expect(result.stdout).toContain('mixed,NULL,t');
    expect(result.stdout).toContain('none,on_device,f');
    expect(result.stdout).toContain('short-ipv4,NULL,t');
    expect(result.stdout).toContain('trailing-dot,on_device,f');
  }, 30_000);
});
