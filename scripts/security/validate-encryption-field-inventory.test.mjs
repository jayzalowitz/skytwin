import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applySchemaSql,
  auditDynamicSqlFile,
  auditSeedUpsertHelper,
  discoverSqlCallsiteAudit,
  extractSchemaColumns,
  isRepositoryRegularFile,
  migrationRunnerContractErrors,
  validateInventory,
} from "./validate-encryption-field-inventory.mjs";

const inventoryPath = new URL(
  "../../docs/security/encryption-field-inventory.json",
  import.meta.url,
);
const migrationRunnerPath = new URL(
  "../../packages/db/src/migrations/001-initial.ts",
  import.meta.url,
);
const seedPath = new URL(
  "../../packages/db/src/seeds/seed.ts",
  import.meta.url,
);
const seedUpsertPath = new URL(
  "../../packages/db/src/seeds/upsert.ts",
  import.meta.url,
);

function moveFieldToClassification(inventory, table, column, classification) {
  const entry = inventory.tables.find((candidate) => candidate.table === table);
  const source = entry.groups.find((group) => group.columns.includes(column));
  const target = entry.groups.find(
    (group) => group.classification === classification,
  );
  source.columns = source.columns.filter((candidate) => candidate !== column);
  target.columns.push(column);
}

test("the inventory exactly covers the migration-derived schema", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  assert.deepEqual(validateInventory(inventory, extractSchemaColumns()), []);
});

test("schema drift fails when a new column is not classified", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const schema = extractSchemaColumns();
  schema.get("users").push("new_sensitive_field");

  assert.ok(
    validateInventory(inventory, schema).includes(
      "users.new_sensitive_field: not classified",
    ),
  );
});

test("duplicate field classification fails", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const users = inventory.tables.find((entry) => entry.table === "users");
  const sourceGroup = users.groups.find((group) =>
    ["encrypted_source", "deferred_source"].includes(group.classification),
  );
  const metadataGroup = users.groups.find(
    (group) => group.classification === "locally_exposed_metadata",
  );
  sourceGroup.columns.push(metadataGroup.columns[0]);

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).some(
      (error) =>
        error.startsWith("users.") &&
        error.endsWith(": classified more than once"),
    ),
  );
});

test("search derivative references must resolve to disclosed derivative fields", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const brainPages = inventory.tables.find(
    (entry) => entry.table === "brain_pages",
  );
  const sourceGroup = brainPages.groups.find((group) =>
    ["encrypted_source", "deferred_source"].includes(group.classification),
  );
  sourceGroup.searchableDerivatives.push("brain_pages.created_at");

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "brain_pages.encrypted_source: searchable derivative brain_pages.created_at must identify a classified locally_exposed_derivative field",
    ),
  );
});

test("schema reconstruction applies column and table DDL in statement order", () => {
  const schema = new Map();
  applySchemaSql(
    schema,
    `
      CREATE TABLE old_name (first STRING, removed STRING);
      ALTER TABLE old_name RENAME COLUMN first TO renamed;
      ALTER TABLE old_name DROP COLUMN removed;
      ALTER TABLE old_name ADD COLUMN added INT;
      ALTER TABLE old_name RENAME TO new_name;
      ALTER TABLE new_name ADD COLUMN final BOOL;
    `,
  );

  assert.equal(schema.has("old_name"), false);
  assert.deepEqual([...schema.get("new_name")].sort(), [
    "added",
    "final",
    "renamed",
  ]);
});

