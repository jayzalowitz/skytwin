#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  machineProducerJobName,
  machineVerifierCommand,
  machineVerifierPath,
} from "../release-constants.mjs";
import {
  deriveExecutable,
  selectDownloadedSubject,
  stopProcessTree,
} from "./sample.packaged-account-free.mjs";

export const CLAIM_ID = "storage.desktop-crdb";
export const CHECK_IDS = Object.freeze(["storage.packaged-crdb-persistence"]);

const PLATFORM = "macos";
const ARTIFACT_NAME = "SkyTwin-macOS-zip";
const ARTIFACT_KIND = "desktop-archive";
const ARTIFACT_CONFIG = Object.freeze({
  artifactName: ARTIFACT_NAME,
  subjectSuffix: ".zip",
});
const EXPECTED_ARTIFACT_NAMES = Object.freeze([
  "SkyTwin-macOS-dmg",
  ARTIFACT_NAME,
]);
const SQL_PORT = 26257;
const HTTP_PORT = 26258;
const API_PORT = 3100;
const WEB_PORT = 3200;
const USER_DATA_RELATIVE_PATH = "electron";
const STORE_RELATIVE_PATH = `${USER_DATA_RELATIVE_PATH}/crdb-data`;
const RUNTIME_RELATIVE_PATH = `${USER_DATA_RELATIVE_PATH}/crdb-runtime`;
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function inspectRegularFile(path, description) {
  const requested = resolve(path);
  const pathStat = lstatSync(requested);
  assert(
    pathStat.isFile() && !pathStat.isSymbolicLink(),
    `${description} must be a direct regular non-symlink file`,
  );
  assert(
    pathStat.nlink === 1,
    `${description} must have exactly one hard link`,
  );
  assert(
    pathStat.size > 0 && pathStat.size <= MAX_FILE_BYTES,
    `${description} size is outside the release bound`,
  );
  const canonical = realpathSync(requested);
  const descriptor = openSync(
    requested,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    assert(
      before.isFile() && before.nlink === 1,
      `${description} descriptor is not a private regular file`,
    );
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assert(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      `${description} changed while it was inspected`,
    );
    return {
      path: canonical,
      name: basename(canonical),
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}

function inspectExecutable(path, description) {
  const file = inspectRegularFile(path, description);
  assert((file.mode & 0o111) !== 0, `${description} is not executable`);
  return file;
}

function sameFileIdentity(left, right) {
  return ["sizeBytes", "sha256", "device", "inode"].every(
    (field) => left[field] === right[field],
  );
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  assert(value && pattern.test(value), `${name} is missing or malformed`);
  return value;
}

function positiveInteger(name) {
  const raw = requiredEnvironment(name, /^\d+$/u);
  const value = Number(raw);
  assert(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
  return value;
}

function validateCommit(commit) {
  assert(COMMIT.test(commit), "source commit must be a full lowercase Git SHA");
  const options = { encoding: "utf8", maxBuffer: MAX_COMMAND_OUTPUT_BYTES };
  const head = execFileSync(
    "/usr/bin/git",
    ["rev-parse", "HEAD"],
    options,
  ).trim();
  assert(
    head === commit,
    `source commit ${commit} does not match checked-out HEAD ${head}`,
  );
  execFileSync(
    "/usr/bin/git",
    ["diff", "--quiet", "--ignore-submodules", "HEAD", "--"],
    options,
  );
  execFileSync(
    "/usr/bin/git",
    ["diff", "--cached", "--quiet", "--ignore-submodules", "HEAD", "--"],
    options,
  );
}

export function parseCanonicalArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--platform" ||
    argv[1] !== PLATFORM ||
    argv[2] !== "--output" ||
    argv[3] !== `.release-evidence/reports/${CLAIM_ID}.json`
  ) {
    throw new Error(
      `arguments must be exactly --platform ${PLATFORM} --output .release-evidence/reports/${CLAIM_ID}.json`,
    );
  }
  return { platform: PLATFORM, output: argv[3] };
}

export function parseArtifactBindings(raw, valuePattern, description) {
  assert(
    typeof raw === "string" && raw.length > 0,
    `${description} is missing`,
  );
  const values = new Map();
  for (const item of raw.split(",")) {
    const separator = item.indexOf("=");
    assert(
      separator > 0 && separator === item.lastIndexOf("="),
      `${description} entry is malformed`,
    );
    const name = item.slice(0, separator);
    const value = item.slice(separator + 1);
    assert(
      EXPECTED_ARTIFACT_NAMES.includes(name),
      `${description} contains unexpected artifact ${name}`,
    );
    assert(
      !values.has(name),
      `${description} contains duplicate artifact ${name}`,
    );
    assert(
      valuePattern.test(value),
      `${description} has malformed value for ${name}`,
    );
    values.set(name, value);
  }
  assert(
    values.size === EXPECTED_ARTIFACT_NAMES.length &&
      EXPECTED_ARTIFACT_NAMES.every((name) => values.has(name)),
    `${description} must contain the exact macOS artifact set`,
  );
  return values;
}

export function makeStorageLaunch(executablePath, profileRoot, nonce) {
  const userDataPath = join(profileRoot, USER_DATA_RELATIVE_PATH);
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    APPDATA: join(profileRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(profileRoot, "AppData", "Local"),
    XDG_CONFIG_HOME: join(profileRoot, "config"),
    XDG_DATA_HOME: join(profileRoot, "data"),
    XDG_CACHE_HOME: join(profileRoot, "cache"),
    TMPDIR: join(profileRoot, "tmp"),
    TEMP: join(profileRoot, "tmp"),
    TMP: join(profileRoot, "tmp"),
    NODE_ENV: "production",
    SKYTWIN_DEV_AUTH_BYPASS: "false",
    SKYTWIN_RELEASE_EVIDENCE_NONCE: nonce,
  };
  return {
    command: executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    options: {
      cwd: profileRoot,
      env: environment,
      stdio: "ignore",
      detached: true,
    },
  };
}

async function loopbackConnectionIsRefused(port, timeoutMs = 1_000) {
  const { createConnection } = await import("node:net");
  return new Promise((resolveRefused, rejectProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(
      () => finish(rejectProbe, new Error(`TCP connect probe timed out on port ${port}`)),
      timeoutMs,
    );
    socket.once("connect", () => finish(resolveRefused, false));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED") {
        finish(resolveRefused, true);
        return;
      }
      finish(
        rejectProbe,
        new Error(
          `TCP connect probe failed closed on port ${port}: ${error?.code ?? "unknown"}`,
        ),
      );
    });
  });
}

