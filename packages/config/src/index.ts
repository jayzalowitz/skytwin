export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type NodeEnv = 'development' | 'production' | 'test';

export interface SkyTwinConfig {
  /** Database connection string (postgresql:// or sqlite:// or .sqlite file path) */
  databaseUrl: string;

  /** IronClaw API base URL (e.g., http://localhost:4000) */
  ironclawApiUrl: string;

  /** HMAC-SHA256 secret for authenticating with IronClaw's webhook endpoint */
  ironclawWebhookSecret: string;

  /** Owner ID for IronClaw's multi-tenant model */
  ironclawOwnerId: string;

  /** OpenClaw API base URL */
  openclawApiUrl: string;

  /** OpenClaw API key for authentication */
  openclawApiKey: string;

  /** Port for the API server */
  apiPort: number;

  /** Current environment */
  nodeEnv: NodeEnv;

  /** Minimum log level */
  logLevel: LogLevel;

  /** Port for the worker health endpoint */
  workerPort: number;

  /** Base URL for the API (used by worker to forward signals) */
  apiBaseUrl: string;

  /** Worker polling interval in milliseconds */
  workerPollIntervalMs: number;

  /** Use mock adapters instead of real IronClaw/OpenClaw (only for automated tests) */
  useMockIronclaw: boolean;

  /** Desktop mode: bundles API+worker into a single process, auto-starts services */
  desktopMode: boolean;

  /** Default spend limit per action in cents */
  defaultSpendLimitPerAction: number;

  /** Default daily spend limit in cents */
  defaultDailySpendLimit: number;

  /** Approval request expiry in seconds */
  approvalExpirySeconds: number;

  /** Google OAuth client ID */
  googleClientId: string;

  /** Google OAuth client secret */
  googleClientSecret: string;

  /** Google OAuth redirect URI */
  googleRedirectUri: string;

  /** Directory to scan for adapter plugins (empty = no discovery) */
  adapterPluginDir: string;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;
const NODE_ENVS: readonly NodeEnv[] = ['development', 'production', 'test'] as const;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENVS as readonly string[]).includes(value);
}

/**
 * Load configuration from environment variables with defaults.
 *
 * Does not throw on missing optional values -- use `validate()` to check
 * that the config is complete enough for production.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): SkyTwinConfig {
  const rawLogLevel = env['LOG_LEVEL'] ?? 'info';
  const rawNodeEnv = env['NODE_ENV'] ?? 'development';
  const rawPort = env['API_PORT'] ?? '3100';

  return {
    databaseUrl: env['DATABASE_URL'] ?? 'postgresql://root@localhost:26257/skytwin?sslmode=disable',
    ironclawApiUrl: env['IRONCLAW_API_URL'] ?? 'http://localhost:4000',
    ironclawWebhookSecret: env['IRONCLAW_WEBHOOK_SECRET'] ?? '',
    ironclawOwnerId: env['IRONCLAW_OWNER_ID'] ?? 'skytwin-default',
    apiPort: parseInt(rawPort, 10),
    nodeEnv: isNodeEnv(rawNodeEnv) ? rawNodeEnv : 'development',
    logLevel: isLogLevel(rawLogLevel) ? rawLogLevel : 'info',
    workerPort: parseInt(env['WORKER_PORT'] ?? '3101', 10),
    apiBaseUrl: env['API_BASE_URL'] ?? 'http://localhost:3100',
    workerPollIntervalMs: parseInt(env['WORKER_POLL_INTERVAL_MS'] ?? '10000', 10),
    openclawApiUrl: env['OPENCLAW_API_URL'] ?? '',
    openclawApiKey: env['OPENCLAW_API_KEY'] ?? '',
    useMockIronclaw: (env['USE_MOCK_IRONCLAW'] ?? 'false') === 'true',
    desktopMode: (env['DESKTOP_MODE'] ?? 'false') === 'true',
    defaultSpendLimitPerAction: parseInt(env['DEFAULT_SPEND_LIMIT_PER_ACTION'] ?? '5000', 10),
    defaultDailySpendLimit: parseInt(env['DEFAULT_DAILY_SPEND_LIMIT'] ?? '50000', 10),
    approvalExpirySeconds: parseInt(env['APPROVAL_EXPIRY_SECONDS'] ?? '3600', 10),
    googleClientId: env['GOOGLE_CLIENT_ID'] ?? '',
    googleClientSecret: env['GOOGLE_CLIENT_SECRET'] ?? '',
    googleRedirectUri: env['GOOGLE_REDIRECT_URI'] ?? 'http://localhost:3100/api/oauth/google/callback',
    adapterPluginDir: env['ADAPTER_PLUGIN_DIR'] ?? '',
  };
}

export interface ConfigValidationError {
  field: string;
  message: string;
}

/**
 * Validate that a config object is well-formed and complete.
 *
 * Returns an array of validation errors. An empty array means the config is valid.
 */
export function validate(cfg: SkyTwinConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (!cfg.databaseUrl) {
    errors.push({ field: 'databaseUrl', message: 'DATABASE_URL is required' });
  } else if (!cfg.databaseUrl.startsWith('postgresql://') && !cfg.databaseUrl.startsWith('postgres://')) {
    errors.push({ field: 'databaseUrl', message: 'DATABASE_URL must be a valid PostgreSQL connection string' });
  }

  if (!cfg.ironclawApiUrl) {
    errors.push({ field: 'ironclawApiUrl', message: 'IRONCLAW_API_URL is required' });
  } else {
    try {
      new URL(cfg.ironclawApiUrl);
    } catch {
      errors.push({ field: 'ironclawApiUrl', message: 'IRONCLAW_API_URL must be a valid URL' });
    }
  }

  if (!cfg.useMockIronclaw && !cfg.ironclawWebhookSecret) {
    errors.push({
      field: 'ironclawWebhookSecret',
      message: 'IRONCLAW_WEBHOOK_SECRET is required when USE_MOCK_IRONCLAW is false',
    });
  }

  if (isNaN(cfg.apiPort) || cfg.apiPort < 1 || cfg.apiPort > 65535) {
    errors.push({ field: 'apiPort', message: 'API_PORT must be a valid port number (1-65535)' });
  }

  if (!isNodeEnv(cfg.nodeEnv)) {
    errors.push({ field: 'nodeEnv', message: `NODE_ENV must be one of: ${NODE_ENVS.join(', ')}` });
  }

  if (!isLogLevel(cfg.logLevel)) {
    errors.push({ field: 'logLevel', message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` });
  }

  return errors;
}

/**
 * Load and validate config. Throws if validation fails.
 */
export function loadValidatedConfig(env?: Record<string, string | undefined>): SkyTwinConfig {
  const cfg = loadConfig(env);
  const errors = validate(cfg);

  if (errors.length > 0) {
    const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${messages}`);
  }

  return cfg;
}

/**
 * Singleton config instance for convenience.
 */
export const config: SkyTwinConfig = loadConfig();
