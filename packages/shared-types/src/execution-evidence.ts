const REDACTED_SECRET = '[redacted:credential]';
const REDACTED_FIELD = '[redacted:unapproved-field]';
const REDACTED_CYCLE = '[redacted:cycle]';
const REDACTED_ERROR = '[redacted:execution-error]';

const SECRET_KEY_PARTS = [
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'authorization',
  'apikey',
  'clientsecret',
  'credential',
  'password',
  'cookie',
  'secret',
  'token',
];

const URL_KEYS = new Set(['url', 'uri', 'endpoint', 'location', 'requesturl', 'responseurl']);

// This is deliberately an allowlist. Adapter response fields not needed to
// reconcile execution are represented, but their values are not persisted.
const CONTAINER_KEYS = new Set([
  'output', 'outputs', 'payload', 'result', 'steps', 'headers', 'metadata',
]);
const VALUE_KEYS = new Set([
  'actionid', 'actiontype', 'adaptername', 'adapterplanid', 'adapterused',
  'approvalrequestid', 'code', 'completedat', 'count', 'decisionid', 'error',
  'errorcode', 'eventtype', 'executionplanid', 'fallbacksattempted', 'id',
  'messageid', 'opportunityid', 'planid', 'rollbackavailable',
  'routingdecision', 'startedat', 'status', 'stepid', 'success', 'timestamp',
  'type',
]);

export interface NormalizeExecutionEvidenceOptions {
  /** Known credentials for exact-string removal from otherwise safe text. */
  secretValues?: ReadonlyArray<string | null | undefined>;
  /** Locally-authored fields that a specific typed ledger is allowed to keep. */
  trustedTextKeys?: ReadonlyArray<string>;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactUrlQueries(value: string): string {
  // Paths as well as queries can contain opaque credentials or private
  // resource identifiers. Execution reconciliation never needs the remote
  // URL, so retain only the fact that one was present.
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted:url]');
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED_SECRET);
  }
  redacted = redacted
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED_SECRET}`)
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password)=[^\s&]+/gi,
      `$1=${REDACTED_SECRET}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED_SECRET)
    .replace(/\bya29\.[A-Za-z0-9._-]+\b/g, REDACTED_SECRET)
    .replace(/\b1\/\/[A-Za-z0-9._-]+\b/g, REDACTED_SECRET);
  return redactUrlQueries(redacted).slice(0, 2_000);
}

/**
 * Convert untrusted execution evidence to the small, credential-free shape
 * needed for reconciliation. Unknown response fields retain only their key so
 * operators can see that data existed without persisting an arbitrary body.
 */
export function normalizeExecutionEvidence(
  value: unknown,
  options: NormalizeExecutionEvidenceOptions = {},
): unknown {
  const secrets = (options.secretValues ?? [])
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  const trustedTextKeys = new Set((options.trustedTextKeys ?? []).map(normalizedKey));
  const seen = new WeakSet<object>();

  const visit = (current: unknown, key = ''): unknown => {
    const normalized = normalizedKey(key);
    if (key && isSecretKey(key)) return REDACTED_SECRET;
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (typeof current === 'string') {
      if (normalized === 'error') return current ? REDACTED_ERROR : '';
      if (URL_KEYS.has(normalized)) return redactUrlQueries(redactText(current, secrets));
      return redactText(current, secrets);
    }
    if (current instanceof Date) return current.toISOString();
    if (Array.isArray(current)) return current.slice(0, 100).map((item) => visit(item, key));
    if (!current || typeof current !== 'object') return null;
    if (seen.has(current)) return REDACTED_CYCLE;
    seen.add(current);
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(current as Record<string, unknown>).slice(0, 100)) {
      const childNormalized = normalizedKey(childKey);
      if (isSecretKey(childKey)) {
        result[childKey] = REDACTED_SECRET;
      } else if (CONTAINER_KEYS.has(childNormalized) || VALUE_KEYS.has(childNormalized) ||
          trustedTextKeys.has(childNormalized) ||
          URL_KEYS.has(childNormalized)) {
        result[childKey] = visit(child, childKey);
      } else {
        result[childKey] = REDACTED_FIELD;
      }
    }
    seen.delete(current);
    return result;
  };

  return visit(value);
}

export function normalizeExecutionRecord(
  value: Record<string, unknown>,
  options: NormalizeExecutionEvidenceOptions = {},
): Record<string, unknown> {
  return normalizeExecutionEvidence(value, options) as Record<string, unknown>;
}

export function normalizeExecutionError(
  value: unknown,
  options: NormalizeExecutionEvidenceOptions = {},
): string {
  const message = value instanceof Error ? value.message : String(value);
  if (!message) return '';
  // Error strings are arbitrary remote bodies. A credential can be echoed
  // without a recognizable key or format, so no substring is safe to retain.
  void options;
  return REDACTED_ERROR;
}