async function exclusiveLoopbackBindSucceeds(port, timeoutMs = 1_000) {
  const { createServer } = await import("node:net");
  const server = createServer();
  return new Promise((resolveUnused, rejectProbe) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => callback(value));
      } else {
        callback(value);
      }
    };
    const timer = setTimeout(
      () => finish(rejectProbe, new Error(`TCP bind probe timed out on port ${port}`)),
      timeoutMs,
    );
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        finish(resolveUnused, false);
        return;
      }
      finish(
        rejectProbe,
        new Error(
          `TCP bind probe failed closed on port ${port}: ${error?.code ?? "unknown"}`,
        ),
      );
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      finish(resolveUnused, true);
    });
  });
}

export function parseLsofListenerInventory(output) {
  const records = [];
  let current = null;
  for (const line of String(output).split(/\r?\n/u)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      if (current) records.push(current);
      assert(/^\d+$/u.test(value), "lsof listener PID is malformed");
      current = { pid: Number(value), command: null, names: [] };
    } else if (field === "c") {
      assert(current, "lsof command preceded its process record");
      current.command = value;
    } else if (field === "n") {
      assert(current, "lsof listener preceded its process record");
      current.names.push(value);
    }
  }
  if (current) records.push(current);
  return records;
}

function lsofReportsNoListeners(port) {
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert(!result.error, `lsof listener probe failed on port ${port}`);
  assert(result.signal === null, `lsof listener probe was signalled on port ${port}`);
  assert(
    result.status === 0 || result.status === 1,
    `lsof listener probe exited ${result.status ?? "without status"} on port ${port}`,
  );
  const output = result.stdout ?? "";
  if (result.status === 1) {
    assert(
      output.trim() === "" && (result.stderr ?? "").trim() === "",
      `lsof listener probe failed closed on port ${port}`,
    );
  }
  return parseLsofListenerInventory(output).length === 0;
}

