#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const SCHEMA_PATH = join(
  REPO_ROOT,
  "packages",
  "db",
  "src",
  "schemas",
  "schema.sql",
);
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "db", "src", "migrations");
const INVENTORY_PATH = join(
  REPO_ROOT,
  "docs",
  "security",
  "encryption-field-inventory.json",
);
const EXPECTED_SOURCES = [
  "packages/db/src/schemas/schema.sql",
  "packages/db/src/migrations/*.sql",
];
const EXPECTED_MIGRATION_RUNNER = "packages/db/src/migrations/001-initial.ts";
const EXPECTED_WARNING =
  "This inventory records current exposure and the proposed target boundary. It is not evidence that target encryption is implemented or accepted.";
const EXPECTED_SEMANTIC_BASELINE_SHA256 =
  "85909721d28b1931167cff9861a12fa5f29875a81fefd34c1c4e037ad9675bf2";

const OWNER_KINDS = new Set([
  "user",
  "user_child",
  "installation",
  "system_global",
]);
const CURRENT_BOUNDARIES = new Set([
  "repository_sql",
  "mixed_repository_and_direct_sql",
  "no_runtime_sql_found",
]);
const TARGET_BOUNDARIES = new Set([
  "user_broker_gateway",
  "installation_broker_gateway",
  "content_free_global",
  "locally_exposed_or_excluded",
  "ownership_required",
]);

const CLASSIFICATIONS = new Set([
  "encrypted_source",
  "locally_exposed_derivative",
  "locally_exposed_metadata",
  "one_way_secret",
  "excluded_operational",
  "deferred_source",
]);

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

function splitSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote !== null) {
      if (char === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function splitTopLevel(input, delimiter = ",") {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote !== null) {
      if (char === quote) {
        if (input[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(input.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function tableBodies(sql) {
  const bodies = [];
  const pattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s*\(/gi;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1];
    const openIndex = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let quote = null;
    for (let index = openIndex; index < sql.length; index += 1) {
      const char = sql[index];
      if (quote !== null) {
        if (char === quote) {
          if (sql[index + 1] === quote) index += 1;
          else quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          bodies.push({ table, body: sql.slice(openIndex + 1, index) });
          break;
        }
      }
    }
  }
  return bodies;
}

function parseColumnName(definition) {
  const trimmed = definition.trim();
  if (!trimmed) return null;
  const first = trimmed.match(/^"([^"]+)"|^([a-zA-Z_][\w]*)/);
  const name = first?.[1] ?? first?.[2] ?? null;
  if (!name) return null;
  if (
    [
      "constraint",
      "unique",
      "primary",
      "foreign",
      "check",
      "index",
      "family",
    ].includes(name.toLowerCase())
  ) {
    return null;
  }
  return name;
}

export function applySchemaSql(schema, rawSql) {
  const sql = stripComments(rawSql);
  for (const statement of splitSqlStatements(sql)) {
    const create = tableBodies(statement)[0];
    if (create) {
      const columns = schema.get(create.table) ?? new Set();
      for (const definition of splitTopLevel(create.body)) {
        const column = parseColumnName(definition);
        if (column) columns.add(column);
      }
      schema.set(create.table, columns);
      continue;
    }

    const dropTable = statement.match(
      /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/i,
    );
    if (dropTable) {
      schema.delete(dropTable[1]);
      continue;
    }

    const alter = statement.match(
      /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+([\s\S]+)$/i,
    );
    if (!alter) continue;
    const table = alter[1];
    const action = alter[2].trim();

    const renameTable = action.match(/^RENAME\s+TO\s+([a-zA-Z_][\w]*)$/i);
    if (renameTable) {
      const columns = schema.get(table);
      if (columns) {
        schema.delete(table);
        schema.set(renameTable[1], columns);
      }
      continue;
    }

    const columns = schema.get(table) ?? new Set();
    const addColumn = action.match(
      /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w]*))/i,
    );
    if (addColumn) {
      columns.add(addColumn[1] ?? addColumn[2]);
      schema.set(table, columns);
      continue;
    }
    const dropColumn = action.match(
      /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w]*))/i,
    );
    if (dropColumn) {
      columns.delete(dropColumn[1] ?? dropColumn[2]);
      schema.set(table, columns);
      continue;
    }
    const renameColumn = action.match(
      /^RENAME\s+COLUMN\s+(?:"([^"]+)"|([a-zA-Z_][\w]*))\s+TO\s+(?:"([^"]+)"|([a-zA-Z_][\w]*))$/i,
    );
    if (renameColumn) {
      const from = renameColumn[1] ?? renameColumn[2];
      const to = renameColumn[3] ?? renameColumn[4];
      if (columns.delete(from)) columns.add(to);
      schema.set(table, columns);
    }
  }
  return schema;
}

