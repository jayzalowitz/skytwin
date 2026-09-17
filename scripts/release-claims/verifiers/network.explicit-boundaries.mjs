#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
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
  realpathSync,
  rmSync,
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
  probeDashboard,
  selectDownloadedSubject,
  stopProcessTree,
} from "./sample.packaged-account-free.mjs";
import {
  parseArtifactBindings,
  runBoundedCommand,
  targetIsUnused,
} from "./storage.desktop-crdb.mjs";

export const CLAIM_ID = "network.explicit-boundaries";
export const CHECK_IDS = Object.freeze([
  "network.clean-machine-egress-capture",
]);

const PLATFORM = "macos";
const ARTIFACT_NAME = "SkyTwin-macOS-zip";
const ARTIFACT_KIND = "desktop-archive";
const ARTIFACT_CONFIG = Object.freeze({
  artifactName: ARTIFACT_NAME,
  subjectSuffix: ".zip",
});
const DESKTOP_JOB = "Desktop — macOS (DMG + ZIP)";
const PACKAGE_STEP = "Package macOS desktop app";
const UPLOAD_STEP = "Upload macOS ZIP";
const WORKFLOW_PATH = ".github/workflows/build.yml";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SANDBOX_PROFILE =
  '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))';
const MANAGED_PORTS = Object.freeze([26257, 26258, 3100, 3200]);
const MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_NATIVE_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const MAX_API_BYTES = 4 * 1024 * 1024;
const NATIVE_TIMEOUT_MS = 15_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG = /^v[^\s]+$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, description) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${description} must be an object`,
  );
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${description} fields are not canonical`,
  );
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
    pathStat.isFile() && !pathStat.isSymbolicLink() && pathStat.nlink === 1,
    `${description} must be a private regular non-symlink file`,
  );
  assert(
    pathStat.size > 0 && pathStat.size <= MAX_FILE_BYTES,
    `${description} size is outside the release bound`,
  );
  const descriptor = openSync(
    requested,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    assert(
      before.isFile() &&
        before.nlink === 1 &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      `${description} changed while it was inspected`,
    );
    return {
      path: realpathSync(requested),
      name: basename(requested),
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

function requiredEnvironment(env, name, pattern) {
  const value = env[name];
  assert(
    typeof value === "string" && pattern.test(value),
    `${name} is missing or malformed`,
  );
  return value;
}

function positiveInteger(env, name) {
  const value = Number(requiredEnvironment(env, name, /^\d+$/u));
  assert(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
  return value;
}

export function parseCanonicalArgs(argv) {
  const output = `.release-evidence/reports/${CLAIM_ID}.json`;
  assert(
    argv.length === 4 &&
      argv[0] === "--platform" &&
      argv[1] === PLATFORM &&
      argv[2] === "--output" &&
      argv[3] === output,
    `arguments must be exactly --platform ${PLATFORM} --output ${output}`,
  );
  return { platform: PLATFORM, output };
}

export function readRunIdentity(env = process.env, runtime = process) {
  assert(runtime.platform === "darwin", "network evidence must run on macOS");
  assert(runtime.arch === "arm64", "network evidence requires macOS arm64");
  assert(
    env.RUNNER_OS === "macOS" && env.RUNNER_ARCH === "ARM64",
    "runner identity is not canonical macOS arm64",
  );
  assert(
    env.GITHUB_EVENT_NAME === "push",
    "network evidence requires a tag push event",
  );
  const sourceCommit = requiredEnvironment(env, "GITHUB_SHA", COMMIT);
  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY", REPOSITORY);
  const releaseTag = requiredEnvironment(env, "GITHUB_REF_NAME", TAG);
  const ref = requiredEnvironment(env, "GITHUB_REF", /^refs\/tags\/v[^\s]+$/u);
  assert(
    ref === `refs/tags/${releaseTag}`,
    "GITHUB_REF and GITHUB_REF_NAME disagree",
  );
  return {
    sourceCommit,
    repository,
    releaseTag,
    ref,
    runId: positiveInteger(env, "GITHUB_RUN_ID"),
    runAttempt: positiveInteger(env, "GITHUB_RUN_ATTEMPT"),
    token: requiredEnvironment(env, "GITHUB_TOKEN", /^.{20,}$/u),
  };
}

async function responseJson(response, description, maxBytes = MAX_API_BYTES) {
  assert(
    response?.ok === true,
    `${description} returned HTTP ${response?.status ?? "unknown"}`,
  );
  const reader = response.body?.getReader();
  assert(reader, `${description} returned an empty response`);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`${description} response exceeded its bound`);
    }
    chunks.push(value);
  }
  assert(size > 0, `${description} returned an empty response`);
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

async function githubJson(identity, path, fetchImpl) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${identity.repository}${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${identity.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "skytwin-network-boundary-verifier",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  return responseJson(response, `GitHub API ${path}`);
}

function timestamp(value, description) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value),
    `${description} timestamp is malformed`,
  );
  const parsed = Date.parse(value);
  assert(Number.isSafeInteger(parsed), `${description} timestamp is malformed`);
  return parsed;
}