export async function targetIsUnused(port, probes = {}) {
  const connectRefused =
    probes.connectRefused ?? loopbackConnectionIsRefused;
  const bindSucceeds =
    probes.bindSucceeds ?? exclusiveLoopbackBindSucceeds;
  const noLsofListeners =
    probes.noLsofListeners ?? lsofReportsNoListeners;
  if (!(await connectRefused(port))) return false;
  if (!(await bindSucceeds(port))) return false;
  return await noLsofListeners(port);
}

async function assertPortsUnused(description, probes) {
  for (const port of [SQL_PORT, HTTP_PORT, API_PORT, WEB_PORT]) {
    assert(
      await targetIsUnused(port, probes),
      `${description}: port ${port} was already occupied`,
    );
  }
}

export async function waitForReleasedPorts(options = {}) {
  const ports = options.ports ?? [SQL_PORT, HTTP_PORT, API_PORT, WEB_PORT];
  const deadline = options.deadline ?? Date.now() + 45_000;
  const now = options.now ?? Date.now;
  const probe = options.probe ?? targetIsUnused;
  const delay = options.delay ?? ((milliseconds) =>
    new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  let consecutiveCleanSamples = 0;
  while (now() < deadline) {
    const unused = (
      await Promise.all(ports.map((port) => probe(port)))
    ).every(Boolean);
    consecutiveCleanSamples = unused ? consecutiveCleanSamples + 1 : 0;
    if (consecutiveCleanSamples >= 2) return true;
    await delay(250);
  }
  return false;
}

async function waitForOwnedApi(
  child,
  nonce,
  deadline,
  getSpawnError = () => null,
) {
  let lastError = new Error("packaged API did not become ready");
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `packaged executable exited before readiness (${child.exitCode ?? child.signalCode})`,
      );
    }
    try {
      const response = await fetch("http://127.0.0.1:3100/api/v1/demo/info", {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(5_000, deadline - Date.now())),
        ),
      });
      assert(
        response.status === 200,
        `packaged API returned HTTP ${response.status}`,
      );
      assert(
        (response.headers.get("content-type") ?? "")
          .toLowerCase()
          .includes("application/json"),
        "packaged API returned non-JSON readiness",
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert(
        bytes.length > 0 && bytes.length <= 64 * 1024,
        "packaged API readiness size is outside the release bound",
      );
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (body?.instanceNonce && body.instanceNonce !== nonce)
        throw new Error(
          "packaged API is not owned by the launched release subject",
        );
      if (body?.available === true && body?.instanceNonce === nonce) return;
      lastError = new Error(
        "packaged API readiness did not carry the launch nonce",
      );
    } catch (error) {
      if (
        error?.message ===
        "packaged API is not owned by the launched release subject"
      )
        throw error;
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw lastError;
}

export function parseLsofListeners(output, expectedPort) {
  assert(
    Number.isSafeInteger(expectedPort) && expectedPort > 0,
    "listener port is invalid",
  );
  const records = parseLsofListenerInventory(output);
  assert(
    records.length === 1,
    `expected exactly one listener process on port ${expectedPort}, found ${records.length}`,
  );
  const record = records[0];
  assert(
    Number.isSafeInteger(record.pid) && record.pid > 1,
    "listener PID is invalid",
  );
  assert(
    record.command === "cockroach",
    `listener command was ${record.command ?? "missing"}, expected cockroach`,
  );
  assert(
    record.names.length === 1,
    `listener process exposed ${record.names.length} sockets on port ${expectedPort}`,
  );
  assert(
    record.names[0] === `127.0.0.1:${expectedPort}`,
    `listener was ${record.names[0] ?? "missing"}, expected literal IPv4 loopback`,
  );
  return record;
}