test("schema reconstruction is bound to the production migration runner order", () => {
  const runner = readFileSync(migrationRunnerPath, "utf8");
  assert.deepEqual(migrationRunnerContractErrors(runner), []);

  const unsorted = runner.replace(".sort();", ".reverse();");
  assert.ok(
    migrationRunnerContractErrors(unsorted).includes(
      "production migration runner must select every sibling .sql file in lexical order",
    ),
  );

  const migrationsBeforeSchema = runner
    .replace("await client.query(schema);", "void schema;")
    .replace(
      "for (const file of sqlFiles) {",
      "await client.query(schema);\n\n  for (const file of sqlFiles) {",
    );
  assert.ok(
    migrationRunnerContractErrors(migrationsBeforeSchema).some((error) =>
      error.includes("execute schema.sql before incremental migrations"),
    ),
  );

  const conditionalSchema = runner.replace(
    "await client.query(schema);",
    "if (false) await client.query(schema);",
  );
  assert.ok(
    migrationRunnerContractErrors(conditionalSchema).some((error) =>
      error.includes("execute schema.sql before incremental migrations"),
    ),
  );

  const missingRead = runner.replace(
    "const sql = readFileSync(join(__dirname, file), 'utf-8');",
    "const sql = '';",
  );
  assert.ok(
    migrationRunnerContractErrors(missingRead).includes(
      "production migration runner must read each selected SQL file",
    ),
  );

  const missingExecution = runner.replace(
    "await client.query(stmt);",
    "void stmt;",
  );
  assert.ok(
    migrationRunnerContractErrors(missingExecution).includes(
      "production migration runner must execute every statement from every selected SQL file",
    ),
  );

  const skippedFile = runner.replace(
    "for (const file of sqlFiles) {",
    "for (const file of sqlFiles) {\n    if (file === '071-worker-generation-authority.sql') continue;",
  );
  assert.ok(
    migrationRunnerContractErrors(skippedFile).includes(
      "production migration runner must execute every statement from every selected SQL file",
    ),
  );

  const truncatedSelection = runner.replace(
    "for (const file of sqlFiles) {",
    "sqlFiles.pop();\n\n  for (const file of sqlFiles) {",
  );
  assert.ok(
    migrationRunnerContractErrors(truncatedSelection).includes(
      "production migration runner must not modify the selected SQL files before iteration",
    ),
  );

  const bypassedOwnedEntrypoint = runner.replace(
    "await applyMigrations(target, options.authorize);",
    "void target;",
  );
  assert.ok(
    migrationRunnerContractErrors(bypassedOwnedEntrypoint).includes(
      "production migration runner must route CLI and owned entry points through the ordered migration flow",
    ),
  );

  const conditionalOwnedEntrypoint = runner.replace(
    "await applyMigrations(target, options.authorize);",
    "if (false) await applyMigrations(target, options.authorize);",
  );
  assert.ok(
    migrationRunnerContractErrors(conditionalOwnedEntrypoint).includes(
      "production migration runner must route CLI and owned entry points through the ordered migration flow",
    ),
  );

  const disabledDevelopmentEntrypoint = runner.replace(
    "await applyMigrations(pool, () => true);",
    "await applyMigrations(pool, () => false);",
  );
  assert.ok(
    migrationRunnerContractErrors(disabledDevelopmentEntrypoint).includes(
      "production migration runner must route CLI and owned entry points through the ordered migration flow",
    ),
  );
});

test("repository evidence paths reject directories, traversal, and symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "encryption-inventory-root-"));
  const outside = mkdtempSync(join(tmpdir(), "encryption-inventory-outside-"));
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  });
  writeFileSync(join(root, "adr.md"), "decision");
  writeFileSync(join(outside, "outside.md"), "outside");
  mkdirSync(join(root, "directory"));
  symlinkSync(join(root, "adr.md"), join(root, "linked.md"));

  assert.equal(isRepositoryRegularFile(root, "adr.md"), true);
  assert.equal(isRepositoryRegularFile(root, "directory"), false);
  assert.equal(
    isRepositoryRegularFile(
      root,
      join("..", outside.split("/").at(-1), "outside.md"),
    ),
    false,
  );
  assert.equal(
    isRepositoryRegularFile(root, join(outside, "outside.md")),
    false,
  );
  assert.equal(isRepositoryRegularFile(root, "linked.md"), false);
});

test("SQL callsites exclude prose matches and include annotated dynamic writers", () => {
  const audit = discoverSqlCallsiteAudit(extractSchemaColumns());
  assert.deepEqual(audit.errors, []);
  assert.ok(
    audit.callsites
      .get("twin_profiles")
      .includes("packages/db/src/seeds/upsert.ts"),
  );
  assert.ok(
    audit.callsites
      .get("twin_profiles")
      .includes("packages/db/src/seeds/demo-fixture.ts"),
  );
  assert.equal(
    audit.callsites.get("twin_profiles").includes("apps/api/src/cost-gate.ts"),
    false,
  );
  assert.equal(
    audit.callsites
      .get("watches")
      .includes("apps/web/public/js/pages/twin-briefing.js"),
    false,
  );
  assert.ok(
    audit.callsites
      .get("episodic_memories")
      .includes("packages/db/src/seeds/seed.ts"),
  );
});

test("dynamic SQL detection covers quoted identifiers and additional table verbs", () => {
  const schema = new Map([["users", ["id"]]]);
  for (const source of [
    'const table = "users"; query(`SELECT * FROM "${table}"`);',
    'const table = "users"; query(`TRUNCATE ${table}`);',
  ]) {
    assert.ok(
      auditDynamicSqlFile("probe.ts", source, schema).errors.some((error) =>
        error.includes("must declare"),
      ),
    );
  }
});