export function extractSchemaColumns() {
  const files = [
    SCHEMA_PATH,
    ...readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => join(MIGRATIONS_DIR, name)),
  ];
  const schema = new Map();
  for (const path of files) applySchemaSql(schema, readFileSync(path, "utf8"));
  return new Map(
    [...schema.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, columns]) => [table, [...columns].sort()]),
  );
}

function walkCodeFiles(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        ["node_modules", "dist", "__tests__", "migrations", "schemas"].includes(
          entry.name,
        )
      )
        continue;
      walkCodeFiles(path, output);
    } else if (
      /\.(?:ts|js|mjs)$/.test(entry.name) &&
      !/(?:\.test|\.spec)\.[^.]+$/.test(entry.name)
    ) {
      output.push(path);
    }
  }
  return output;
}

export function discoverSqlCallsites(schema) {
  const files = [
    ...walkCodeFiles(join(REPO_ROOT, "packages")),
    ...walkCodeFiles(join(REPO_ROOT, "apps")),
  ].sort();
  const contents = new Map(
    files.map((path) => [path, readFileSync(path, "utf8")]),
  );
  const result = new Map();
  for (const table of schema.keys()) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\b(?:FROM|INTO|UPDATE|JOIN|TABLE|REFERENCES)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?[\"\\\`]?(?:public\\.)?${escaped}[\"\\\`]?\\b`,
      "i",
    );
    result.set(
      table,
      files
        .filter((path) => pattern.test(contents.get(path)))
        .map((path) => relative(REPO_ROOT, path)),
    );
  }
  return result;
}

