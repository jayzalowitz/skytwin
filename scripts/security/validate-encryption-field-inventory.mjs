#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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
const MIGRATION_RUNNER_PATH = join(REPO_ROOT, EXPECTED_MIGRATION_RUNNER);
const EXPECTED_MIGRATION_RUNNER_SHA256 =
  "78be83cc8197f4a07fc7e1498996bf33ce56ebefa81357430a8b7443f9f2764f";
const EXPECTED_SCHEMA_CORPUS_SHA256 =
  "4be48c9c97a6f08c3a2c481b439f1969047e9c049ac8edb1c456a1f22296978e";
const EXPECTED_WARNING =
  "This inventory records current exposure and the proposed target boundary. It is not evidence that target encryption is implemented or accepted.";
const EXPECTED_SEMANTIC_BASELINE_SHA256 =
  "5f764246f844252870cc9b5e0636323acb98a31271e087b40b5d4c67b5546d27";

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
  "forbidden_global_source",
]);

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate a repository-relative path without following a symlink outside the
 * checkout. The inventory is reviewed source, but accepting directories,
 * absolute paths, or symlinks would make its evidence boundary misleading.
 */
export function isRepositoryRegularFile(root, repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath)
  ) {
    return false;
  }
  try {
    const absoluteRoot = realpathSync(root);
    const lexicalPath = resolve(absoluteRoot, repositoryPath);
    if (!isContained(absoluteRoot, lexicalPath) || !existsSync(lexicalPath)) {
      return false;
    }
    const lexicalStat = lstatSync(lexicalPath);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) return false;
    const canonicalPath = realpathSync(lexicalPath);
    return (
      canonicalPath === lexicalPath && isContained(absoluteRoot, canonicalPath)
    );
  } catch {
    return false;
  }
}

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
          bodies.push({
            table,
            body: sql.slice(openIndex + 1, index),
            endIndex: index,
          });
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
      "like",
    ].includes(name.toLowerCase())
  ) {
    return null;
  }
  return name;
}

function modeledNonColumnDefinition(definition) {
  const name = '(?:"[^"]+"|[a-zA-Z_][\\w]*)';
  const constraint = `(?:CONSTRAINT\\s+${name}\\s+)?`;
  if (
    new RegExp(`^${constraint}PRIMARY\\s+KEY\\s*\\([\\s\\S]+\\)$`, "i").test(
      definition,
    )
  ) {
    return "primary_key";
  }
  if (
    new RegExp(`^${constraint}(?:UNIQUE|CHECK)\\s*\\([\\s\\S]+\\)$`, "i").test(
      definition,
    ) ||
    new RegExp(
      `^${constraint}FOREIGN\\s+KEY\\s*\\([\\s\\S]+\\)\\s+REFERENCES\\s+[\\s\\S]+$`,
      "i",
    ).test(definition) ||
    new RegExp(
      `^(?:INDEX|FAMILY)(?:\\s+${name})?\\s*\\([\\s\\S]+\\)$`,
      "i",
    ).test(definition)
  ) {
    return "modeled_non_column";
  }
  return null;
}

function containsInlinePrimaryKey(definition) {
  const withoutQuotedContent = definition
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
  return /\bPRIMARY\s+KEY\b/i.test(withoutQuotedContent);
}

