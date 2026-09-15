#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_CI_EVIDENCE_CHECKS,
  CANONICAL_CI_EVIDENCE_COMMANDS,
  RELEASE_CLAIM_CI_RESULT_PATH,
  RELEASE_CLAIM_CI_SOURCE_PATHS,
} from "./release-constants.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUNTIME_ENV = Object.freeze({
  nodePath: "SKYTWIN_RELEASE_CI_NODE_PATH",
  nodeSha256: "SKYTWIN_RELEASE_CI_NODE_SHA256",
  pnpmEntryPath: "SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH",
  pnpmEntrySha256: "SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256",
});
const GIT = "/usr/bin/git";
const NULL_DEVICE = "/dev/null";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVED_CODE_UNITS = 4096;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_BLOB_MODES = new Set(["100644", "100755", "120000"]);
const SOURCE_CHECK_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});
const SOURCE_CHECK_GIT_ARGS = Object.freeze([
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  `core.attributesFile=${NULL_DEVICE}`,
  "-c",
  `core.excludesFile=${NULL_DEVICE}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.untrackedCache=false",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactUniqueStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function containedRegularFile(root, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path))
    throw new Error(`release claim source path must be relative: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new Error(`release claim source escapes repository: ${path}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error(`release claim source is not a regular file: ${path}`);
  if (realpathSync(absolute) !== absolute)
    throw new Error(`release claim source traverses a symlink: ${path}`);
  return absolute;
}

function canonicalRuntimeFile(path, expectedSha256, name, { executable } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !/^[A-Za-z0-9_./+@-]+$/u.test(path) ||
    !SHA256_PATTERN.test(expectedSha256 ?? "")
  )
    throw new Error(`${name} runtime identity is invalid`);
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (executable) accessSync(canonical, fsConstants.X_OK);
  if (
    canonical !== path ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    sha256(readFileSync(canonical)) !== expectedSha256
  )
    throw new Error(`${name} runtime identity changed after capture`);
  return canonical;
}

function releaseRuntime(env) {
  const runtime = Object.fromEntries(
    Object.entries(RUNTIME_ENV).map(([key, name]) => [key, env[name]]),
  );
  canonicalRuntimeFile(runtime.nodePath, runtime.nodeSha256, "node", {
    executable: true,
  });
  canonicalRuntimeFile(
    runtime.pnpmEntryPath,
    runtime.pnpmEntrySha256,
    "pnpm entry",
  );
  if (realpathSync(process.execPath) !== runtime.nodePath)
    throw new Error("harness is not running under the captured node runtime");
  return runtime;
}

function gitResult(root, args, description, { encoding = "utf8", input } = {}) {
  const result = spawnSync(GIT, [...SOURCE_CHECK_GIT_ARGS, ...args], {
    cwd: root,
    env: SOURCE_CHECK_ENV,
    shell: false,
    encoding,
    input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${description} failed${result.error ? `: ${result.error.message}` : ""}`,
    );
  return result.stdout;
}

function gitOutput(root, args, description) {
  return gitResult(root, args, description);
}

function gitBytes(root, args, description, input) {
  return gitResult(root, args, description, { encoding: null, input });
}

function decodeGitPath(bytes, description) {
  const path = bytes.toString("utf8");
  if (
    path.length === 0 ||
    !Buffer.from(path, "utf8").equals(bytes) ||
    isAbsolute(path) ||
    path
      .split("/")
      .some(
        (component) =>
          component.length === 0 || component === "." || component === "..",
      )
  )
    throw new Error(`${description} contains an unsafe path`);
  return path;
}

function nullTerminatedRecords(bytes, description) {
  const records = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw new Error(`${description} is not NUL terminated`);
    records.push(bytes.subarray(offset, end));
    offset = end + 1;
  }
  return records;
}

function expectedBlobDigests(root, entries) {
  const output = gitBytes(
    root,
    ["cat-file", "--batch"],
    "release claim source object read",
    `${entries.map((entry) => entry.object).join("\n")}\n`,
  );
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0)
      throw new Error("release claim source object output is incomplete");
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = header.match(/^([a-f0-9]{40}) blob ([0-9]+)$/u);
    if (!match || match[1] !== entry.object)
      throw new Error("release claim source object identity is invalid");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("release claim source object size is invalid");
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd >= output.length || output[bodyEnd] !== 10)
      throw new Error("release claim source object body is incomplete");
    const objectIdentity = createHash("sha1")
      .update(`blob ${size}\0`)
      .update(output.subarray(bodyStart, bodyEnd))
      .digest("hex");
    if (objectIdentity !== entry.object)
      throw new Error("release claim source object content is invalid");
    entry.size = size;
    entry.sha256 = sha256(output.subarray(bodyStart, bodyEnd));
    offset = bodyEnd + 1;
  }
  if (offset !== output.length)
    throw new Error("release claim source object output has trailing bytes");
}

