import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applySchemaSql,
  extractSchemaColumns,
  validateInventory,
} from "./validate-encryption-field-inventory.mjs";

const inventoryPath = new URL(
  "../../docs/security/encryption-field-inventory.json",
  import.meta.url,
);

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