export function applySchemaSql(schema, rawSql) {
  const sql = stripComments(rawSql);
  for (const statement of splitSqlStatements(sql)) {
    if (
      /\bUSING\s+HASH\b/i.test(statement) ||
      /^CREATE\s+MATERIALIZED\s+VIEW\b/i.test(statement)
    ) {
      throw new Error(`unsupported schema-mutating DDL: ${statement}`);
    }
    if (
      /^CREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\b/i.test(statement)
    ) {
      const creates = tableBodies(statement);
      const create = creates[0];
      const createSuffix = create
        ? statement.slice(create.endIndex + 1).trim()
        : "";
      const supportedTtlSuffix =
        /^WITH\s*\(\s*ttl_expiration_expression\s*=\s*'expires_at'\s*\)$/i.test(
          createSuffix,
        );
      if (
        creates.length !== 1 ||
        !create ||
        (createSuffix !== "" && !supportedTtlSuffix)
      ) {
        throw new Error(`unsupported schema-mutating DDL: ${statement}`);
      }
      const columns = schema.get(create.table) ?? new Set();
      let hasPrimaryKey = false;
      for (const definition of splitTopLevel(create.body)) {
        const trimmed = definition.trim();
        const nonColumnKind = modeledNonColumnDefinition(trimmed);
        if (nonColumnKind) {
          if (nonColumnKind === "primary_key") hasPrimaryKey = true;
          continue;
        }
        const column = parseColumnName(definition);
        if (!column) {
          throw new Error(`unsupported schema-mutating DDL: ${statement}`);
        }
        columns.add(column);
        if (containsInlinePrimaryKey(trimmed)) hasPrimaryKey = true;
      }
      if (!hasPrimaryKey) {
        throw new Error(`unsupported schema-mutating DDL: ${statement}`);
      }
      schema.set(create.table, columns);
      continue;
    }

    if (/^DROP\s+TABLE\b/i.test(statement)) {
      const dropTable = statement.match(
        /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)(?:\s+(?:CASCADE|RESTRICT))?$/i,
      );
      if (!dropTable) {
        throw new Error(`unsupported schema-mutating DDL: ${statement}`);
      }
      schema.delete(dropTable[1]);
      continue;
    }

    if (!/^ALTER\s+TABLE\b/i.test(statement)) continue;
    const alter = statement.match(
      /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+([\s\S]+)$/i,
    );
    if (!alter) {
      throw new Error(`unsupported schema-mutating DDL: ${statement}`);
    }
    const table = alter[1];
    const action = alter[2].trim();
    if (splitTopLevel(action).length !== 1) {
      throw new Error(`unsupported schema-mutating DDL: ${statement}`);
    }

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
      /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w]*))\s+[\s\S]+$/i,
    );
    if (addColumn) {
      columns.add(addColumn[1] ?? addColumn[2]);
      schema.set(table, columns);
      continue;
    }
    const dropColumn = action.match(
      /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([a-zA-Z_][\w]*))(?:\s+(?:CASCADE|RESTRICT))?$/i,
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
      continue;
    }
    if (
      /^ALTER\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"[^"]+"|[a-zA-Z_][\w]*)\s+[\s\S]+$/i.test(
        action,
      ) ||
      /^ADD\s+CONSTRAINT\s+(?:"[^"]+"|[a-zA-Z_][\w]*)\s+[\s\S]+$/i.test(
        action,
      ) ||
      /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(?:"[^"]+"|[a-zA-Z_][\w]*)(?:\s+(?:CASCADE|RESTRICT))?$/i.test(
        action,
      )
    ) {
      continue;
    }
    throw new Error(`unsupported schema-mutating DDL: ${statement}`);
  }
  return schema;
}

/**
 * Check the production runner construct that selects migrations. This parser
 * intentionally accepts only the simple contract the runner uses today:
 * schema.sql first, then every sibling .sql file in default lexical order.
 * If the runner becomes conditional or gains a different ordering policy, the
 * inventory validator fails until its schema reconstruction is updated too.
 */