function command(commandPath, args) {
  return execFileSync(commandPath, args, {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listenersFor(port) {
  const output = command("/usr/sbin/lsof", [
    "-nP",
    "-a",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fpcn",
  ]);
  return parseLsofListeners(output, port);
}

export function parsePsRecord(output) {
  const match = String(output)
    .trim()
    .match(/^(\d+)\s+([\s\S]+)$/u);
  assert(match, "ps process record is malformed");
  const parentPid = Number(match[1]);
  assert(
    Number.isSafeInteger(parentPid) && parentPid >= 0,
    "ps parent PID is invalid",
  );
  return { parentPid, command: match[2] };
}

function processRecord(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, "process PID is invalid");
  return parsePsRecord(
    command("/bin/ps", [
      "-ww",
      "-p",
      String(pid),
      "-o",
      "ppid=",
      "-o",
      "command=",
    ]),
  );
}

export function assertDescendsFrom(
  pid,
  ancestorPid,
  parentLookup,
  maxDepth = 64,
) {
  assert(Number.isSafeInteger(pid) && pid > 1, "child PID is invalid");
  assert(
    Number.isSafeInteger(ancestorPid) && ancestorPid > 1,
    "ancestor PID is invalid",
  );
  const seen = new Set();
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (current === ancestorPid) return true;
    assert(!seen.has(current), "process ancestry contains a cycle");
    seen.add(current);
    const parent = parentLookup(current);
    assert(
      Number.isSafeInteger(parent) && parent >= 0,
      "process ancestry returned an invalid parent",
    );
    if (parent <= 1) break;
    current = parent;
  }
  throw new Error(
    `process ${pid} is not a descendant of launched process ${ancestorPid}`,
  );
}

export function validateCockroachCommand(commandLine, expected) {
  const arguments_ = String(commandLine).trim().split(/\s+/u);
  const exactArguments = [
    "start-single-node",
    `--listen-addr=127.0.0.1:${SQL_PORT}`,
    `--http-addr=127.0.0.1:${HTTP_PORT}`,
    `--store=${expected.storePath}`,
  ];
  for (const argument of exactArguments) {
    assert(
      arguments_.includes(argument),
      `CockroachDB command is missing ${argument}`,
    );
  }
  assert(
    arguments_[0] === expected.executablePath,
    "CockroachDB process did not execute the bundled release binary",
  );
  const pidPrefix = `--pid-file=${expected.runtimePath}${sep}`;
  const urlPrefix = `--listening-url-file=${expected.runtimePath}${sep}`;
  assert(
    arguments_.some((argument) => argument.startsWith(pidPrefix)),
    "CockroachDB PID file is outside the user-data runtime directory",
  );
  assert(
    arguments_.some((argument) => argument.startsWith(urlPrefix)),
    "CockroachDB listening URL file is outside the user-data runtime directory",
  );
  assert(
    !/(?:--listen-addr|--http-addr)=(?:0\.0\.0\.0|\*|\[?::\]?)/u.test(
      commandLine,
    ),
    "CockroachDB command contains a wildcard listener",
  );
  return true;
}

function inspectCockroachRuntime(childPid, profileRoot, databaseBinaryPath) {
  const sql = listenersFor(SQL_PORT);
  const http = listenersFor(HTTP_PORT);
  assert(
    sql.pid === http.pid,
    "SQL and HTTP listeners belong to different CockroachDB processes",
  );
  assertDescendsFrom(sql.pid, childPid, (pid) => processRecord(pid).parentPid);
  const process = processRecord(sql.pid);
  const userDataPath = realpathSync(join(profileRoot, USER_DATA_RELATIVE_PATH));
  const storePath = realpathSync(join(profileRoot, STORE_RELATIVE_PATH));
  const runtimePath = realpathSync(join(profileRoot, RUNTIME_RELATIVE_PATH));
  validateCockroachCommand(process.command, {
    executablePath: databaseBinaryPath,
    storePath,
    runtimePath,
  });
  return { pid: sql.pid, userDataPath, storePath, runtimePath };
}

function walkDirectories(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        found.push(path);
        pending.push(path);
      }
    }
  }
  return found;
}

function hasRegularFile(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile() && stat.size > 0) return true;
      if (stat.isDirectory()) pending.push(path);
    }
  }
  return false;
}