test("seedUpsert helper annotation is bound to its runtime table allowlist", () => {
  const schema = extractSchemaColumns();
  const helper = readFileSync(seedUpsertPath, "utf8");
  assert.deepEqual(
    auditSeedUpsertHelper("packages/db/src/seeds/upsert.ts", helper, schema)
      .errors,
    [],
  );
  const staleRuntimeAllowlist = helper.replace(
    /\[\s*['"]users['"]\s*,\s*['"]twin_profiles['"]\s*\]/,
    '["users"]',
  );
  assert.ok(
    auditSeedUpsertHelper(
      "packages/db/src/seeds/upsert.ts",
      staleRuntimeAllowlist,
      schema,
    ).errors.some((error) => error.includes("runtime table allowlist")),
  );
});

test("dynamic SQL annotations must match their literal table declarations", () => {
  const schema = extractSchemaColumns();
  const seed = readFileSync(seedPath, "utf8");
  assert.deepEqual(
    auditDynamicSqlFile("packages/db/src/seeds/seed.ts", seed, schema).errors,
    [],
  );

  const missingAnnotation = seed.replace(
    /\s*\/\/ @encryption-inventory-dynamic-sql tables=[^\n]+/,
    "",
  );
  assert.ok(
    auditDynamicSqlFile(
      "packages/db/src/seeds/seed.ts",
      missingAnnotation,
      schema,
    ).errors.some((error) => error.includes("must declare")),
  );

  const staleAnnotation = seed.replace(
    "skill_gap_log,episodic_memories",
    "skill_gap_log",
  );
  assert.ok(
    auditDynamicSqlFile(
      "packages/db/src/seeds/seed.ts",
      staleAnnotation,
      schema,
    ).errors.some((error) => error.includes("literal loop table set")),
  );
});

test("critical OAuth token classifications cannot be weakened", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const oauth = inventory.tables.find(
    (entry) => entry.table === "oauth_tokens",
  );
  const source = oauth.groups.find((group) =>
    group.columns.includes("access_token"),
  );
  source.classification = "locally_exposed_metadata";

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "oauth_tokens.access_token: critical invariant requires encrypted_source",
    ),
  );
});

test("worker generation authority remains installation-scoped and one-way", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const authority = inventory.tables.find(
    (entry) => entry.table === "worker_generation_authority",
  );
  authority.owner = "system_global";
  moveFieldToClassification(
    inventory,
    "worker_generation_authority",
    "secret_hash",
    "locally_exposed_metadata",
  );

  const errors = validateInventory(inventory, extractSchemaColumns());
  assert.ok(
    errors.includes(
      "worker_generation_authority.secret_hash: critical invariant requires one_way_secret",
    ),
  );
  assert.ok(
    errors.includes(
      "worker_generation_authority: critical invariant requires owner=installation target=locally_exposed_or_excluded",
    ),
  );
});

test("global dead-letter context cannot be retained as readable metadata", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  moveFieldToClassification(
    inventory,
    "worker_dead_letter",
    "context",
    "locally_exposed_metadata",
  );

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "worker_dead_letter.context: critical invariant requires forbidden_global_source",
    ),
  );
});

test("global dead-letter error messages cannot be retained as readable metadata", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  moveFieldToClassification(
    inventory,
    "worker_dead_letter",
    "error_message",
    "locally_exposed_metadata",
  );

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "worker_dead_letter.error_message: critical invariant requires forbidden_global_source",
    ),
  );
});

test("operational metadata resolutions cannot silently disappear", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const brainPages = inventory.tables.find(
    (entry) => entry.table === "brain_pages",
  );
  const metadataGroup = brainPages.groups.find((group) =>
    group.columns.includes("metadata"),
  );
  metadataGroup.operationalDependencies =
    metadataGroup.operationalDependencies.filter(
      (dependency) => dependency.jsonPath !== "metadata.fromAddress",
    );
  const lifebooks = inventory.tables.find(
    (entry) => entry.table === "lifebooks",
  );
  const lifebookMetadata = lifebooks.groups.find((group) =>
    group.columns.includes("metadata"),
  );
  lifebookMetadata.operationalDependencies = [];

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "brain_pages.metadata: critical operational dependency metadata.fromAddress must retain its reviewed target resolution",
    ),
  );
  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "lifebooks.metadata: critical operational dependency metadata.importanceOverride.{value,setAt,decayDays} must retain its reviewed target resolution",
    ),
  );
});

test("owner values are strict and security-baselined", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const oauth = inventory.tables.find(
    (entry) => entry.table === "oauth_tokens",
  );
  oauth.owner = "totally_global_and_public";

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "oauth_tokens: unknown owner kind totally_global_and_public",
    ),
  );
});

test("the non-implementation warning must match exactly", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  inventory.warning =
    "Not evidence; target is implemented and all data encrypted.";

  assert.ok(
    validateInventory(inventory, extractSchemaColumns()).includes(
      "warning must match the exact non-implementation disclaimer",
    ),
  );
});