export function semanticManifestHash(inventory) {
  const fields = [];
  for (const table of inventory.tables ?? []) {
    for (const group of table.groups ?? []) {
      for (const column of group.columns ?? []) {
        fields.push({
          table: table.table,
          column,
          owner: table.owner,
          currentBoundary: table.boundary?.current,
          targetBoundary: table.boundary?.target,
          classification: group.classification,
          currentProtection: group.currentProtection,
          targetProtection: group.targetProtection,
          migrationStage: group.migrationStage,
          rationale: group.rationale,
          searchableDerivatives: [
            ...(group.searchableDerivatives ?? []),
          ].sort(),
        });
      }
    }
  }
  fields.sort((left, right) =>
    `${left.table}.${left.column}`.localeCompare(
      `${right.table}.${right.column}`,
    ),
  );
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

export function validateInventory(inventory, schema) {
  const errors = [];
  if (inventory.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (inventory.status !== "architecture-decision-only") {
    errors.push(
      "status must remain architecture-decision-only until implementation evidence exists",
    );
  }
  if (inventory.warning !== EXPECTED_WARNING) {
    errors.push("warning must match the exact non-implementation disclaimer");
  }
  if (
    !Array.isArray(inventory.sourceSchema) ||
    inventory.sourceSchema.length !== EXPECTED_SOURCES.length ||
    EXPECTED_SOURCES.some((source) => !inventory.sourceSchema.includes(source))
  ) {
    errors.push(`sourceSchema must enumerate: ${EXPECTED_SOURCES.join(", ")}`);
  }
  if (
    inventory.migrationRunner !== EXPECTED_MIGRATION_RUNNER ||
    !existsSync(join(REPO_ROOT, EXPECTED_MIGRATION_RUNNER))
  ) {
    errors.push(`migrationRunner must be ${EXPECTED_MIGRATION_RUNNER}`);
  }
  if (
    typeof inventory.adr !== "string" ||
    !existsSync(join(REPO_ROOT, String(inventory.adr)))
  ) {
    errors.push("adr must reference an existing repository-relative file");
  }
  const latestMigration = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .at(-1);
  if (inventory.asOfMigration !== latestMigration) {
    errors.push(
      `asOfMigration must match the latest SQL migration (${String(latestMigration)})`,
    );
  }
  if (!Array.isArray(inventory.tables))
    return [...errors, "tables must be an array"];
  const actualBaseline = semanticManifestHash(inventory);
  if (actualBaseline !== EXPECTED_SEMANTIC_BASELINE_SHA256) {
    errors.push(
      `semantic field manifest changed (${actualBaseline}); review the field-level security decision and update the validator baseline deliberately`,
    );
  }

  const sentinels = [
    ["watch_runs", "summary"],
    ["twin_profiles", "temporal_profile"],
    ["brain_pages", "metadata_encrypted"],
    ["oauth_tokens", "encrypted_refresh_token"],
  ];
  for (const [table, column] of sentinels) {
    if (!schema.get(table)?.includes(column)) {
      errors.push(`schema parser sentinel missing: ${table}.${column}`);
    }
  }
  if (schema.has("capability_recipes")) {
    errors.push(
      "schema parser did not apply the capability_recipes drop migration",
    );
  }

  const inventoryTables = new Map();
  const classificationsByField = new Map();
  const searchableDerivativeRefs = [];
  const discoveredCallsites = discoverSqlCallsites(schema);
  for (const entry of inventory.tables) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.table !== "string"
    ) {
      errors.push("each table entry must have a string table name");
      continue;
    }
    if (inventoryTables.has(entry.table))
      errors.push(`duplicate table entry: ${entry.table}`);
    inventoryTables.set(entry.table, entry);
  }

  for (const table of schema.keys()) {
    if (!inventoryTables.has(table))
      errors.push(`schema table is not inventoried: ${table}`);
  }
  for (const table of inventoryTables.keys()) {
    if (!schema.has(table))
      errors.push(`inventoried table is not in the live schema: ${table}`);
  }

  for (const [table, columns] of schema) {
    const entry = inventoryTables.get(table);
    if (!entry) continue;
    if (!OWNER_KINDS.has(entry.owner)) {
      errors.push(`${table}: unknown owner kind ${String(entry.owner)}`);
    }
    if (
      typeof entry.ownershipNotes !== "string" ||
      entry.ownershipNotes.length === 0
    ) {
      errors.push(`${table}: ownershipNotes is required`);
    }
    if (
      !entry.boundary ||
      typeof entry.boundary !== "object" ||
      !CURRENT_BOUNDARIES.has(entry.boundary.current) ||
      !TARGET_BOUNDARIES.has(entry.boundary.target) ||
      !Array.isArray(entry.boundary.auditedCallsites)
    ) {
      errors.push(
        `${table}: boundary current/target enums and auditedCallsites are required`,
      );
    } else {
      const expectedCallsites = discoveredCallsites.get(table) ?? [];
      const actualCallsites = [...entry.boundary.auditedCallsites].sort();
      if (
        actualCallsites.some(
          (path) =>
            typeof path !== "string" || !existsSync(join(REPO_ROOT, path)),
        )
      ) {
        errors.push(
          `${table}: every auditedCallsite must be an existing repository-relative path`,
        );
      }
      if (
        JSON.stringify(actualCallsites) !== JSON.stringify(expectedCallsites)
      ) {
        errors.push(
          `${table}: auditedCallsites must match the conservative static SQL scan`,
        );
      }
      const expectedCurrent =
        expectedCallsites.length === 0
          ? "no_runtime_sql_found"
          : expectedCallsites.every((path) =>
                path.startsWith("packages/db/src/repositories/"),
              )
            ? "repository_sql"
            : "mixed_repository_and_direct_sql";
      if (entry.boundary.current !== expectedCurrent) {
        errors.push(`${table}: current boundary must be ${expectedCurrent}`);
      }
    }
    if (!Array.isArray(entry.groups) || entry.groups.length === 0) {
      errors.push(`${table}: groups must be a non-empty array`);
      continue;
    }
    const classified = new Map();
    for (const group of entry.groups) {
      if (!CLASSIFICATIONS.has(group.classification)) {
        errors.push(
          `${table}: unknown classification ${String(group.classification)}`,
        );
      }
      for (const required of [
        "currentProtection",
        "targetProtection",
        "migrationStage",
        "rationale",
      ]) {
        if (
          typeof group[required] !== "string" ||
          group[required].length === 0
        ) {
          errors.push(
            `${table}.${group.classification}: ${required} is required`,
          );
        }
      }
      if (!Array.isArray(group.columns) || group.columns.length === 0) {
        errors.push(
          `${table}.${group.classification}: columns must be non-empty`,
        );
        continue;
      }
      for (const column of group.columns) {
        if (classified.has(column))
          errors.push(`${table}.${column}: classified more than once`);
        classified.set(column, group.classification);
        classificationsByField.set(`${table}.${column}`, group.classification);
      }
      if (
        group.searchableDerivatives !== undefined &&
        !Array.isArray(group.searchableDerivatives)
      ) {
        errors.push(
          `${table}.${group.classification}: searchableDerivatives must be an array`,
        );
      }
      if (
        ["encrypted_source", "deferred_source"].includes(
          group.classification,
        ) &&
        !Array.isArray(group.searchableDerivatives)
      ) {
        errors.push(
          `${table}.${group.classification}: searchableDerivatives must be explicit`,
        );
      }
      if (Array.isArray(group.searchableDerivatives)) {
        for (const derivative of group.searchableDerivatives) {
          if (typeof derivative !== "string") {
            errors.push(
              `${table}.${group.classification}: searchable derivative must be a string field reference`,
            );
          } else {
            searchableDerivativeRefs.push([
              table,
              group.classification,
              derivative,
            ]);
          }
        }
      }
    }
    for (const column of columns) {
      if (!classified.has(column))
        errors.push(`${table}.${column}: not classified`);
    }
    for (const column of classified.keys()) {
      if (!columns.includes(column))
        errors.push(`${table}.${column}: not in the live schema`);
    }
  }
  for (const [
    sourceTable,
    sourceClassification,
    derivative,
  ] of searchableDerivativeRefs) {
    if (
      classificationsByField.get(derivative) !== "locally_exposed_derivative"
    ) {
      errors.push(
        `${sourceTable}.${sourceClassification}: searchable derivative ${derivative} must identify a classified locally_exposed_derivative field`,
      );
    }
  }
  const requireField = (field, classification) => {
    if (classificationsByField.get(field) !== classification) {
      errors.push(`${field}: critical invariant requires ${classification}`);
    }
  };
  for (const field of [
    "oauth_tokens.access_token",
    "oauth_tokens.refresh_token",
    "oauth_tokens.encrypted_access_token",
    "oauth_tokens.encrypted_refresh_token",
  ]) {
    requireField(field, "encrypted_source");
  }
  for (const field of [
    "credential_requirements.description",
    "credential_requirements.field_key",
    "ironclaw_tools.description",
    "ironclaw_tools.tool_name",
    "service_credentials.credential_value",
    "worker_dead_letter.context",
  ]) {
    requireField(field, "encrypted_source");
  }
  const criticalBoundaries = [
    ["oauth_tokens", "user", "user_broker_gateway"],
    ["credential_requirements", "installation", "installation_broker_gateway"],
    ["ironclaw_tools", "installation", "installation_broker_gateway"],
    ["service_credentials", "installation", "installation_broker_gateway"],
    ["worker_dead_letter", "system_global", "content_free_global"],
  ];
  for (const [table, owner, target] of criticalBoundaries) {
    const entry = inventoryTables.get(table);
    if (entry?.owner !== owner || entry?.boundary?.target !== target) {
      errors.push(
        `${table}: critical invariant requires owner=${owner} target=${target}`,
      );
    }
  }
  return errors;
}

function main() {
  const schema = extractSchemaColumns();
  if (process.argv.includes("--print-schema")) {
    process.stdout.write(
      `${JSON.stringify(Object.fromEntries(schema), null, 2)}\n`,
    );
    return;
  }
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
  const errors = validateInventory(inventory, schema);
  if (errors.length > 0) {
    process.stderr.write(
      `Encryption field inventory validation failed (${errors.length}):\n`,
    );
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const columnCount = [...schema.values()].reduce(
    (sum, columns) => sum + columns.length,
    0,
  );
  process.stdout.write(
    `Encryption field inventory covers ${schema.size} tables and ${columnCount} columns.\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