function captureSourceSnapshot(root, sourceCommit) {
  const head = gitOutput(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "release claim source identity check",
  ).trim();
  if (head !== sourceCommit)
    throw new Error("release claim source HEAD is not the triggering commit");

  const tree = gitBytes(
    root,
    ["ls-tree", "-rz", "--full-tree", sourceCommit],
    "release claim source tree inventory",
  );
  const entries = nullTerminatedRecords(
    tree,
    "release claim source tree inventory",
  ).map((record) => {
    const tab = record.indexOf(9);
    const header = tab < 0 ? "" : record.subarray(0, tab).toString("ascii");
    const match = header.match(/^([0-7]{6}) ([a-z]+) ([a-f0-9]{40})$/u);
    if (
      !match ||
      match[2] !== "blob" ||
      !CANONICAL_BLOB_MODES.has(match[1]) ||
      !GIT_OBJECT_PATTERN.test(match[3])
    )
      throw new Error(
        "release claim source tree contains an unsupported entry",
      );
    return {
      mode: match[1],
      object: match[3],
      path: decodeGitPath(
        record.subarray(tab + 1),
        "release claim source tree",
      ),
    };
  });
  if (
    entries.length === 0 ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  )
    throw new Error(
      "release claim source tree inventory is empty or ambiguous",
    );
  expectedBlobDigests(root, entries);
  return Object.freeze({
    sourceCommit,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    byPath: new Map(entries.map((entry) => [entry.path, entry])),
  });
}

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"].every(
    (field) => left[field] === right[field],
  );
}

function assertNoSymlinkParents(root, absolute, description) {
  const rel = relative(root, absolute);
  let current = root;
  const components = rel.split(sep);
  for (const component of components.slice(0, -1)) {
    current = resolve(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`${description} traverses a symlink or non-directory`);
  }
}

function observeRegularFile(root, absolute, description) {
  assertNoSymlinkParents(root, absolute, description);
  const beforePath = lstatSync(absolute, { bigint: true });
  if (
    !beforePath.isFile() ||
    beforePath.isSymbolicLink() ||
    beforePath.nlink !== 1n
  )
    throw new Error(`${description} is not a single-link regular file`);
  const descriptor = openSync(
    absolute,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameFileIdentity(before, beforePath))
      throw new Error(`${description} changed before inspection`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position);
      if (count === 0) break;
      position += count;
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(absolute, { bigint: true });
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, afterPath) ||
      BigInt(position) !== after.size
    )
      throw new Error(`${description} changed during inspection`);
    return {
      size: position,
      sha256: digest.digest("hex"),
      executable: (after.mode & 0o111n) !== 0n,
    };
  } finally {
    closeSync(descriptor);
  }
}

function observeSymlink(root, absolute, description) {
  assertNoSymlinkParents(root, absolute, description);
  const before = lstatSync(absolute, { bigint: true });
  if (!before.isSymbolicLink() || before.nlink !== 1n)
    throw new Error(`${description} is not a single-link symbolic link`);
  const target = readlinkSync(absolute, { encoding: "buffer" });
  const after = lstatSync(absolute, { bigint: true });
  if (!sameFileIdentity(before, after))
    throw new Error(`${description} changed during inspection`);
  return { size: target.length, sha256: sha256(target), executable: false };
}

function parseIndexEntries(bytes) {
  return nullTerminatedRecords(bytes, "release claim index inventory").map(
    (record) => {
      const tab = record.indexOf(9);
      const header = tab < 0 ? "" : record.subarray(0, tab).toString("ascii");
      const match = header.match(/^([0-7]{6}) ([a-f0-9]{40}) ([0-3])$/u);
      if (!match) throw new Error("release claim index inventory is malformed");
      return {
        mode: match[1],
        object: match[2],
        stage: match[3],
        path: decodeGitPath(record.subarray(tab + 1), "release claim index"),
      };
    },
  );
}