export function inspectUserDataStore(profileRoot) {
  const canonicalProfile = realpathSync(profileRoot);
  const userDataRequested = join(canonicalProfile, USER_DATA_RELATIVE_PATH);
  const storeRequested = join(canonicalProfile, STORE_RELATIVE_PATH);
  for (const [path, description] of [
    [userDataRequested, "user-data"],
    [storeRequested, "CockroachDB store"],
  ]) {
    const stat = lstatSync(path);
    assert(
      stat.isDirectory() && !stat.isSymbolicLink(),
      `${description} must be a real directory`,
    );
  }
  const userData = realpathSync(userDataRequested);
  const store = realpathSync(storeRequested);
  assert(
    within(canonicalProfile, userData),
    "user-data directory escapes the isolated profile",
  );
  assert(within(userData, store), "CockroachDB store escapes user-data");
  const stores = walkDirectories(canonicalProfile).filter(
    (path) => basename(path) === "crdb-data",
  );
  assert(
    stores.length === 1 && realpathSync(stores[0]) === store,
    `isolated profile contains ${stores.length} CockroachDB stores`,
  );
  assert(
    hasRegularFile(store),
    "CockroachDB store contains no persisted files",
  );
  const stat = statSync(store);
  return {
    path: store,
    device: stat.dev,
    inode: stat.ino,
    nonEmpty: true,
    unexpectedStoreCount: 0,
  };
}

export function parseMarkerQueryOutput(output, expectedValue) {
  const lines = String(output).trim().split(/\r?\n/u);
  assert(
    lines.length === 2 &&
      lines[0] === "marker_value" &&
      lines[1] === expectedValue,
    "persisted marker query did not return the exact expected value",
  );
  return true;
}

function writeMarker(databaseBinary, markerId, markerValue) {
  const sql = `CREATE TABLE IF NOT EXISTS release_evidence_probe (marker_id STRING PRIMARY KEY, marker_value STRING NOT NULL); UPSERT INTO release_evidence_probe (marker_id, marker_value) VALUES ('${markerId}', '${markerValue}');`;
  command(databaseBinary, [
    "sql",
    "--insecure",
    `--host=127.0.0.1:${SQL_PORT}`,
    "--database=skytwin",
    "--format=csv",
    `--execute=${sql}`,
  ]);
}

function readMarker(databaseBinary, markerId, markerValue) {
  const sql = `SELECT marker_value FROM release_evidence_probe WHERE marker_id = '${markerId}';`;
  return parseMarkerQueryOutput(
    command(databaseBinary, [
      "sql",
      "--insecure",
      `--host=127.0.0.1:${SQL_PORT}`,
      "--database=skytwin",
      "--format=csv",
      `--execute=${sql}`,
    ]),
    markerValue,
  );
}

async function stopOwnedLaunch(child) {
  const termination = await stopProcessTree(child, { timeoutMs: 45_000 });
  const listenersReleased = await waitForReleasedPorts();
  assert(
    termination.requested && !termination.forced,
    "packaged application required forced termination",
  );
  assert(
    listenersReleased,
    "after packaged shutdown: listeners did not remain released",
  );
}

async function launchAndInspect(
  executablePath,
  databaseBinaryPath,
  profileRoot,
  nonce,
) {
  const launch = makeStorageLaunch(executablePath, profileRoot, nonce);
  const child = spawn(launch.command, launch.args, launch.options);
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  try {
    await waitForOwnedApi(child, nonce, Date.now() + 90_000, () => spawnError);
    if (spawnError) throw spawnError;
    assert(
      Number.isSafeInteger(child.pid) && child.pid > 1,
      "packaged application PID is invalid",
    );
    const runtime = inspectCockroachRuntime(
      child.pid,
      profileRoot,
      databaseBinaryPath,
    );
    const store = inspectUserDataStore(profileRoot);
    assert(
      runtime.storePath === store.path,
      "listener process does not use the inspected user-data store",
    );
    return { child, runtime, store };
  } catch (error) {
    await stopOwnedLaunch(child).catch(() => {});
    throw error;
  }
}

function databaseBinaryFor(executablePath) {
  return join(
    dirname(executablePath),
    "..",
    "Resources",
    "cockroach",
    `darwin-${process.arch}`,
    "cockroach",
  );
}