export function migrationRunnerContractErrors(source) {
  const errors = [];
  const runnerHash = createHash("sha256")
    .update(source.replaceAll("\r\n", "\n"))
    .digest("hex");
  if (runnerHash !== EXPECTED_MIGRATION_RUNNER_SHA256) {
    errors.push(
      "production migration runner must match the reviewed source baseline",
    );
  }
  const parsed = ts.createSourceFile(
    "migration-runner.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let applyMigrations;
  let fileLoop;
  let schemaReadNode;
  let schemaQueryNode;
  let sqlFilesDeclaration;
  const entrypointFunctions = new Map();
  const validEntrypoints = new Set();

  function countApplyMigrations(
    node,
    entrypoint,
    root = false,
    conditionallySkipped = false,
  ) {
    if (!root && ts.isFunctionLike(node)) return 0;
    const nextConditionallySkipped =
      conditionallySkipped ||
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isSwitchStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node);
    let count = 0;
    if (
      !nextConditionallySkipped &&
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "applyMigrations" &&
      node.expression.arguments.length === 2 &&
      ts.isIdentifier(node.expression.arguments[0]) &&
      ((entrypoint === "up" &&
        node.expression.arguments[0].text === "pool" &&
        ts.isArrowFunction(node.expression.arguments[1]) &&
        node.expression.arguments[1].parameters.length === 0 &&
        node.expression.arguments[1].body.kind === ts.SyntaxKind.TrueKeyword) ||
        (entrypoint === "upOwned" &&
          node.expression.arguments[0].text === "target" &&
          ts.isPropertyAccessExpression(node.expression.arguments[1]) &&
          ts.isIdentifier(node.expression.arguments[1].expression) &&
          node.expression.arguments[1].expression.text === "options" &&
          node.expression.arguments[1].name.text === "authorize"))
    ) {
      count += 1;
    }
    ts.forEachChild(node, (child) => {
      count += countApplyMigrations(
        child,
        entrypoint,
        false,
        nextConditionallySkipped,
      );
    });
    return count;
  }

  function visitEntrypoints(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      (node.name?.text === "up" || node.name?.text === "upOwned") &&
      node.body
    ) {
      entrypointFunctions.set(node.name.text, node);
      if (countApplyMigrations(node.body, node.name.text, true) === 1) {
        validEntrypoints.add(node.name.text);
      }
    }
    ts.forEachChild(node, visitEntrypoints);
  }
  visitEntrypoints(parsed);
  if (!validEntrypoints.has("up") || !validEntrypoints.has("upOwned")) {
    errors.push(
      "production migration runner must route CLI and owned entry points through the ordered migration flow",
    );
  }

  function findApplyMigrations(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "applyMigrations"
    ) {
      applyMigrations = node;
      return;
    }
    ts.forEachChild(node, findApplyMigrations);
  }
  findApplyMigrations(parsed);
  const clientParameter = applyMigrations?.parameters[0]?.name;
  const clientName = ts.isIdentifier(clientParameter)
    ? clientParameter.text
    : undefined;

  function queryReceiver(node) {
    if (!ts.isCallExpression(node)) return undefined;
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    ) {
      return node.expression.expression;
    }
    if (
      ts.isElementAccessExpression(node.expression) &&
      ts.isStringLiteral(node.expression.argumentExpression) &&
      node.expression.argumentExpression.text === "query"
    ) {
      return node.expression.expression;
    }
    return undefined;
  }

  function collectQueryCalls(node) {
    const calls = [];
    function visit(candidate) {
      if (queryReceiver(candidate)) calls.push(candidate);
      ts.forEachChild(candidate, visit);
    }
    if (node) visit(node);
    return calls;
  }

  function isBootstrapQuery(node, receiverName) {
    const receiver = queryReceiver(node);
    return (
      ts.isIdentifier(receiver) &&
      receiver.text === receiverName &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "CREATE DATABASE IF NOT EXISTS skytwin"
    );
  }

  const upQueries = collectQueryCalls(entrypointFunctions.get("up")?.body);
  const upOwnedQueries = collectQueryCalls(
    entrypointFunctions.get("upOwned")?.body,
  );
  if (
    upQueries.length !== 1 ||
    !isBootstrapQuery(upQueries[0], "pool") ||
    upOwnedQueries.length !== 1 ||
    !isBootstrapQuery(upOwnedQueries[0], "admin")
  ) {
    errors.push(
      "production migration runner entry points must only execute the exact database bootstrap before the shared migration flow",
    );
  }

  if (applyMigrations?.body && clientName) {
    let schemaQueryCalls = 0;
    let statementQueryCalls = 0;
    let hasUnexpectedQuery = false;
    let hasUnexpectedClientUse = false;

    function isDirectQueryReceiver(node) {
      const access = node.parent;
      const call = access?.parent;
      return (
        ((ts.isPropertyAccessExpression(access) &&
          access.expression === node &&
          access.name.text === "query") ||
          (ts.isElementAccessExpression(access) &&
            access.expression === node &&
            ts.isStringLiteral(access.argumentExpression) &&
            access.argumentExpression.text === "query")) &&
        ts.isCallExpression(call) &&
        call.expression === access
      );
    }

    function auditQueryCalls(node) {
      const receiver = queryReceiver(node);
      if (receiver) {
        if (!ts.isIdentifier(receiver) || receiver.text !== clientName) {
          hasUnexpectedQuery = true;
        } else if (
          node.arguments.length === 1 &&
          ts.isIdentifier(node.arguments[0]) &&
          node.arguments[0].text === "schema"
        ) {
          schemaQueryCalls += 1;
        } else if (
          node.arguments.length === 1 &&
          ts.isIdentifier(node.arguments[0]) &&
          node.arguments[0].text === "stmt"
        ) {
          statementQueryCalls += 1;
        } else {
          hasUnexpectedQuery = true;
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === clientName &&
        !isDirectQueryReceiver(node)
      ) {
        hasUnexpectedClientUse = true;
      }
      ts.forEachChild(node, auditQueryCalls);
    }
    auditQueryCalls(applyMigrations.body);

    if (
      schemaQueryCalls !== 1 ||
      statementQueryCalls !== 1 ||
      hasUnexpectedQuery ||
      hasUnexpectedClientUse
    ) {
      errors.push(
        "production migration runner must not execute SQL outside the exact schema and per-statement migration queries",
      );
    }
  }

  function visitOrderedFlow(node, conditionallySkipped = false) {
    if (node !== applyMigrations?.body && ts.isFunctionLike(node)) return;
    const nextConditionallySkipped =
      conditionallySkipped ||
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isSwitchStatement(node);
    if (
      !nextConditionallySkipped &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "schema" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "readFileSync" &&
      node.initializer.arguments.length >= 1 &&
      ts.isIdentifier(node.initializer.arguments[0]) &&
      node.initializer.arguments[0].text === "SCHEMA_PATH"
    ) {
      schemaReadNode = node;
    }
    if (
      !nextConditionallySkipped &&
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === clientName &&
      node.expression.expression.name.text === "query" &&
      node.expression.arguments.length === 1 &&
      ts.isIdentifier(node.expression.arguments[0]) &&
      node.expression.arguments[0].text === "schema"
    ) {
      schemaQueryNode = node;
    }
    if (
      !nextConditionallySkipped &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "sqlFiles"
    ) {
      sqlFilesDeclaration = node;
    }
    if (
      !nextConditionallySkipped &&
      ts.isForOfStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "sqlFiles" &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.length === 1 &&
      ts.isIdentifier(node.initializer.declarations[0].name) &&
      node.initializer.declarations[0].name.text === "file"
    ) {
      fileLoop = node;
    }
    ts.forEachChild(node, (child) =>
      visitOrderedFlow(child, nextConditionallySkipped),
    );
  }
  if (applyMigrations?.body) visitOrderedFlow(applyMigrations.body);

  const selectionInitializer =
    sqlFilesDeclaration?.initializer?.getText(parsed);
  const validSelectionInitializer =
    typeof selectionInitializer === "string" &&
    /^readdirSync\(__dirname\)\s*\.filter\(\(f\)\s*=>\s*f\.endsWith\(['"]\.sql['"]\)\)\s*\.sort\(\)$/.test(
      selectionInitializer,
    );
  if (!validSelectionInitializer) {
    errors.push(
      "production migration runner must select every sibling .sql file in lexical order",
    );
  }
  const sqlFilesStatement = sqlFilesDeclaration?.parent?.parent;
  if (
    sqlFilesStatement &&
    fileLoop &&
    stripCodeComments(
      source.slice(sqlFilesStatement.getEnd(), fileLoop.getStart(parsed)),
    ).trim() !== ""
  ) {
    errors.push(
      "production migration runner must not modify the selected SQL files before iteration",
    );
  }
  if (
    !applyMigrations ||
    !clientName ||
    !schemaReadNode ||
    !schemaQueryNode ||
    !sqlFilesDeclaration ||
    !fileLoop ||
    schemaReadNode.getStart(parsed) > schemaQueryNode.getStart(parsed) ||
    schemaQueryNode.getStart(parsed) > sqlFilesDeclaration.getStart(parsed) ||
    sqlFilesDeclaration.getStart(parsed) > fileLoop.getStart(parsed)
  ) {
    errors.push(
      "production migration runner must execute schema.sql before incremental migrations",
    );
  }

  const isNamedCall = (node, name) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name;
  const declarationInitializer = (statement, name) => {
    if (!ts.isVariableStatement(statement)) return undefined;
    const declaration = statement.declarationList.declarations.find(
      (candidate) =>
        ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    return declaration?.initializer;
  };

  let readsSelectedFile = false;
  let splitsSelectedSql = false;
  let executesEveryStatement = false;
  let skipsSelectedFile = false;
  if (fileLoop && ts.isBlock(fileLoop.statement)) {
    const statements = fileLoop.statement.statements;
    const readIndex = statements.findIndex((statement) => {
      const initializer = declarationInitializer(statement, "sql");
      if (!initializer || !isNamedCall(initializer, "readFileSync"))
        return false;
      const path = initializer.arguments[0];
      return (
        path !== undefined &&
        isNamedCall(path, "join") &&
        path.arguments.length >= 2 &&
        ts.isIdentifier(path.arguments[0]) &&
        path.arguments[0].text === "__dirname" &&
        ts.isIdentifier(path.arguments[1]) &&
        path.arguments[1].text === "file"
      );
    });
    readsSelectedFile = readIndex !== -1;

    const splitIndex = statements.findIndex((statement) => {
      const initializer = declarationInitializer(statement, "statements");
      return (
        initializer !== undefined &&
        isNamedCall(initializer, "splitSqlStatements") &&
        initializer.arguments.length === 1 &&
        ts.isIdentifier(initializer.arguments[0]) &&
        initializer.arguments[0].text === "sql"
      );
    });
    splitsSelectedSql = splitIndex > readIndex && readIndex !== -1;

    const statementLoopIndex = statements.findIndex(
      (statement) =>
        ts.isForOfStatement(statement) &&
        ts.isIdentifier(statement.expression) &&
        statement.expression.text === "statements" &&
        ts.isVariableDeclarationList(statement.initializer) &&
        statement.initializer.declarations.length === 1 &&
        ts.isIdentifier(statement.initializer.declarations[0].name) &&
        statement.initializer.declarations[0].name.text === "stmt",
    );
    skipsSelectedFile = statements
      .slice(
        0,
        statementLoopIndex === -1 ? statements.length : statementLoopIndex,
      )
      .some(
        (statement) =>
          ts.isIfStatement(statement) ||
          ts.isContinueStatement(statement) ||
          ts.isReturnStatement(statement),
      );

    const statementLoop = statements[statementLoopIndex];
    if (
      statementLoopIndex > splitIndex &&
      splitIndex !== -1 &&
      ts.isForOfStatement(statementLoop)
    ) {
      function findExecution(node, conditionallySkipped = false) {
        const nextConditionallySkipped =
          conditionallySkipped ||
          ts.isIfStatement(node) ||
          ts.isConditionalExpression(node) ||
          ts.isSwitchStatement(node);
        if (
          !nextConditionallySkipped &&
          ts.isAwaitExpression(node) &&
          ts.isCallExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression) &&
          node.expression.expression.expression.text === clientName &&
          node.expression.expression.name.text === "query" &&
          node.expression.arguments.length === 1 &&
          ts.isIdentifier(node.expression.arguments[0]) &&
          node.expression.arguments[0].text === "stmt"
        ) {
          executesEveryStatement = true;
        }
        ts.forEachChild(node, (child) =>
          findExecution(child, nextConditionallySkipped),
        );
      }
      findExecution(statementLoop.statement);
    }
  }
  if (!readsSelectedFile) {
    errors.push("production migration runner must read each selected SQL file");
  }
  if (!splitsSelectedSql) {
    errors.push(
      "production migration runner must split each selected SQL file",
    );
  }
  if (!executesEveryStatement || skipsSelectedFile) {
    errors.push(
      "production migration runner must execute every statement from every selected SQL file",
    );
  }
  return errors;
}

export function productionMigrationSourceFiles() {
  const runnerErrors = migrationRunnerContractErrors(
    readFileSync(MIGRATION_RUNNER_PATH, "utf8"),
  );
  if (runnerErrors.length > 0) {
    throw new Error(runnerErrors.join("; "));
  }
  const files = [
    SCHEMA_PATH,
    ...readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => join(MIGRATIONS_DIR, name)),
  ];
  const corpusErrors = schemaCorpusContractErrors(files);
  if (corpusErrors.length > 0) {
    throw new Error(corpusErrors.join("; "));
  }
  return files;
}

export function schemaCorpusContractErrors(
  files,
  readSource = (path) => readFileSync(path, "utf8"),
) {
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(normalizeRepositoryPath(relative(REPO_ROOT, path)));
    hash.update("\0");
    hash.update(readSource(path).replaceAll("\r\n", "\n"));
    hash.update("\0");
  }
  return hash.digest("hex") === EXPECTED_SCHEMA_CORPUS_SHA256
    ? []
    : ["migration SQL corpus must match the reviewed source baseline"];
}