function assertCanonicalIndex(root, snapshot) {
  const indexEntries = parseIndexEntries(
    gitBytes(
      root,
      ["ls-files", "--stage", "-z"],
      "release claim index inventory",
    ),
  );
  const expected = snapshot.entries.map(({ mode, object, path }) => ({
    mode,
    object,
    stage: "0",
    path,
  }));
  if (JSON.stringify(indexEntries) !== JSON.stringify(expected))
    throw new Error("release claim index differs from the triggering commit");

  const flags = nullTerminatedRecords(
    gitBytes(root, ["ls-files", "-v", "-z"], "release claim index flags"),
    "release claim index flags",
  );
  if (flags.length !== snapshot.entries.length)
    throw new Error("release claim index flags are incomplete");
  for (let index = 0; index < flags.length; index += 1) {
    const record = flags[index];
    if (record.length < 3 || record[1] !== 32)
      throw new Error("release claim index flags are malformed");
    const flag = String.fromCharCode(record[0]);
    const path = decodeGitPath(record.subarray(2), "release claim index flags");
    if (
      path !== snapshot.entries[index].path ||
      flag === "S" ||
      flag.toLowerCase() === flag
    )
      throw new Error(
        "release claim index uses skip-worktree or assume-unchanged state",
      );
  }
}

function assertExactTaggedSource(root, sourceCommit, snapshot) {
  const head = gitOutput(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "release claim source identity check",
  ).trim();
  if (head !== sourceCommit || snapshot.sourceCommit !== sourceCommit)
    throw new Error("release claim source HEAD is not the triggering commit");
  assertCanonicalIndex(root, snapshot);

  for (const entry of snapshot.entries) {
    const absolute = resolve(root, entry.path);
    const rel = relative(root, absolute);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("release claim source path escapes the repository");
    let observed;
    try {
      observed =
        entry.mode === "120000"
          ? observeSymlink(root, absolute, `release claim source ${entry.path}`)
          : observeRegularFile(
              root,
              absolute,
              `release claim source ${entry.path}`,
            );
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT")
        throw new Error(
          "release claim source tree changed while checks were running",
        );
      throw error;
    }
    if (
      observed.size !== entry.size ||
      observed.sha256 !== entry.sha256 ||
      observed.executable !== (entry.mode === "100755")
    )
      throw new Error(
        "release claim source tree changed while checks were running",
      );
  }

  const untracked = gitBytes(
    root,
    ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"],
    "release claim untracked source inventory",
  );
  if (untracked.length !== 0)
    throw new Error(
      "release claim source tree changed while checks were running",
    );
}