function oneJob(jobs, name, description) {
  const matches = jobs.filter((job) => job?.name === name);
  assert(matches.length === 1, `${description} was not present exactly once`);
  return matches[0];
}

function successfulStep(job, name, description) {
  const matches = Array.isArray(job.steps)
    ? job.steps.filter((step) => step?.name === name)
    : [];
  assert(
    matches.length === 1 &&
      matches[0].status === "completed" &&
      matches[0].conclusion === "success",
    `${description} did not succeed exactly once`,
  );
  return matches[0];
}

export async function resolveRunProvenance(
  identity,
  fetchImpl = globalThis.fetch,
) {
  const run = await githubJson(
    identity,
    `/actions/runs/${identity.runId}`,
    fetchImpl,
  );
  const attempt = await githubJson(
    identity,
    `/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
    fetchImpl,
  );
  for (const [value, description] of [
    [run, "run"],
    [attempt, "attempt"],
  ]) {
    assert(
      value?.id === identity.runId &&
        value?.run_attempt === identity.runAttempt &&
        value?.repository?.full_name === identity.repository &&
        value?.head_sha === identity.sourceCommit &&
        value?.head_branch === identity.releaseTag &&
        value?.event === "push" &&
        value?.path === WORKFLOW_PATH,
      `current workflow ${description} is not the exact canonical tag-push attempt`,
    );
  }
  const runAttemptStartedAt = attempt.run_started_at;
  const attemptStarted = timestamp(
    runAttemptStartedAt,
    "workflow attempt start",
  );
  const page = await githubJson(
    identity,
    `/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=100&page=1`,
    fetchImpl,
  );
  assert(
    Array.isArray(page?.jobs) &&
      Number.isSafeInteger(page.total_count) &&
      page.total_count <= 100 &&
      page.jobs.length === page.total_count,
    "exact-attempt job inventory is malformed or incomplete",
  );
  const desktop = oneJob(page.jobs, DESKTOP_JOB, "macOS artifact producer");
  assert(
    Number.isSafeInteger(desktop.id) &&
      desktop.id > 0 &&
      desktop.run_id === identity.runId &&
      desktop.run_attempt === identity.runAttempt &&
      desktop.head_sha === identity.sourceCommit &&
      desktop.status === "completed" &&
      desktop.conclusion === "success",
    "macOS artifact producer is not successful in the exact attempt",
  );
  successfulStep(desktop, PACKAGE_STEP, "macOS package step");
  const upload = successfulStep(desktop, UPLOAD_STEP, "macOS ZIP upload step");
  const verifierName = machineProducerJobName(CLAIM_ID, PLATFORM);
  const verifier = oneJob(page.jobs, verifierName, "network verifier job");
  assert(
    Number.isSafeInteger(verifier.id) &&
      verifier.id > 0 &&
      verifier.run_id === identity.runId &&
      verifier.run_attempt === identity.runAttempt &&
      verifier.head_sha === identity.sourceCommit &&
      verifier.status === "in_progress" &&
      verifier.conclusion === null,
    "network verifier is not active in the exact attempt",
  );
  const verifierSteps = (verifier.steps ?? []).filter(
    (step) =>
      step?.name === "Run canonical machine verifier" &&
      ["queued", "in_progress"].includes(step.status) &&
      step.conclusion === null,
  );
  assert(
    verifierSteps.length === 1,
    "canonical network verifier step is not active exactly once",
  );
  const desktopStarted = timestamp(desktop.started_at, "desktop job start");
  const uploadStarted = timestamp(upload.started_at, "ZIP upload start");
  const uploadCompleted = timestamp(
    upload.completed_at,
    "ZIP upload completion",
  );
  const desktopCompleted = timestamp(
    desktop.completed_at,
    "desktop job completion",
  );
  assert(
    attemptStarted <= desktopStarted &&
      desktopStarted <= uploadStarted &&
      uploadStarted <= uploadCompleted &&
      uploadCompleted <= desktopCompleted,
    "macOS ZIP producer timing is outside the exact attempt",
  );
  return {
    runAttemptStartedAt,
    desktopProducerJobId: desktop.id,
    desktopProducerJobName: desktop.name,
    desktopProducerJobRunAttempt: desktop.run_attempt,
    desktopProducerJobConclusion: desktop.conclusion,
    desktopProducerJobStartedAt: desktop.started_at,
    desktopProducerJobCompletedAt: desktop.completed_at,
    desktopUploadStartedAt: upload.started_at,
    desktopUploadCompletedAt: upload.completed_at,
    verifierJobId: verifier.id,
    verifierJobName: verifier.name,
    verifierJobRunAttempt: verifier.run_attempt,
    verifierJobStatus: verifier.status,
    artifactWindow: { uploadStarted, desktopCompleted },
  };
}

export async function resolveReleaseArtifact(
  identity,
  expectedId,
  expectedDigest,
  provenance,
  fetchImpl = globalThis.fetch,
) {
  const page = await githubJson(
    identity,
    `/actions/runs/${identity.runId}/artifacts?per_page=100&page=1`,
    fetchImpl,
  );
  assert(
    Array.isArray(page?.artifacts) &&
      Number.isSafeInteger(page.total_count) &&
      page.total_count <= 100 &&
      page.artifacts.length === page.total_count,
    "artifact inventory is malformed or incomplete",
  );
  const matches = page.artifacts.filter(
    (artifact) => artifact?.id === expectedId,
  );
  assert(
    matches.length === 1,
    "macOS ZIP artifact ID is not unique in the current run",
  );
  const artifact = matches[0];
  const digest = String(artifact.digest ?? "").replace(/^sha256:/u, "");
  assert(
    artifact.name === ARTIFACT_NAME &&
      artifact.expired === false &&
      digest === expectedDigest &&
      SHA256.test(digest) &&
      artifact.workflow_run?.id === identity.runId &&
      artifact.workflow_run?.head_sha === identity.sourceCommit,
    "macOS ZIP artifact identity is invalid",
  );
  const detail = await githubJson(
    identity,
    `/actions/artifacts/${expectedId}`,
    fetchImpl,
  );
  assert(
    detail.id === artifact.id &&
      detail.name === artifact.name &&
      detail.expired === false &&
      detail.digest === `sha256:${digest}` &&
      detail.workflow_run?.id === identity.runId &&
      detail.workflow_run?.head_sha === identity.sourceCommit &&
      detail.created_at === artifact.created_at,
    "macOS ZIP artifact detail disagrees with its inventory identity",
  );
  const created = timestamp(artifact.created_at, "macOS ZIP artifact creation");
  assert(
    created >= provenance.artifactWindow.uploadStarted &&
      created <= provenance.artifactWindow.desktopCompleted,
    "macOS ZIP artifact was not created inside the exact producer window",
  );
  return {
    id: artifact.id,
    digest,
    createdAt: artifact.created_at,
    attemptBindingResult: "workflow-output-and-producer-window-pass",
  };
}

export function makeClosedEnvironment(profileRoot, nonce) {
  return Object.freeze({
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
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  });
}

export function makeSandboxedLaunch(executablePath, profileRoot, nonce) {
  const userDataPath = join(profileRoot, "electron");
  return {
    command: SANDBOX_EXEC,
    args: [
      "-p",
      SANDBOX_PROFILE,
      executablePath,
      `--user-data-dir=${userDataPath}`,
    ],
    options: {
      cwd: profileRoot,
      env: makeClosedEnvironment(profileRoot, nonce),
      stdio: "ignore",
      detached: true,
    },
  };
}

export function boundedSpawn(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? NATIVE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_NATIVE_OUTPUT_BYTES;
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolveResult, rejectResult) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      if (error) rejectResult(error);
      else resolveResult(result);
    };
    const add = (target, chunk) => {
      const next = Buffer.concat([target, chunk]);
      if (next.length > maxBytes) {
        child.kill("SIGKILL");
        finish(new Error("native command output exceeded its bound"));
      }
      return next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = add(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = add(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null)
        finish(new Error(`native command exited ${code ?? signal}`));
      else
        finish(null, {
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("native command timed out"));
    }, timeoutMs);
  });
}

export function validateSandboxSelfTestResult(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "parentLoopback",
      "parentExternalError",
      "childLoopback",
      "childExternalError",
    ],
    "sandbox self-test result",
  );
  assert(value.schemaVersion === 1, "sandbox self-test schema is invalid");
  assert(
    value.parentLoopback === "pass" &&
      value.childLoopback === "pass" &&
      value.parentExternalError === "EPERM" &&
      value.childExternalError === "EPERM",
    "sandbox self-test did not prove inherited loopback-only networking",
  );
  return true;
}

const SELF_TEST_SOURCE = String.raw`
const { fork } = require("node:child_process");
const { createConnection, createServer } = require("node:net");
function attempt(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve("TIMEOUT"); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("CONNECTED"); });
    socket.once("error", (error) => { clearTimeout(timer); socket.destroy(); resolve(error.code || "UNKNOWN"); });
  });
}
if (process.argv[2] === "child") {
  Promise.all([attempt("127.0.0.1", Number(process.argv[3])), attempt("1.1.1.1", 443)])
    .then(([loopback, external]) => process.send({ loopback, external }))
    .catch(() => process.exit(2));
} else {
  const server = createServer((socket) => socket.end());
  server.listen({ host: "127.0.0.1", port: 0 }, async () => {
    const port = server.address().port;
    const parentLoopback = await attempt("127.0.0.1", port);
    const parentExternal = await attempt("1.1.1.1", 443);
    const child = fork(__filename, ["child", String(port)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child timeout")); }, 5000);
      child.once("message", (value) => { clearTimeout(timer); resolve(value); });
      child.once("error", reject);
      child.once("exit", (code) => { if (code && code !== 0) reject(new Error("child failed")); });
    });
    server.close(() => {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, parentLoopback: parentLoopback === "CONNECTED" ? "pass" : parentLoopback, parentExternalError: parentExternal, childLoopback: result.loopback === "CONNECTED" ? "pass" : result.loopback, childExternalError: result.external }));
    });
  });
}
`;

export async function selfTestSandbox(root, options = {}) {
  const script = join(root, "sandbox-self-test.cjs");
  writeFileSync(script, SELF_TEST_SOURCE, { flag: "wx", mode: 0o600 });
  try {
    const result = await boundedSpawn(
      SANDBOX_EXEC,
      ["-p", SANDBOX_PROFILE, process.execPath, script],
      {
        timeoutMs: options.timeoutMs ?? 15_000,
        maxBytes: 64 * 1024,
        spawnImpl: options.spawnImpl,
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: root,
          TMPDIR: root,
          LANG: "C",
          LC_ALL: "C",
        },
      },
    );
    assert(result.stderr === "", "sandbox self-test wrote diagnostics");
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("sandbox self-test returned invalid JSON");
    }
    validateSandboxSelfTestResult(parsed);
    return {
      profileSha256: sha256(SANDBOX_PROFILE),
      parentLoopbackResult: "pass",
      parentExternalError: "EPERM",
      childLoopbackResult: "pass",
      childExternalError: "EPERM",
      inheritanceResult: "pass",
    };
  } finally {
    rmSync(script, { force: true });
  }
}

export function parseProcessTable(output) {
  const records = new Map();
  for (const line of String(output).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u,
    );
    assert(match, "process inventory is malformed");
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    assert(
      Number.isSafeInteger(pid) &&
        pid > 0 &&
        Number.isSafeInteger(parentPid) &&
        parentPid >= 0 &&
        !records.has(pid),
      "process inventory contains an invalid or duplicate PID",
    );
    records.set(pid, {
      pid,
      parentPid,
      startedAt: match[3],
      command: match[4],
    });
  }
  assert(records.size > 0, "process inventory is empty");
  return records;
}

export function ownedProcessTree(records, rootPid) {
  assert(records.has(rootPid), "launched process exited before inventory");
  const owned = new Set([rootPid]);
  let changed = true;
  for (let pass = 0; changed && pass < records.size; pass += 1) {
    changed = false;
    for (const record of records.values()) {
      if (!owned.has(record.pid) && owned.has(record.parentPid)) {
        owned.add(record.pid);
        changed = true;
      }
    }
  }
  for (const pid of owned) {
    const seen = new Set();
    let current = pid;
    while (current !== rootPid) {
      assert(!seen.has(current), "owned process ancestry contains a cycle");
      seen.add(current);
      const record = records.get(current);
      assert(
        record && owned.has(record.parentPid),
        "owned process ancestry is stale or foreign",
      );
      current = record.parentPid;
    }
  }
  assert(
    !owned.has(records.get(rootPid).parentPid),
    "owned process ancestry contains a cycle through its root",
  );
  return owned;
}

export function parseLsofSockets(output) {
  const sockets = [];
  let processRecord = null;
  let socket = null;
  const finishSocket = () => {
    if (!socket) return;
    assert(
      processRecord && socket.fd && socket.protocol && socket.name,
      "socket inventory contains an incomplete record",
    );
    sockets.push({
      pid: processRecord.pid,
      command: processRecord.command,
      fd: socket.fd,
      protocol: socket.protocol,
      name: socket.name,
      state: socket.state,
    });
    socket = null;
  };
  for (const line of String(output).split(/\r?\n/u)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      finishSocket();
      assert(/^\d+$/u.test(value), "socket PID is malformed");
      processRecord = { pid: Number(value), command: null };
    } else if (field === "c") {
      assert(
        processRecord && !processRecord.command,
        "socket command is misplaced or duplicate",
      );
      processRecord.command = value;
    } else if (field === "f") {
      finishSocket();
      assert(processRecord?.command, "socket file precedes process identity");
      socket = { fd: value, protocol: null, name: null, state: null };
    } else if (field === "P") {
      assert(
        socket && !socket.protocol && ["TCP", "UDP"].includes(value),
        "socket protocol is invalid",
      );
      socket.protocol = value;
    } else if (field === "n") {
      assert(
        socket && !socket.name,
        "socket endpoint is misplaced or duplicate",
      );
      socket.name = value;
    } else if (field === "T") {
      assert(socket, "socket state precedes its file record");
      if (value.startsWith("ST=")) {
        assert(socket.state === null, "socket state is duplicated");
        socket.state = value.slice(3);
      } else {
        assert(
          /^Q[RS]=\d+$/u.test(value),
          "socket transport metadata is malformed",
        );
      }
    } else {
      throw new Error(`socket inventory field ${field} is unexpected`);
    }
  }
  finishSocket();
  return sockets;
}

function endpointPorts(name) {
  const matches = [...String(name).matchAll(/127\.0\.0\.1:(\d+)/gu)];
  return matches.map((match) => Number(match[1]));
}

function localEndpointPort(name) {
  const local = String(name).split("->", 1)[0];
  const match = local.match(/:(\d+)$/u);
  return match ? Number(match[1]) : null;
}

export function validateSocketInventory(
  sockets,
  owned,
  recordsBefore,
  recordsAfter,
) {
  let ownedSocketCount = 0;
  const loopbackPorts = new Set();
  for (const socket of sockets) {
    const isOwned = owned.has(socket.pid);
    const managed = MANAGED_PORTS.includes(localEndpointPort(socket.name));
    if (!isOwned) {
      assert(
        !managed,
        `managed endpoint was observed on foreign process ${socket.pid}`,
      );
      continue;
    }
    const before = recordsBefore.get(socket.pid);
    const after = recordsAfter.get(socket.pid);
    assert(
      before &&
        after &&
        before.startedAt === after.startedAt &&
        before.command === after.command,
      `owned socket process ${socket.pid} exited or was reused during sampling`,
    );
    assert(
      socket.name !== "*:*" &&
        !socket.name.includes("*") &&
        !socket.name.includes("[") &&
        !socket.name.includes("localhost") &&
        /^(?:127\.0\.0\.1:\d+)(?:->127\.0\.0\.1:\d+)?$/u.test(socket.name),
      `owned socket is not literal IPv4 loopback: ${socket.name}`,
    );
    assert(
      socket.protocol === "TCP",
      "owned UDP or multicast socket was observed",
    );
    for (const port of endpointPorts(socket.name)) {
      if (MANAGED_PORTS.includes(port)) loopbackPorts.add(port);
    }
    ownedSocketCount += 1;
  }
  return {
    ownedSocketCount,
    loopbackPorts: [...loopbackPorts].sort((a, b) => a - b),
  };
}

function processInventory() {
  return parseProcessTable(
    runBoundedCommand("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], {
      timeoutMs: 5_000,
    }).stdout ?? "",
  );
}

export function captureOwnedSocketSample(rootPid, options = {}) {
  const inventory = options.processInventory ?? processInventory;
  const socketRunner =
    options.socketRunner ??
    (() =>
      runBoundedCommand("/usr/sbin/lsof", ["-nP", "-i", "-FpcfPnT"], {
        acceptedStatuses: [0, 1],
        timeoutMs: 5_000,
      }));
  const before = inventory();
  const owned = ownedProcessTree(before, rootPid);
  const result = socketRunner();
  assert(
    result.status === 0 ||
      (result.status === 1 &&
        !(result.stdout ?? "").trim() &&
        !(result.stderr ?? "").trim()),
    "socket inventory failed closed",
  );
  const sockets = parseLsofSockets(result.stdout ?? "");
  const after = inventory();
  assert(after.has(rootPid), "launched process exited during socket sampling");
  const observation = validateSocketInventory(sockets, owned, before, after);
  return {
    processCount: owned.size,
    ownedSocketCount: observation.ownedSocketCount,
    loopbackPorts: observation.loopbackPorts,
  };
}

export async function runContinuousSampler(rootPid, work, options = {}) {
  const capture = options.capture ?? captureOwnedSocketSample;
  const delay =
    options.delay ??
    ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  const samples = [];
  let stopped = false;
  let samplerError = null;
  const sampler = (async () => {
    while (!stopped) {
      try {
        samples.push(await capture(rootPid));
      } catch (error) {
        samplerError = error;
        return;
      }
      await delay(250);
    }
  })();
  try {
    const result = await work();
    stopped = true;
    await sampler;
    if (samplerError) throw samplerError;
    assert(
      samples.length >= 3,
      "network scenario produced too few socket samples",
    );
    return { result, samples };
  } catch (error) {
    stopped = true;
    await sampler;
    throw samplerError ?? error;
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers ?? { Accept: "application/json" },
    body: options.body,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  assert(
    response.status === options.status,
    `${options.description} returned HTTP ${response.status}`,
  );
  assert(
    (response.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("application/json"),
    `${options.description} returned non-JSON content`,
  );
  return responseJson(
    response,
    options.description,
    options.maxBytes ?? MAX_HTTP_BYTES,
  );
}

export function validateOwnedReadiness(info, nonce) {
  assert(
    info?.instanceNonce === nonce,
    "API readiness nonce belongs to another process",
  );
  assert(info.available === true, "account-free sample is unavailable");
  return true;
}

async function waitForOwnedApi(child, nonce, deadline, getSpawnError) {
  let last = new Error("owned API did not become ready");
  while (Date.now() < deadline) {
    if (getSpawnError()) throw getSpawnError();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("packaged application exited before readiness");
    try {
      const info = await requestJson("http://127.0.0.1:3100/api/v1/demo/info", {
        status: 200,
        description: "owned API readiness",
        maxBytes: 64 * 1024,
        timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
      });
      validateOwnedReadiness(info, nonce);
      return info;
    } catch (error) {
      if (/nonce belongs/u.test(error?.message ?? "")) throw error;
      last = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw last;
}

export async function probeAccountFreeRead(deadline) {
  const issued = await requestJson(
    "http://127.0.0.1:3100/api/v1/demo/session",
    {
      method: "POST",
      status: 201,
      description: "account-free session",
      maxBytes: 64 * 1024,
      timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
    },
  );
  exactKeys(issued, ["token", "userId", "expiresAt"], "account-free session");
  assert(
    typeof issued.token === "string" && issued.token.length > 20,
    "account-free token is malformed",
  );
  assert(
    issued.userId === "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "account-free session identity changed",
  );
  const decisions = await requestJson(
    `http://127.0.0.1:3100/api/decisions/${encodeURIComponent(issued.userId)}?limit=1`,
    {
      status: 200,
      description: "account-free sample read",
      maxBytes: 256 * 1024,
      timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${issued.token}`,
      },
    },
  );
  assert(
    Array.isArray(decisions?.decisions),
    "account-free sample read shape is invalid",
  );
  return {
    result: "pass",
    method: "GET",
    pathClass: "sample-decisions",
    responseBytesBound: 256 * 1024,
  };
}

async function cleanPortSample() {
  const results = await Promise.all(
    MANAGED_PORTS.map((port) => targetIsUnused(port)),
  );
  return results.every(Boolean);
}

export async function waitForTwoCleanSamples(options = {}) {
  const probe = options.probe ?? cleanPortSample;
  const now = options.now ?? Date.now;
  const delay =
    options.delay ??
    ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
  const deadline = options.deadline ?? Date.now() + 45_000;
  let consecutive = 0;
  let total = 0;
  while (now() < deadline) {
    const clean = await probe();
    total += 1;
    consecutive = clean ? consecutive + 1 : 0;
    if (consecutive === 2) return { clean: true, sampleCount: total };
    await delay(250);
  }
  return { clean: false, sampleCount: total };
}

async function preflightPorts() {
  for (const port of MANAGED_PORTS)
    assert(
      await targetIsUnused(port),
      `managed port ${port} was occupied before launch`,
    );
}

async function runPackagedScenario(executablePath, profileRoot) {
  await preflightPorts();
  const nonce = randomBytes(32).toString("hex");
  const launch = makeSandboxedLaunch(executablePath, profileRoot, nonce);
  const child = spawn(launch.command, launch.args, launch.options);
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  let stopped = false;
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  try {
    assert(
      Number.isSafeInteger(child.pid) && child.pid > 1,
      "sandboxed launch PID is invalid",
    );
    const { result, samples } = await runContinuousSampler(
      child.pid,
      async () => {
        const info = await waitForOwnedApi(
          child,
          nonce,
          deadline,
          () => spawnError,
        );
        await probeDashboard("http://127.0.0.1:3200/", deadline);
        const accountFreeRead = await probeAccountFreeRead(deadline);
        return { info, accountFreeRead };
      },
    );
    const finalSample = captureOwnedSocketSample(child.pid);
    samples.push(finalSample);
    const termination = await stopProcessTree(child, { timeoutMs: 45_000 });
    stopped = true;
    assert(
      termination.requested && !termination.forced,
      "packaged application required forced termination",
    );
    const released = await waitForTwoCleanSamples();
    assert(
      released.clean,
      "managed listeners were not clean for two post-shutdown samples",
    );
    const observedPorts = [
      ...new Set(samples.flatMap((sample) => sample.loopbackPorts)),
    ].sort((a, b) => a - b);
    for (const port of MANAGED_PORTS)
      assert(
        observedPorts.includes(port),
        `managed loopback port ${port} was never observed`,
      );
    return {
      sandboxedLaunchResult: "pass",
      boundaryEnforcement: "continuous-inherited-macos-sandbox",
      ownedNonceResult: result.info.instanceNonce === nonce ? "pass" : "fail",
      apiReadinessResult: "pass",
      dashboardReadinessResult: "pass",
      accountFreeRead: result.accountFreeRead,
      sampleCount: samples.length,
      maxOwnedProcessCount: Math.max(
        ...samples.map((sample) => sample.processCount),
      ),
      maxOwnedSocketCount: Math.max(
        ...samples.map((sample) => sample.ownedSocketCount),
      ),
      observedLoopbackPorts: observedPorts,
      addressPolicy: "literal-ipv4-loopback-only",
      socketSamplingRole: "corroborates-persistent-and-listening-sockets",
      foreignManagedSocketCount: 0,
      wildcardSocketCount: 0,
      externalSocketCount: 0,
      udpOrMulticastSocketCount: 0,
      gracefulShutdownResult: "pass",
      forcedShutdown: false,
      postShutdownConsecutiveCleanSamples: 2,
    };
  } finally {
    if (!stopped) {
      const termination = await stopProcessTree(child, {
        timeoutMs: 45_000,
      }).catch(() => null);
      if (termination?.forced) {
        // Failure paths never produce a report; this is cleanup of our exact group only.
      }
      await waitForTwoCleanSamples().catch(() => {});
    }
  }
}

function prepareProfile() {
  const root = mkdtempSync(join(tmpdir(), "skytwin-network-evidence-"));
  for (const path of [
    "AppData/Roaming",
    "AppData/Local",
    "config",
    "data",
    "cache",
    "tmp",
    "electron",
  ])
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  return root;
}

function writeExclusiveReport(root, outputPath, report) {
  const output = resolve(root, outputPath);
  const reportsRoot = resolve(root, ".release-evidence", "reports");
  assert(
    output === join(reportsRoot, `${CLAIM_ID}.json`),
    "output path is not canonical",
  );
  assert(within(root, output), "report output escapes the checkout");
  mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export function buildReport({
  identity,
  provenance,
  artifact,
  subject,
  executable,
  verifier,
  sandbox,
  observation,
}) {
  return {
    schemaVersion: 1,
    generatedBy: "release-machine-verifier",
    claimId: CLAIM_ID,
    result: "pass",
    sourceCommit: identity.sourceCommit,
    platform: PLATFORM,
    runnerPlatform: "darwin-arm64",
    releaseTag: identity.releaseTag,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    runAttemptStartedAt: provenance.runAttemptStartedAt,
    repository: identity.repository,
    ref: identity.ref,
    releaseArtifactKind: ARTIFACT_KIND,
    releaseArtifactId: artifact.id,
    releaseArtifactName: ARTIFACT_NAME,
    releaseArtifactSha256: artifact.digest,
    releaseArtifactCreatedAt: artifact.createdAt,
    releaseArtifactAttemptBindingResult: artifact.attemptBindingResult,
    subjectName: subject.name,
    subjectPath: `artifacts/${ARTIFACT_NAME}/${subject.name}`,
    subjectSha256: subject.sha256,
    producerJobName: machineProducerJobName(CLAIM_ID, PLATFORM),
    desktopProducerJobId: provenance.desktopProducerJobId,
    desktopProducerJobName: provenance.desktopProducerJobName,
    desktopProducerJobRunAttempt: provenance.desktopProducerJobRunAttempt,
    desktopProducerJobConclusion: provenance.desktopProducerJobConclusion,
    desktopProducerJobStartedAt: provenance.desktopProducerJobStartedAt,
    desktopProducerJobCompletedAt: provenance.desktopProducerJobCompletedAt,
    desktopUploadStartedAt: provenance.desktopUploadStartedAt,
    desktopUploadCompletedAt: provenance.desktopUploadCompletedAt,
    verifierJobId: provenance.verifierJobId,
    verifierJobName: provenance.verifierJobName,
    verifierJobRunAttempt: provenance.verifierJobRunAttempt,
    verifierJobStatus: provenance.verifierJobStatus,
    verifierPath: machineVerifierPath(CLAIM_ID),
    verifierCommand: machineVerifierCommand(CLAIM_ID, PLATFORM),
    verifierSha256: verifier.sha256,
    executedBinary: {
      name: executable.name,
      sizeBytes: executable.sizeBytes,
      sha256: executable.sha256,
      device: executable.device,
      inode: executable.inode,
      identityResult: "pass",
      derivationMethod: "zip-ditto",
      derivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
    },
    sandboxObservation: sandbox,
    networkObservation: observation,
    evidencePrivacy: {
      contentCaptured: false,
      credentialsCaptured: false,
      userPathsCaptured: false,
      endpointHostnamesCaptured: false,
    },
    checks: [
      {
        id: CHECK_IDS[0],
        testId: CHECK_IDS[0],
        result: "pass",
        observed: {
          assertion:
            "The exact packaged fresh-profile sample scenario was confined to literal IPv4 loopback by a self-tested inherited macOS sandbox profile.",
          measurement: `continuous inherited sandbox enforcement: parent+child loopback pass/external EPERM; ${observation.sampleCount} lsof samples corroborated persistent/listening owned sockets; API/dashboard/sample read pass; two clean post-shutdown samples`,
          exitCode: 0,
        },
      },
    ],
  };
}

export async function runCanonicalVerifier(
  argv = process.argv.slice(2),
  options = {},
) {
  const args = parseCanonicalArgs(argv);
  const identity = readRunIdentity(
    options.env ?? process.env,
    options.runtime ?? process,
  );
  const root = realpathSync(options.root ?? process.cwd());
  // The imported storage primitive performs a bounded clean HEAD/index check.
  const head = runBoundedCommand("/usr/bin/git", ["rev-parse", "HEAD"], {
    timeoutMs: 15_000,
  }).stdout.trim();
  assert(
    head === identity.sourceCommit,
    "source commit does not match checked-out HEAD",
  );
  runBoundedCommand("/usr/bin/git", [
    "diff",
    "--quiet",
    "--ignore-submodules",
    "HEAD",
    "--",
  ]);
  runBoundedCommand("/usr/bin/git", [
    "diff",
    "--cached",
    "--quiet",
    "--ignore-submodules",
    "HEAD",
    "--",
  ]);
  const ids = parseArtifactBindings(
    requiredEnvironment(
      options.env ?? process.env,
      "SKYTWIN_RELEASE_ARTIFACT_IDS",
      /^.+$/u,
    ),
    /^\d+$/u,
    "SKYTWIN_RELEASE_ARTIFACT_IDS",
  );
  const digests = parseArtifactBindings(
    requiredEnvironment(
      options.env ?? process.env,
      "SKYTWIN_RELEASE_ARTIFACT_DIGESTS",
      /^.+$/u,
    ),
    SHA256,
    "SKYTWIN_RELEASE_ARTIFACT_DIGESTS",
  );
  const expectedId = Number(ids.get(ARTIFACT_NAME));
  const expectedDigest = digests.get(ARTIFACT_NAME);
  const provenance = await resolveRunProvenance(
    identity,
    options.fetchImpl ?? globalThis.fetch,
  );
  const artifact = await resolveReleaseArtifact(
    identity,
    expectedId,
    expectedDigest,
    provenance,
    options.fetchImpl ?? globalThis.fetch,
  );
  const subject = selectDownloadedSubject(root, ARTIFACT_CONFIG);
  assert(
    subject.sha256.length === 64,
    "downloaded macOS ZIP digest is malformed",
  );
  const extractionRoot = mkdtempSync(
    join(tmpdir(), "skytwin-network-artifact-"),
  );
  const profileRoot = prepareProfile();
  try {
    const derived = deriveExecutable(PLATFORM, subject.path, extractionRoot);
    const executable = inspectExecutable(
      derived.executablePath,
      "derived packaged application",
    );
    assert(
      derived.derivationPath === "SkyTwin.app/Contents/MacOS/SkyTwin",
      "derived executable path is not canonical",
    );
    const verifierPath = machineVerifierPath(CLAIM_ID);
    assert(
      verifierPath && machineVerifierCommand(CLAIM_ID, PLATFORM),
      "canonical verifier metadata is unavailable",
    );
    const verifier = inspectRegularFile(
      resolve(root, verifierPath),
      "canonical network verifier",
    );
    const sandbox = await selfTestSandbox(profileRoot, options.sandboxOptions);
    const observation = await (options.scenario ?? runPackagedScenario)(
      executable.path,
      profileRoot,
    );
    const subjectAfter = inspectRegularFile(
      subject.path,
      "downloaded macOS ZIP after network probe",
    );
    const executableAfter = inspectExecutable(
      executable.path,
      "derived packaged application after network probe",
    );
    const verifierAfter = inspectRegularFile(
      verifier.path,
      "canonical network verifier after network probe",
    );
    assert(
      sameFileIdentity(subject, subjectAfter),
      "downloaded macOS ZIP changed during network probe",
    );
    assert(
      sameFileIdentity(executable, executableAfter),
      "derived packaged application changed during network probe",
    );
    assert(
      sameFileIdentity(verifier, verifierAfter),
      "canonical network verifier changed during network probe",
    );
    const report = buildReport({
      identity,
      provenance,
      artifact,
      subject,
      executable,
      verifier,
      sandbox,
      observation,
    });
    writeExclusiveReport(root, args.output, report);
    return report;
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCanonicalVerifier().catch((error) => {
    process.stderr.write(
      `[${CLAIM_ID}] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
