import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveOwnedTableManifest,
  getSkyTwinOwnedTableManifest,
  isIdempotentError,
  quoteSqlIdentifier,
  splitSqlStatements,
  upOwned,
  type OwnedMigrationClient,
} from '../migrations/001-initial.js';
import { SKYTWIN_OWNED_TABLES } from './fixtures/skytwin-owned-tables.js';

function fakeMigrationClient(): OwnedMigrationClient & {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe('owned desktop migration connection', () => {
  it('performs no write when child authority is lost after the admin connection opens', async () => {
    const admin = fakeMigrationClient();
    const createClient = vi.fn(() => admin);

    await expect(
      upOwned({
        connectionString: 'postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable',
        authorize: () => false,
        createClient,
      }),
    ).rejects.toThrow(/ownership changed/);

    expect(createClient).toHaveBeenCalledOnce();
    expect(admin.connect).toHaveBeenCalledOnce();
    expect(admin.query).not.toHaveBeenCalled();
    expect(admin.end).toHaveBeenCalledOnce();
  });

  it('does not write through a target connection opened after authority is revoked', async () => {
    const admin = fakeMigrationClient();
    const target = fakeMigrationClient();
    const createClient = vi.fn()
      .mockReturnValueOnce(admin)
      .mockReturnValueOnce(target);
    const authorize = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await expect(
      upOwned({
        connectionString: 'postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable',
        authorize,
        createClient,
      }),
    ).rejects.toThrow(/ownership changed/);

    expect(createClient.mock.calls[0]?.[0]).toContain('/defaultdb?');
    expect(createClient.mock.calls[1]?.[0]).toContain('/skytwin?');
    expect(admin.query).toHaveBeenCalledExactlyOnceWith('CREATE DATABASE IF NOT EXISTS skytwin');
    expect(target.connect).toHaveBeenCalledOnce();
    expect(target.query).not.toHaveBeenCalled();
    expect(target.end).toHaveBeenCalledOnce();
  });

  it('rechecks authority before every statement on one fixed target client', async () => {
    const admin = fakeMigrationClient();
    const target = fakeMigrationClient();
    const createClient = vi.fn()
      .mockReturnValueOnce(admin)
      .mockReturnValueOnce(target);
    const authorize = vi.fn(() => target.query.mock.calls.length === 0);

    await expect(
      upOwned({
        connectionString: 'postgresql://root@127.0.0.1:26257/skytwin?sslmode=disable',
        authorize,
        createClient,
      }),
    ).rejects.toThrow(/ownership changed/);

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(target.connect).toHaveBeenCalledOnce();
    expect(target.query).toHaveBeenCalledOnce();
    expect(String(target.query.mock.calls[0]?.[0])).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(target.end).toHaveBeenCalledOnce();
  });
});

describe('SkyTwin-owned table manifest', () => {
  it('derives current and historical ownership from executable checked-in DDL', () => {
    expect(deriveOwnedTableManifest([{ name: 'fixture.sql', sql: `
      -- CREATE TABLE foreign_comment (id INT);
      CREATE TABLE IF NOT EXISTS public.alpha (id INT);
      CREATE TABLE "odd""name" (id INT);
      DROP TABLE IF EXISTS alpha;
    ` }])).toEqual({ all: ['alpha', 'odd"name'], current: ['odd"name'] });
  });

  it('fails closed when a CREATE TABLE shape cannot be assigned to public ownership', () => {
    expect(() => deriveOwnedTableManifest([{
      name: 'unsupported.sql',
      sql: 'CREATE TABLE private.operator_data (id INT);',
    }])).toThrow(/Cannot derive every owned table/);
  });

  it('covers the checked-in schema and remembers intentionally retired tables', () => {
    const manifest = getSkyTwinOwnedTableManifest();
    expect(manifest.current).toContain('users');
    expect(manifest.current).toContain('execution_admission_barriers');
    expect(manifest.current).toContain('credential_dispatch_leases');
    expect(manifest.current).not.toContain('capability_recipes');
    expect(manifest.all).toContain('capability_recipes');
    expect(new Set(manifest.current).size).toBe(manifest.current.length);
  });

  it('keeps the reviewed ownership oracle in exact runtime manifest order', () => {
    expect([...SKYTWIN_OWNED_TABLES]).toEqual(getSkyTwinOwnedTableManifest().current);
    expect([...SKYTWIN_OWNED_TABLES]).toEqual([...SKYTWIN_OWNED_TABLES].sort());
  });
});

describe('typed execution evidence migration', () => {
  const migration = readFileSync(fileURLToPath(new URL(
    '../migrations/078-execution-admission-barriers.sql', import.meta.url,
  )), 'utf8');
  const schema = readFileSync(fileURLToPath(new URL('../schemas/schema.sql', import.meta.url)), 'utf8');
  const evidenceTables = [
    'execution_plans',
    'execution_results',
    'execution_events',
    'memory_action_opportunities',
    'execution_admission_barriers',
  ];

  it('stamps fresh schema rows as typed and adds legacy columns as untrusted', () => {
    for (const table of evidenceTables) {
      const definition = schema.match(new RegExp(
        `CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`,
      ))?.[0];
      expect(definition, `missing schema definition for ${table}`).toBeDefined();
      expect(definition).toContain('evidence_schema_version INT NOT NULL DEFAULT 1');
      expect(migration).toContain(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS evidence_schema_version INT NOT NULL DEFAULT 0;`,
      );
      expect(migration).toContain(
        `ALTER TABLE ${table} ALTER COLUMN evidence_schema_version SET DEFAULT 1;`,
      );
    }
  });

  it('scrubs only legacy evidence so rerunning cannot destroy typed rows', () => {
    for (const table of evidenceTables) {
      const update = migration.match(new RegExp(
        `UPDATE ${table}[\\s\\S]*?WHERE evidence_schema_version < 1;`,
      ))?.[0];
      expect(update, `missing guarded scrub for ${table}`).toBeDefined();
      expect(update).toContain('evidence_schema_version = 1');
    }
  });
});

describe('quoteSqlIdentifier', () => {
  it('quotes ordinary and embedded-quote identifiers', () => {
    expect(quoteSqlIdentifier('memory_action_opportunities'))
      .toBe('"memory_action_opportunities"');
    expect(quoteSqlIdentifier('table"; DROP DATABASE skytwin; --'))
      .toBe('"table""; DROP DATABASE skytwin; --"');
  });

  it('rejects identifiers that cannot be represented safely', () => {
    expect(() => quoteSqlIdentifier('')).toThrow(/Refusing to quote/);
    expect(() => quoteSqlIdentifier('table\0name')).toThrow(/Refusing to quote/);
  });
});

describe('splitSqlStatements', () => {
  it('splits statements on end-of-line semicolons', () => {
    const sql = 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n';
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE a (id INT)',
      'CREATE TABLE b (id INT)',
    ]);
  });

  it('does not split on a semicolon inside a -- comment', () => {
    // Regression: migration 039 had `;` at the end of a comment line,
    // which split the CREATE TABLE in half and produced a syntax error.
    const sql = [
      'CREATE TABLE model_downloads (',
      '  id UUID PRIMARY KEY,',
      '  -- total bytes (corrected on first response; see below)',
      '  total_bytes INT8 NOT NULL',
      ');',
    ].join('\n');
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE model_downloads (\n  id UUID PRIMARY KEY,\n  \n  total_bytes INT8 NOT NULL\n)',
    ]);
  });

  it('drops comment-only and empty blocks', () => {
    const sql = '-- a leading comment\n\nCREATE TABLE a (id INT);\n-- trailing\n';
    expect(splitSqlStatements(sql)).toEqual(['CREATE TABLE a (id INT)']);
  });

  it('strips trailing line comments from a statement', () => {
    const sql = 'CREATE INDEX i ON a (id); -- speeds up lookups\n';
    expect(splitSqlStatements(sql)).toEqual(['CREATE INDEX i ON a (id)']);
  });

  it('returns no statements for an all-comment file', () => {
    expect(splitSqlStatements('-- just a header\n-- nothing else\n')).toEqual([]);
  });

  it('passes statements with balanced string literals through unchanged', () => {
    const sql = "INSERT INTO t (name) VALUES ('hello');\n";
    expect(splitSqlStatements(sql)).toEqual(["INSERT INTO t (name) VALUES ('hello')"]);
  });

  it('throws if comment-strip corrupts a string literal (unbalanced quotes)', () => {
    // `--b')` is inside a string literal; the non-string-aware strip
    // eats it, leaving an unbalanced quote — must fail loud, not corrupt.
    const sql = "INSERT INTO t (v) VALUES ('a--b');\n";
    expect(() => splitSqlStatements(sql)).toThrow(/unbalanced single-quotes/);
  });
});

describe('stacked migration reservations', () => {
  it('derives inference evidence tables into the initial rollback manifest', () => {
    const manifest = getSkyTwinOwnedTableManifest();
    expect(manifest.current).toEqual(expect.arrayContaining([
      'inference_receipt_completions',
      'inference_receipts',
      'explanation_records',
    ]));
  });

  it('keeps reserved ordinals unique and places pre-effect barriers after the active stack', () => {
    const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url));
    const names = readdirSync(migrationDir);
    expect(names).toContain('080-assistant-message-idempotency.sql');
    expect(names).toContain('086-pre-effect-barriers.sql');
    expect(names).toContain('087-joined-decision-receipts.sql');
    expect(names).toContain('093-gmail-archive-feedback-projection.sql');
    expect(names).not.toContain('077-assistant-message-idempotency.sql');
    expect(names).not.toContain('080-pre-effect-barriers.sql');

    const sqlMigrations = names.filter((name) => /^\d{3}-.+\.sql$/.test(name));
    const ordinals = sqlMigrations.map((name) => name.slice(0, 3));
    expect(new Set(ordinals).size, `duplicate migration ordinal in: ${sqlMigrations.join(', ')}`)
      .toBe(ordinals.length);
  });

  it('enforces a durable explanation for every non-reserved pre-effect state', () => {
    const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url));
    const sql = readFileSync(`${migrationDir}/086-pre-effect-barriers.sql`, 'utf8');
    expect(sql).toContain('pre_effect_barrier_explanation_required');
    expect(sql).toContain("CHECK (status = 'reserved' OR explanation_id IS NOT NULL)");
  });

  it('preserves the current memory-action status contract', () => {
    const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url));
    const sql = readFileSync(`${migrationDir}/086-pre-effect-barriers.sql`, 'utf8');
    const memoryStatusCheck = sql.split('ADD CONSTRAINT check_status')[1] ?? '';
    expect(memoryStatusCheck).toContain("'execution_ambiguous'");
    expect(memoryStatusCheck).not.toContain("'processing'");
    expect(memoryStatusCheck).not.toContain("'execution_unknown'");
  });
});
describe('isIdempotentError', () => {
  it('matches SQLSTATE codes for DDL already-exists conditions', () => {
    expect(isIdempotentError({ code: '42710' })).toBe(true); // duplicate_object
    expect(isIdempotentError({ code: '42P07' })).toBe(true); // duplicate_table
    expect(isIdempotentError({ code: '42701' })).toBe(true); // duplicate_column
  });

  it('falls back to message substrings for DDL already-exists conditions', () => {
    expect(isIdempotentError(new Error('relation "users" already exists'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate constraint name: "cpn_check"'))).toBe(true);
    expect(isIdempotentError(new Error('duplicate column name "email"'))).toBe(true);
  });

  it('does not treat real failures as idempotent', () => {
    expect(isIdempotentError({ code: '42601' })).toBe(false); // syntax_error
    expect(isIdempotentError(new Error('syntax error at or near "EOF"'))).toBe(false);
    expect(isIdempotentError(new Error('relation "users" does not exist'))).toBe(false);
    expect(isIdempotentError('some string error')).toBe(false);
    expect(isIdempotentError(null)).toBe(false);
  });

  // 23505 / "duplicate key" is NEVER idempotent-safe at the runner level.
  // Earlier versions swallowed 23505 to make re-running a seed INSERT a
  // no-op, but the carve-out also masked real failures: a CREATE UNIQUE
  // INDEX blocked by residual duplicates, an INSERT ... SELECT backfill
  // hitting a real collision, an ALTER TABLE ... ADD CONSTRAINT UNIQUE
  // failing on dirty data — all of those returned 23505 and were silently
  // absorbed. Migration 046 (the approval_requests unique index) was the
  // case that surfaced this. The runner now has one rule: 23505 always
  // surfaces. Seed migrations that need re-run safety use
  // `INSERT ... ON CONFLICT DO NOTHING` to mark the intent explicitly.
  describe('unique violation (23505 / "duplicate key")', () => {
    it('always surfaces 23505 regardless of statement shape', () => {
      // The carve-out is gone — no statement parameter, no INSERT
      // heuristic. Every 23505 reaches the migration runner's catch.
      expect(isIdempotentError({ code: '23505' })).toBe(false);
      expect(
        isIdempotentError(new Error('duplicate key value violates unique constraint "users_pkey"')),
      ).toBe(false);
      expect(isIdempotentError(new Error('duplicate key value'))).toBe(false);
    });

    it('surfaces 23505 even when the message happens to contain "already exists"', () => {
      // Some driver variants append "already exists" to a 23505 message.
      // The code-anchored 23505 guard runs BEFORE the DDL message-
      // substring fallback, so the function returns false on this shape.
      // (Using a real Error rather than a plain object so the message
      // would in principle be reachable — without the guard, this exact
      // shape would have been swallowed by `message.includes('already
      // exists')`. The guard is what makes the test pass.)
      const err = Object.assign(
        new Error('unique index "idx_t_k" already exists with duplicate data'),
        { code: '23505' },
      );
      expect(isIdempotentError(err)).toBe(false);
    });

    it('surfaces 23505 when the driver returns the code as a number', () => {
      // node-postgres always stringifies, but other pg clients (or a
      // hand-built driver) may surface `code` as a JS number. The guard
      // uses `String(code) === '23505'` so the value matches regardless
      // of which JS type carries it. Without this, a numeric-coded 23505
      // with "already exists" in its message would fall through to the
      // DDL substring fallback and be silently swallowed.
      const err = Object.assign(
        new Error('unique index "idx_t_k" already exists with duplicate data'),
        { code: 23505 },
      );
      expect(isIdempotentError(err)).toBe(false);
      expect(isIdempotentError({ code: 23505 })).toBe(false);
    });

    it('surfaces a 23505-shaped error even when the driver elides `code`', () => {
      // Belt-and-suspenders: a driver that drops `code` on a 23505 still
      // carries the canonical "duplicate key value" message. The guard
      // vetoes that substring before the DDL fallback can pick it up,
      // so the function never absorbs a duplicate-key error just because
      // its code field was missing.
      const err = new Error(
        'duplicate key value violates unique constraint "idx_t_k"',
      );
      expect(isIdempotentError(err)).toBe(false);
    });

    it('still surfaces 23505 even when its message *only* says "already exists"', () => {
      // Defends the "code-anchored guard runs before message fallback"
      // ordering: a 23505 whose message says nothing about duplicate
      // keys and only says "already exists" (a hypothetical driver
      // variant) must still surface, because the code is what tells us
      // the operation actually failed on data — not on a name clash.
      const err = Object.assign(
        new Error('relation "idx_t_k" already exists'),
        { code: '23505' },
      );
      expect(isIdempotentError(err)).toBe(false);
    });
  });
});