export function releaseClaimCommandEnvironment(runtime) {
  return Object.freeze({
    PATH: [dirname(runtime.nodePath), "/usr/bin", "/bin"].join(delimiter),
    CI: "true",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  });
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? "")))
    throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${name} must be a safe positive integer`);
  return parsed;
}

function releaseContext(env) {
  const repository = env.GITHUB_REPOSITORY;
  const sourceCommit = env.GITHUB_SHA;
  const ref = env.GITHUB_REF;
  const event = env.GITHUB_EVENT_NAME;
  if (!REPOSITORY_PATTERN.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY must be an owner/repository identifier");
  if (!COMMIT_PATTERN.test(sourceCommit ?? ""))
    throw new Error("GITHUB_SHA must be a lowercase 40-character commit SHA");
  if (typeof ref !== "string" || !ref.startsWith("refs/"))
    throw new Error("GITHUB_REF must be an actual refs/* workflow ref");
  if (typeof event !== "string" || event.length === 0)
    throw new Error("GITHUB_EVENT_NAME is required");
  return {
    repository,
    sourceCommit,
    ref,
    event,
    runId: parsePositiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    runAttempt: parsePositiveInteger(
      env.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
  };
}

function defaultExecute({ executable, args, root, runtime }) {
  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn(executable, args, {
      cwd: root,
      env: releaseClaimCommandEnvironment(runtime),
      shell: false,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolveResult({ exitCode: null, error: error.message });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: Number.isInteger(code) ? code : null,
        error: signal ? `terminated by ${signal}` : null,
      });
    });
  });
}

export function validateReleaseClaimCiResult(report) {
  const errors = [];
  if (!isRecord(report)) return ["result must be an object"];
  if (report.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (report.generatedBy !== "release-claim-ci-harness")
    errors.push("generatedBy must identify the canonical harness");
  if (!REPOSITORY_PATTERN.test(report.repository ?? ""))
    errors.push("repository is invalid");
  if (!COMMIT_PATTERN.test(report.sourceCommit ?? ""))
    errors.push("sourceCommit is invalid");
  if (typeof report.ref !== "string" || !report.ref.startsWith("refs/"))
    errors.push("ref is invalid");
  if (typeof report.event !== "string" || report.event.length === 0)
    errors.push("event is invalid");
  if (!Number.isSafeInteger(report.runId) || report.runId < 1)
    errors.push("runId is invalid");
  if (!Number.isSafeInteger(report.runAttempt) || report.runAttempt < 1)
    errors.push("runAttempt is invalid");
  const runtime = report.runtime;
  if (
    !isRecord(runtime) ||
    typeof runtime.nodePath !== "string" ||
    !isAbsolute(runtime.nodePath) ||
    !SHA256_PATTERN.test(runtime.nodeSha256 ?? "") ||
    typeof runtime.pnpmEntryPath !== "string" ||
    !isAbsolute(runtime.pnpmEntryPath) ||
    !SHA256_PATTERN.test(runtime.pnpmEntrySha256 ?? "")
  )
    errors.push(
      "runtime must contain canonical absolute node and pnpm identities",
    );
  const expectedSources = RELEASE_CLAIM_CI_SOURCE_PATHS;
  const sourcePaths = Array.isArray(report.sourceDigests)
    ? report.sourceDigests.map((entry) => entry?.path)
    : [];
  if (!exactUniqueStrings(sourcePaths, expectedSources))
    errors.push("sourceDigests must contain the exact canonical sources once");
  if (
    !Array.isArray(report.sourceDigests) ||
    report.sourceDigests.some(
      (entry) => !isRecord(entry) || !SHA256_PATTERN.test(entry.sha256 ?? ""),
    )
  )
    errors.push("sourceDigests must contain SHA-256 values");

  const canonicalClaimIds = [...CANONICAL_CI_EVIDENCE_CHECKS.keys()];
  const claims = Array.isArray(report.claims) ? report.claims : [];
  if (
    !exactUniqueStrings(
      claims.map((claim) => claim?.claimId),
      canonicalClaimIds,
    )
  )
    errors.push("claims must contain each canonical CI claim exactly once");
  for (const [claimId, expectedCheckIds] of CANONICAL_CI_EVIDENCE_CHECKS) {
    const claim = claims.find((entry) => entry?.claimId === claimId);
    const checks = Array.isArray(claim?.checks) ? claim.checks : [];
    if (
      !exactUniqueStrings(
        checks.map((check) => check?.id),
        expectedCheckIds,
      )
    ) {
      errors.push(`${claimId} must contain each canonical check exactly once`);
      continue;
    }
    for (const check of checks) {
      const command = CANONICAL_CI_EVIDENCE_COMMANDS.get(check.id);
      if (
        check.testId !== check.id ||
        !isRecord(check.command) ||
        check.command.executable !== runtime?.nodePath ||
        JSON.stringify(check.command.args) !==
          JSON.stringify([runtime?.pnpmEntryPath, ...(command?.args ?? [])]) ||
        !["pass", "fail"].includes(check.result) ||
        !(Number.isInteger(check.exitCode) || check.exitCode === null) ||
        check.result !== (check.exitCode === 0 ? "pass" : "fail") ||
        typeof check.observed !== "string" ||
        check.observed.length === 0 ||
        check.observed.length > MAX_OBSERVED_CODE_UNITS
      )
        errors.push(
          `${claimId}/${check.id} is not a canonical observed result`,
        );
    }
  }
  const allPassed = claims.every(
    (claim) =>
      Array.isArray(claim?.checks) &&
      claim.checks.every((check) => check?.result === "pass"),
  );
  if (report.result !== (allPassed ? "pass" : "fail"))
    errors.push("top-level result must equal the aggregate check result");
  return errors;
}

export async function runReleaseClaimCi({
  root = process.cwd(),
  env = process.env,
  execute = defaultExecute,
  outputPath = RELEASE_CLAIM_CI_RESULT_PATH,
} = {}) {
  root = realpathSync(resolve(root));
  if (outputPath !== RELEASE_CLAIM_CI_RESULT_PATH)
    throw new Error(`output must be ${RELEASE_CLAIM_CI_RESULT_PATH}`);
  const context = releaseContext(env);
  const runtime = releaseRuntime(env);
  const sourceSnapshot = captureSourceSnapshot(root, context.sourceCommit);
  assertExactTaggedSource(root, context.sourceCommit, sourceSnapshot);
  const canonicalCheckIds = [...CANONICAL_CI_EVIDENCE_CHECKS.values()].flat();
  if (
    new Set(canonicalCheckIds).size !== canonicalCheckIds.length ||
    !exactUniqueStrings(
      [...CANONICAL_CI_EVIDENCE_COMMANDS.keys()],
      canonicalCheckIds,
    )
  )
    throw new Error(
      "canonical release claim checks and frozen commands must match exactly",
    );
  const sourceDigests = RELEASE_CLAIM_CI_SOURCE_PATHS.map((path) => {
    const entry = sourceSnapshot.byPath.get(path);
    if (!entry || !["100644", "100755"].includes(entry.mode))
      throw new Error(`release claim source is not tracked at HEAD: ${path}`);
    containedRegularFile(root, path);
    return { path, sha256: entry.sha256 };
  });
  const observed = new Map();
  for (const [id, command] of CANONICAL_CI_EVIDENCE_COMMANDS) {
    assertExactTaggedSource(root, context.sourceCommit, sourceSnapshot);
    releaseRuntime(env);
    let result;
    try {
      result = await execute({
        id,
        executable: runtime.nodePath,
        args: [runtime.pnpmEntryPath, ...command.args],
        root,
        runtime,
      });
    } catch (error) {
      result = {
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    releaseRuntime(env);
    assertExactTaggedSource(root, context.sourceCommit, sourceSnapshot);
    const exitCode = Number.isInteger(result?.exitCode)
      ? result.exitCode
      : null;
    const observedText =
      exitCode === 0
        ? "Canonical command exited with code 0"
        : result?.error
          ? `Canonical command did not pass: ${result.error}`
          : `Canonical command exited with code ${String(exitCode)}`;
    observed.set(id, {
      id,
      testId: id,
      command: {
        executable: runtime.nodePath,
        args: [runtime.pnpmEntryPath, ...command.args],
      },
      result: exitCode === 0 ? "pass" : "fail",
      exitCode,
      observed: observedText.slice(0, MAX_OBSERVED_CODE_UNITS),
    });
  }
  const claims = [...CANONICAL_CI_EVIDENCE_CHECKS].map(
    ([claimId, checkIds]) => ({
      claimId,
      checks: checkIds.map((id) => observed.get(id)),
    }),
  );
  const finalSourceDigests = RELEASE_CLAIM_CI_SOURCE_PATHS.map((path) => {
    const entry = sourceSnapshot.byPath.get(path);
    containedRegularFile(root, path);
    return { path, sha256: entry.sha256 };
  });
  if (JSON.stringify(finalSourceDigests) !== JSON.stringify(sourceDigests))
    throw new Error(
      "release claim CI sources changed while checks were running",
    );
  releaseRuntime(env);
  assertExactTaggedSource(root, context.sourceCommit, sourceSnapshot);
  const report = {
    schemaVersion: 1,
    generatedBy: "release-claim-ci-harness",
    result: [...observed.values()].every((check) => check.result === "pass")
      ? "pass"
      : "fail",
    ...context,
    runtime,
    sourceDigests,
    claims,
  };
  const validationErrors = validateReleaseClaimCiResult(report);
  if (validationErrors.length > 0)
    throw new Error(
      `invalid release claim CI result: ${validationErrors.join("; ")}`,
    );

  const absoluteOutput = resolve(root, outputPath);
  const outputDirectory = dirname(absoluteOutput);
  let currentDirectory = root;
  for (const component of relative(root, outputDirectory).split(sep)) {
    currentDirectory = resolve(currentDirectory, component);
    if (!existsSync(currentDirectory)) {
      try {
        mkdirSync(currentDirectory, { mode: 0o700 });
      } catch (error) {
        if (!existsSync(currentDirectory)) throw error;
      }
    }
    const stat = lstatSync(currentDirectory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(currentDirectory) !== currentDirectory
    )
      throw new Error("release claim CI output directory is unsafe");
  }
  // The runner and every canonical child share one OS principal. Exclusive
  // creation and component checks close all synchronous in-process path/link
  // mutations; branch protection and the isolated hosted runner are the trust
  // boundary for a deliberately detached same-principal process. The release
  // consumer independently binds the uploaded artifact and report digests.
  writeFileSync(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return report;
}

function outputArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--output")
    throw new Error(
      `usage: run-release-claim-ci.mjs --output ${RELEASE_CLAIM_CI_RESULT_PATH}`,
    );
  return argv[1];
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = await runReleaseClaimCi({
    outputPath: outputArgument(process.argv.slice(2)),
  });
  if (report.result !== "pass") process.exitCode = 1;
}