export function extractSchemaColumns() {
  const files = productionMigrationSourceFiles();
  const schema = new Map();
  for (const path of files) applySchemaSql(schema, readFileSync(path, "utf8"));
  return new Map(
    [...schema.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, columns]) => [table, [...columns].sort()]),
  );
}

function stripCodeComments(source) {
  let output = "";
  let state = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (char === "\n") {
        output += char;
        state = "code";
      } else output += " ";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (["single", "double", "template"].includes(state)) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      )
        state = "code";
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block-comment";
    } else {
      output += char;
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
    }
  }
  return output;
}

/**
 * Return string/template literal bodies that are SQL statements or SQL
 * fragments. Restricting table discovery to SQL-shaped literals avoids
 * treating UI prose such as "from Watches" as a database callsite while still
 * covering query text assigned to a variable before it is executed.
 */
export function sqlTextCandidates(source) {
  const parsed = ts.createSourceFile(
    "sql-callsite.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const candidates = [];
  let hasQueryCall = false;
  const sqlStart =
    /^\s*(?:SELECT|INSERT|UPSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|TRUNCATE|FROM|JOIN|INTO|REFERENCES)\b/i;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "query") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "query"))
    ) {
      hasQueryCall = true;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const text = source.slice(node.getStart(parsed) + 1, node.getEnd() - 1);
      if (sqlStart.test(text)) candidates.push(text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return hasQueryCall ? candidates : [];
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

const DYNAMIC_SQL_ANNOTATION =
  /@encryption-inventory-dynamic-sql\s+tables=([a-z_][a-z0-9_]*(?:,[a-z_][a-z0-9_]*)*)/g;
const DYNAMIC_SQL_HELPER_ANNOTATION =
  /@encryption-inventory-dynamic-sql-helper\s+seedUpsert\s+tables=([a-z_][a-z0-9_]*(?:,[a-z_][a-z0-9_]*)*)/g;

function annotationTables(content, pattern) {
  const tables = new Set();
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    for (const table of match[1].split(",")) tables.add(table);
  }
  return tables;
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function normalizeRepositoryPath(repositoryPath) {
  return repositoryPath.replaceAll("\\", "/");
}

function repositoryRelativePath(root, candidate, pathRelative) {
  return normalizeRepositoryPath(pathRelative(root, candidate));
}

export function classifyCurrentBoundary(callsites) {
  if (callsites.length === 0) return "no_runtime_sql_found";
  return callsites.every((path) =>
    normalizeRepositoryPath(path).startsWith("packages/db/src/repositories/"),
  )
    ? "repository_sql"
    : "mixed_repository_and_direct_sql";
}

function seedUpsertRuntimeAllowlist(content) {
  const parsed = ts.createSourceFile(
    "seed-upsert.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tables = new Set();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text !== "SEED_UPSERT_TABLES" || !node.initializer) return;
      const initializer = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (!ts.isArrayLiteralExpression(initializer)) return;
      for (const element of initializer.elements) {
        if (ts.isStringLiteral(element)) tables.add(element.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return tables;
}

export function auditSeedUpsertHelper(repoPath, content, schema) {
  const annotated = annotationTables(content, DYNAMIC_SQL_HELPER_ANNOTATION);
  const runtimeTables = seedUpsertRuntimeAllowlist(content);
  const errors = [];
  if (annotated.size === 0) {
    errors.push(
      `${repoPath}: seedUpsert helper must declare its audited table set`,
    );
  }
  if (!sameStringSet(annotated, runtimeTables)) {
    errors.push(
      `${repoPath}: seedUpsert helper annotation must match its runtime table allowlist`,
    );
  }
  for (const table of new Set([...annotated, ...runtimeTables])) {
    if (!schema.has(table)) {
      errors.push(
        `${repoPath}: helper annotation names unknown table ${table}`,
      );
    }
  }
  return { annotated, runtimeTables, errors };
}

export function auditDynamicSqlFile(repoPath, content, schema) {
  const code = stripCodeComments(content);
  const sql = sqlTextCandidates(content).join("\n");
  const annotated = annotationTables(content, DYNAMIC_SQL_ANNOTATION);
  const callsSeedUpsert = /\bseedUpsert\s*\(/.test(code);
  const dynamicExpressions = [
    ...sql.matchAll(
      /\b(?:FROM|INTO|UPDATE|JOIN|TABLE|REFERENCES|TRUNCATE)\s+(?:["`])?\$\{([^}]+)\}(?:["`])?/gi,
    ),
  ].map((match) => match[1].trim());
  const dynamicIdentifiers = new Set(
    dynamicExpressions.filter((expression) =>
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expression),
    ),
  );
  const unsupportedDynamicExpressions = dynamicExpressions.filter(
    (expression) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expression),
  );
  const errors = [];
  if (
    (dynamicExpressions.length > 0 || callsSeedUpsert) &&
    annotated.size === 0
  ) {
    errors.push(
      `${repoPath}: dynamic SQL must declare @encryption-inventory-dynamic-sql tables=...`,
    );
  }
  for (const expression of unsupportedDynamicExpressions) {
    errors.push(
      `${repoPath}: dynamic SQL expression ${expression} needs a validator-supported finite table declaration`,
    );
  }

  const loopTables = new Set();
  for (const identifier of dynamicIdentifiers) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const loop = code.match(
      new RegExp(
        `for\\s*\\(\\s*const\\s+${escaped}\\s+of\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
      ),
    );
    if (!loop) {
      errors.push(
        `${repoPath}: dynamic SQL identifier ${identifier} needs a validator-supported finite table declaration`,
      );
      continue;
    }
    for (const match of loop[1].matchAll(/['"]([a-z_][a-z0-9_]*)['"]/g)) {
      loopTables.add(match[1]);
    }
  }
  if (loopTables.size > 0 && !sameStringSet(annotated, loopTables)) {
    errors.push(
      `${repoPath}: dynamic SQL annotation must match its literal loop table set`,
    );
  }

  if (callsSeedUpsert) {
    const literalTables = new Set(
      [...content.matchAll(/\btable\s*:\s*['"]([a-z_][a-z0-9_]*)['"]/g)].map(
        (match) => match[1],
      ),
    );
    if (!sameStringSet(annotated, literalTables)) {
      errors.push(
        `${repoPath}: seedUpsert annotation must match its literal table properties`,
      );
    }
  }
  for (const table of annotated) {
    if (!schema.has(table)) {
      errors.push(
        `${repoPath}: dynamic SQL annotation names unknown table ${table}`,
      );
    }
  }
  return { annotated, callsSeedUpsert, errors };
}

let cachedCallsiteSignature;
let cachedCallsiteAudit;

export function discoverSqlCallsiteAudit(schema, pathRelative = relative) {
  const signature = [...schema.keys()].sort().join("\0");
  const useCache = pathRelative === relative;
  if (
    useCache &&
    signature === cachedCallsiteSignature &&
    cachedCallsiteAudit
  ) {
    return cachedCallsiteAudit;
  }
  const files = [
    ...walkCodeFiles(join(REPO_ROOT, "packages")),
    ...walkCodeFiles(join(REPO_ROOT, "apps")),
  ].sort();
  const contents = new Map(
    files.map((path) => [path, readFileSync(path, "utf8")]),
  );
  const sqlCandidates = new Map(
    files.map((path) => [
      path,
      sqlTextCandidates(contents.get(path)).join("\n"),
    ]),
  );
  const result = new Map([...schema.keys()].map((table) => [table, new Set()]));
  const errors = [];
  for (const table of schema.keys()) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `\\b(?:FROM|INTO|UPDATE|JOIN|TABLE|REFERENCES)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?[\"\\\`]?(?:public\\.)?${escaped}[\"\\\`]?\\b`,
      "i",
    );
    for (const path of files) {
      if (pattern.test(sqlCandidates.get(path))) {
        result
          .get(table)
          .add(repositoryRelativePath(REPO_ROOT, path, pathRelative));
      }
    }
  }

  const helperPath = join(
    REPO_ROOT,
    "packages",
    "db",
    "src",
    "seeds",
    "upsert.ts",
  );
  const helperRepoPath = repositoryRelativePath(
    REPO_ROOT,
    helperPath,
    pathRelative,
  );
  const helperAudit = auditSeedUpsertHelper(
    helperRepoPath,
    contents.get(helperPath) ?? "",
    schema,
  );
  const helperTables = helperAudit.annotated;
  errors.push(...helperAudit.errors);
  const callerTables = new Set();
  for (const path of files) {
    const content = contents.get(path);
    const repoPath = repositoryRelativePath(REPO_ROOT, path, pathRelative);
    const dynamicAudit =
      path === helperPath
        ? { annotated: new Set(), callsSeedUpsert: false, errors: [] }
        : auditDynamicSqlFile(repoPath, content, schema);
    errors.push(...dynamicAudit.errors);
    const { annotated, callsSeedUpsert } = dynamicAudit;
    for (const table of annotated) {
      if (!schema.has(table)) continue;
      result.get(table).add(repoPath);
      if (callsSeedUpsert) callerTables.add(table);
    }
  }
  for (const table of new Set([...helperTables, ...callerTables])) {
    if (!schema.has(table)) {
      errors.push(
        `${helperRepoPath}: helper annotation names unknown table ${table}`,
      );
      continue;
    }
    if (!helperTables.has(table) || !callerTables.has(table)) {
      errors.push(
        `${helperRepoPath}: seedUpsert helper and caller annotations disagree for ${table}`,
      );
    }
    result.get(table).add(helperRepoPath);
  }
  const audit = {
    callsites: new Map(
      [...result].map(([table, paths]) => [table, [...paths].sort()]),
    ),
    errors,
  };
  if (useCache) {
    cachedCallsiteSignature = signature;
    cachedCallsiteAudit = audit;
  }
  return audit;
}

export function discoverSqlCallsites(schema) {
  return discoverSqlCallsiteAudit(schema).callsites;
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
          operationalDependencies: [...(group.operationalDependencies ?? [])]
            .map((dependency) => ({
              jsonPath: dependency.jsonPath,
              currentUsage: dependency.currentUsage,
              targetResolution: dependency.targetResolution,
            }))
            .sort((left, right) => left.jsonPath.localeCompare(right.jsonPath)),
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
    !isRepositoryRegularFile(REPO_ROOT, EXPECTED_MIGRATION_RUNNER)
  ) {
    errors.push(`migrationRunner must be ${EXPECTED_MIGRATION_RUNNER}`);
  } else {
    errors.push(
      ...migrationRunnerContractErrors(
        readFileSync(MIGRATION_RUNNER_PATH, "utf8"),
      ),
    );
  }
  if (
    typeof inventory.adr !== "string" ||
    !isRepositoryRegularFile(REPO_ROOT, inventory.adr)
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
  const callsiteAudit = discoverSqlCallsiteAudit(schema);
  errors.push(...callsiteAudit.errors);
  const discoveredCallsites = callsiteAudit.callsites;
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
            typeof path !== "string" ||
            !isRepositoryRegularFile(REPO_ROOT, path),
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
      const expectedCurrent = classifyCurrentBoundary(expectedCallsites);
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
      if (group.operationalDependencies !== undefined) {
        if (!Array.isArray(group.operationalDependencies)) {
          errors.push(
            `${table}.${group.classification}: operationalDependencies must be an array`,
          );
        } else {
          for (const dependency of group.operationalDependencies) {
            if (
              !dependency ||
              typeof dependency !== "object" ||
              !["jsonPath", "currentUsage", "targetResolution"].every(
                (key) =>
                  typeof dependency[key] === "string" &&
                  dependency[key].length > 0,
              )
            ) {
              errors.push(
                `${table}.${group.classification}: every operational dependency needs jsonPath, currentUsage, and targetResolution`,
              );
            }
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
  ]) {
    requireField(field, "encrypted_source");
  }
  for (const field of [
    "worker_dead_letter.context",
    "worker_dead_letter.error_message",
  ]) {
    requireField(field, "forbidden_global_source");
  }
  requireField("worker_generation_authority.secret_hash", "one_way_secret");
  requireField("brain_pages.metadata", "encrypted_source");
  requireField("lifebooks.metadata", "deferred_source");
  const requireOperationalDependency = (
    table,
    column,
    jsonPath,
    targetResolution,
  ) => {
    const entry = inventoryTables.get(table);
    const group = entry?.groups?.find((candidate) =>
      candidate.columns?.includes(column),
    );
    const dependency = group?.operationalDependencies?.find(
      (candidate) => candidate.jsonPath === jsonPath,
    );
    if (dependency?.targetResolution !== targetResolution) {
      errors.push(
        `${table}.${column}: critical operational dependency ${jsonPath} must retain its reviewed target resolution`,
      );
    }
  };
  requireOperationalDependency(
    "brain_pages",
    "metadata",
    "metadata.authoringTier",
    "Project to a typed locally_exposed_metadata column before encrypting metadata; disclose that authoring tier remains readable.",
  );
  requireOperationalDependency(
    "brain_pages",
    "metadata",
    "metadata.fromAddress",
    "Replace plaintext equality with a versioned, purpose-keyed HMAC lookup entry; source address remains only in the encrypted metadata envelope.",
  );
  requireOperationalDependency(
    "brain_pages",
    "metadata",
    "metadata.userOverride",
    "Project to a typed locally_exposed_metadata column before encrypting metadata; disclose that pin/hide state remains readable.",
  );
  requireOperationalDependency(
    "lifebooks",
    "metadata",
    "metadata.importanceOverride.{value,setAt,decayDays}",
    "Require unlock, decrypt the bounded per-user lifebook set, and compute effective importance in the authorized process before metadata encryption is enforced.",
  );
  const criticalBoundaries = [
    ["oauth_tokens", "user", "user_broker_gateway"],
    ["credential_requirements", "installation", "installation_broker_gateway"],
    ["ironclaw_tools", "installation", "installation_broker_gateway"],
    ["service_credentials", "installation", "installation_broker_gateway"],
    ["worker_dead_letter", "system_global", "content_free_global"],
    [
      "worker_generation_authority",
      "installation",
      "locally_exposed_or_excluded",
    ],
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
