import { describe, it, expect } from 'vitest';
import { loadConfig, validate, loadValidatedConfig } from '../index.js';

describe('loadConfig', () => {
  it('applies defaults for an empty environment', () => {
    const cfg = loadConfig({});
    expect(cfg.databaseUrl).toContain('postgresql://');
    expect(cfg.ironclawApiUrl).toBe('http://localhost:4000');
    expect(cfg.apiPort).toBe(3100);
    expect(cfg.workerPort).toBe(3101);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.useMockIronclaw).toBe(false);
    expect(cfg.desktopMode).toBe(false);
    expect(cfg.ironclawPreferChat).toBe(false);
  });

  it('reads values from the provided environment', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgresql://override',
      IRONCLAW_API_URL: 'http://ironclaw.test',
      IRONCLAW_WEBHOOK_SECRET: 's3cret',
      API_PORT: '4242',
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
    });
    expect(cfg.databaseUrl).toBe('postgresql://override');
    expect(cfg.ironclawApiUrl).toBe('http://ironclaw.test');
    expect(cfg.ironclawWebhookSecret).toBe('s3cret');
    expect(cfg.apiPort).toBe(4242);
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.nodeEnv).toBe('production');
  });

  it('falls back to default for invalid LOG_LEVEL', () => {
    const cfg = loadConfig({ LOG_LEVEL: 'verbose' });
    expect(cfg.logLevel).toBe('info');
  });

  it('falls back to default for invalid NODE_ENV', () => {
    const cfg = loadConfig({ NODE_ENV: 'staging' });
    expect(cfg.nodeEnv).toBe('development');
  });

  it('parses boolean env vars only when value is "true"', () => {
    expect(loadConfig({ USE_MOCK_IRONCLAW: 'true' }).useMockIronclaw).toBe(true);
    expect(loadConfig({ USE_MOCK_IRONCLAW: 'TRUE' }).useMockIronclaw).toBe(false);
    expect(loadConfig({ USE_MOCK_IRONCLAW: '1' }).useMockIronclaw).toBe(false);
    expect(loadConfig({ USE_MOCK_IRONCLAW: '' }).useMockIronclaw).toBe(false);
  });

  it('honors GATEWAY_AUTH_TOKEN as a fallback for IRONCLAW_GATEWAY_TOKEN', () => {
    expect(loadConfig({ GATEWAY_AUTH_TOKEN: 'legacy' }).ironclawGatewayToken).toBe('legacy');
    expect(loadConfig({
      GATEWAY_AUTH_TOKEN: 'legacy',
      IRONCLAW_GATEWAY_TOKEN: 'preferred',
    }).ironclawGatewayToken).toBe('preferred');
  });

  it('honors IRONCLAW_CHANNEL as a fallback for IRONCLAW_DEFAULT_CHANNEL', () => {
    expect(loadConfig({ IRONCLAW_CHANNEL: 'legacy' }).ironclawDefaultChannel).toBe('legacy');
    expect(loadConfig({
      IRONCLAW_CHANNEL: 'legacy',
      IRONCLAW_DEFAULT_CHANNEL: 'preferred',
    }).ironclawDefaultChannel).toBe('preferred');
  });
});

describe('validate', () => {
  function validCfg() {
    return loadConfig({
      DATABASE_URL: 'postgresql://localhost/skytwin',
      IRONCLAW_API_URL: 'http://localhost:4000',
      IRONCLAW_WEBHOOK_SECRET: 'secret',
    });
  }

  it('returns no errors for a valid config', () => {
    expect(validate(validCfg())).toEqual([]);
  });

  it('rejects empty databaseUrl', () => {
    const cfg = validCfg();
    cfg.databaseUrl = '';
    const errs = validate(cfg);
    expect(errs.find((e) => e.field === 'databaseUrl')).toBeDefined();
  });

  it('rejects non-postgresql databaseUrl', () => {
    const cfg = validCfg();
    cfg.databaseUrl = 'mysql://localhost/skytwin';
    const errs = validate(cfg);
    expect(errs.find((e) => e.field === 'databaseUrl')?.message).toContain('valid PostgreSQL');
  });

  it('accepts both postgres:// and postgresql:// schemes', () => {
    const cfg = validCfg();
    cfg.databaseUrl = 'postgres://localhost/skytwin';
    expect(validate(cfg).find((e) => e.field === 'databaseUrl')).toBeUndefined();
  });

  it('rejects malformed ironclawApiUrl', () => {
    const cfg = validCfg();
    cfg.ironclawApiUrl = 'not a url';
    expect(validate(cfg).find((e) => e.field === 'ironclawApiUrl')).toBeDefined();
  });

  it('requires ironclawWebhookSecret unless mock is enabled', () => {
    const cfg = validCfg();
    cfg.ironclawWebhookSecret = '';
    expect(validate(cfg).find((e) => e.field === 'ironclawWebhookSecret')).toBeDefined();

    cfg.useMockIronclaw = true;
    expect(validate(cfg).find((e) => e.field === 'ironclawWebhookSecret')).toBeUndefined();
  });

  it('rejects out-of-range apiPort', () => {
    const cfg = validCfg();
    cfg.apiPort = 0;
    expect(validate(cfg).find((e) => e.field === 'apiPort')).toBeDefined();

    cfg.apiPort = 99999;
    expect(validate(cfg).find((e) => e.field === 'apiPort')).toBeDefined();
  });

  it('rejects NaN apiPort (e.g. from non-numeric env)', () => {
    const cfg = validCfg();
    cfg.apiPort = NaN;
    expect(validate(cfg).find((e) => e.field === 'apiPort')).toBeDefined();
  });
});

describe('loadValidatedConfig', () => {
  it('returns the config when valid', () => {
    const cfg = loadValidatedConfig({
      DATABASE_URL: 'postgresql://localhost/skytwin',
      IRONCLAW_API_URL: 'http://localhost:4000',
      IRONCLAW_WEBHOOK_SECRET: 'secret',
    });
    expect(cfg.apiPort).toBe(3100);
  });

  it('throws an aggregated error when validation fails', () => {
    expect(() =>
      loadValidatedConfig({
        DATABASE_URL: 'mysql://bad',
        IRONCLAW_API_URL: 'not a url',
      }),
    ).toThrow(/Invalid configuration/);
  });

  it('error message lists every failing field', () => {
    let captured: Error | null = null;
    try {
      loadValidatedConfig({
        DATABASE_URL: 'mysql://bad',
        IRONCLAW_API_URL: 'not a url',
      });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured!.message).toContain('databaseUrl');
    expect(captured!.message).toContain('ironclawApiUrl');
    expect(captured!.message).toContain('ironclawWebhookSecret');
  });
});