async function probePersistence(executablePath, databaseBinary) {
  await assertPortsUnused("before packaged launch");
  const profileRoot = mkdtempSync(join(tmpdir(), "skytwin-storage-evidence-"));
  for (const directory of [
    join(profileRoot, "AppData", "Roaming"),
    join(profileRoot, "AppData", "Local"),
    join(profileRoot, "config"),
    join(profileRoot, "data"),
    join(profileRoot, "cache"),
    join(profileRoot, "tmp"),
    join(profileRoot, USER_DATA_RELATIVE_PATH),
  ])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const markerId = randomBytes(24).toString("hex");
  const markerValue = randomBytes(32).toString("hex");
  let first = null;
  let second = null;
  let firstStopped = false;
  let secondStopped = false;
  try {
    first = await launchAndInspect(
      executablePath,
      databaseBinary,
      profileRoot,
      randomBytes(32).toString("hex"),
    );
    writeMarker(databaseBinary, markerId, markerValue);
    await stopOwnedLaunch(first.child);
    firstStopped = true;
    second = await launchAndInspect(
      executablePath,
      databaseBinary,
      profileRoot,
      randomBytes(32).toString("hex"),
    );
    assert(
      first.store.path === second.store.path &&
        first.store.device === second.store.device &&
        first.store.inode === second.store.inode,
      "CockroachDB store identity changed across restart",
    );
    readMarker(databaseBinary, markerId, markerValue);
    await stopOwnedLaunch(second.child);
    secondStopped = true;
    return {
      userDataRelativePath: USER_DATA_RELATIVE_PATH,
      storeRelativePath: STORE_RELATIVE_PATH,
      sqlListener: { host: "127.0.0.1", port: SQL_PORT },
      httpListener: { host: "127.0.0.1", port: HTTP_PORT },
      processOwnership: "descendant",
      launchCount: 2,
      markerWriteResult: "pass",
      markerReadAfterRestartResult: "pass",
      markerSha256: sha256(markerValue),
      sameStoreIdentity: true,
      storeNonEmpty: true,
      unexpectedStoreCount: 0,
      gracefulShutdownCount: 2,
      listenersReleased: true,
    };
  } finally {
    if (second && !secondStopped)
      await stopOwnedLaunch(second.child).catch(() => {});
    if (first && !firstStopped)
      await stopOwnedLaunch(first.child).catch(() => {});
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

function runIdentity() {
  assert(
    process.platform === "darwin",
    "storage desktop evidence must run on macOS",
  );
  assert(
    process.arch === "arm64",
    "storage desktop evidence requires the canonical macOS arm64 runner",
  );
  assert(process.env.RUNNER_OS === "macOS", "RUNNER_OS must identify macOS");
  const expectedRunnerArch = process.arch === "arm64" ? "ARM64" : "X64";
  assert(
    process.env.RUNNER_ARCH === expectedRunnerArch,
    "RUNNER_ARCH does not match the native runtime",
  );
  const sourceCommit = requiredEnvironment("GITHUB_SHA", COMMIT);
  const runId = positiveInteger("GITHUB_RUN_ID");
  const repository = requiredEnvironment(
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  const ref = requiredEnvironment("GITHUB_REF", /^refs\/tags\/v[^\s]+$/u);
  const releaseTag = requiredEnvironment("GITHUB_REF_NAME", /^v[^\s]+$/u);
  assert(
    ref === `refs/tags/${releaseTag}`,
    "GITHUB_REF and GITHUB_REF_NAME disagree",
  );
  return { sourceCommit, runId, repository, ref, releaseTag };
}

function writeExclusiveReport(root, outputPath, report) {
  const output = resolve(root, outputPath);
  const reportsRoot = resolve(root, ".release-evidence", "reports");
  assert(
    output === join(reportsRoot, `${CLAIM_ID}.json`),
    "output path is not canonical",
  );
  mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function runCanonicalVerifier(argv = process.argv.slice(2)) {
  const args = parseCanonicalArgs(argv);
  const identity = runIdentity();
  validateCommit(identity.sourceCommit);
  const root = realpathSync(process.cwd());
  const artifactIds = parseArtifactBindings(
    requiredEnvironment("SKYTWIN_RELEASE_ARTIFACT_IDS", /^.+$/u),
    /^\d+$/u,
    "SKYTWIN_RELEASE_ARTIFACT_IDS",
  );
  const artifactDigests = parseArtifactBindings(
    requiredEnvironment("SKYTWIN_RELEASE_ARTIFACT_DIGESTS", /^.+$/u),
    SHA256,
    "SKYTWIN_RELEASE_ARTIFACT_DIGESTS",
  );
  const releaseArtifactId = Number(artifactIds.get(ARTIFACT_NAME));
  assert(
    Number.isSafeInteger(releaseArtifactId) && releaseArtifactId > 0,
    "macOS ZIP artifact ID is invalid",
  );
  const subject = selectDownloadedSubject(root, ARTIFACT_CONFIG);
  const extractionRoot = mkdtempSync(
    join(tmpdir(), "skytwin-storage-artifact-"),
  );
  try {
    const { executablePath, derivationPath } = deriveExecutable(
      PLATFORM,
      subject.path,
      extractionRoot,
    );
    const executable = inspectExecutable(
      executablePath,
      "derived packaged application",
    );
    const databaseBinary = inspectExecutable(
      databaseBinaryFor(executable.path),
      "bundled CockroachDB client",
    );
    const verifierPath = machineVerifierPath(CLAIM_ID);
    const verifierCommand = machineVerifierCommand(CLAIM_ID, PLATFORM);
    assert(
      verifierPath && verifierCommand,
      "canonical storage verifier metadata is unavailable",
    );
    const verifier = inspectRegularFile(
      resolve(root, verifierPath),
      "canonical storage verifier",
    );
    const storageObservation = await probePersistence(
      executable.path,
      databaseBinary.path,
    );
    const subjectAfter = inspectRegularFile(
      subject.path,
      "downloaded macOS ZIP after persistence probe",
    );
    const executableAfter = inspectExecutable(
      executable.path,
      "derived packaged application after persistence probe",
    );
    const databaseBinaryAfter = inspectExecutable(
      databaseBinary.path,
      "bundled CockroachDB client after persistence probe",
    );
    const verifierAfter = inspectRegularFile(
      verifier.path,
      "canonical storage verifier after persistence probe",
    );
    assert(
      sameFileIdentity(subject, subjectAfter),
      "downloaded macOS ZIP changed during persistence probe",
    );
    assert(
      sameFileIdentity(executable, executableAfter),
      "derived packaged application changed during persistence probe",
    );
    assert(
      sameFileIdentity(databaseBinary, databaseBinaryAfter),
      "bundled CockroachDB client changed during persistence probe",
    );
    assert(
      sameFileIdentity(verifier, verifierAfter),
      "canonical storage verifier changed during persistence probe",
    );
    const report = {
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId: CLAIM_ID,
      result: "pass",
      sourceCommit: identity.sourceCommit,
      platform: PLATFORM,
      runnerPlatform: `${process.platform}-${process.arch}`,
      releaseTag: identity.releaseTag,
      runId: identity.runId,
      repository: identity.repository,
      ref: identity.ref,
      releaseArtifactKind: ARTIFACT_KIND,
      releaseArtifactId,
      releaseArtifactName: ARTIFACT_NAME,
      releaseArtifactSha256: artifactDigests.get(ARTIFACT_NAME),
      subjectName: subject.name,
      subjectPath: `artifacts/${ARTIFACT_NAME}/${subject.name}`,
      subjectSha256: subject.sha256,
      producerJobName: machineProducerJobName(CLAIM_ID, PLATFORM),
      verifierPath,
      verifierCommand,
      verifierSha256: verifier.sha256,
      executedBinary: {
        name: executable.name,
        sizeBytes: executable.sizeBytes,
        sha256: executable.sha256,
        device: executable.device,
        inode: executable.inode,
        identityResult: "pass",
        derivationMethod: "zip-ditto",
        derivationPath,
      },
      databaseBinary: {
        name: databaseBinary.name,
        sizeBytes: databaseBinary.sizeBytes,
        sha256: databaseBinary.sha256,
        identityResult: "pass",
        derivationPath: `SkyTwin.app/Contents/Resources/cockroach/darwin-${process.arch}/cockroach`,
      },
      storageObservation,
      checks: CHECK_IDS.map((id) => ({
        id,
        testId: id,
        result: "pass",
        observed: {
          assertion:
            "The exact packaged desktop kept its CockroachDB store under user-data, exposed only loopback listeners, and retained a verifier marker across a graceful restart.",
          measurement:
            "two owned launches; SQL 127.0.0.1:26257; HTTP 127.0.0.1:26258; one contained non-empty store; exact marker read after restart; two graceful shutdowns with listeners released",
          exitCode: 0,
        },
      })),
    };
    writeExclusiveReport(root, args.output, report);
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCanonicalVerifier().catch((error) => {
    console.error(`[${CLAIM_ID}] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
