#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
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

export const CLAIM_ID = "models.verified-delivery";
export const CHECK_IDS = Object.freeze([
  "models.delivery-digest",
  "models.delivery-license",
  "models.delivery-delete",
]);

export const CANONICAL_MODEL = Object.freeze({
  id: "qwen2.5-1.5b-instruct-q4-k-m",
  name: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  repository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
  revision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
  source:
    "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  metadata:
    "https://huggingface.co/api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/revision/91cad51170dc346986eccefdc2dd33a9da36ead9?blobs=true",
  allowedRedirectHosts: Object.freeze(["us.aws.cdn.hf.co"]),
  exactBytes: 1_117_320_736,
  sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
  license: Object.freeze({
    spdxId: "Apache-2.0",
    cardId: "apache-2.0",
    name: "Apache License 2.0",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
    source:
      "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
    exactBytes: 11_343,
    sha256: "832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
    blobId: "6634c8cc3133b3848ec74b9f275acaaa1ea618ab",
  }),
});

const WORKFLOW_PATH = ".github/workflows/build.yml";
const RELEASE_ARTIFACT_NAME = "SkyTwin-Linux-AppImage";
const RELEASE_ARTIFACT_KIND = "desktop-installer";
const RELEASE_ARTIFACT_PRODUCER_JOB = "Desktop — Linux (AppImage + deb + rpm)";
const RELEASE_ARTIFACT_UPLOAD_STEP = "Upload Linux AppImage";
const RELEASE_ARTIFACT_PACKAGE_STEP = "Package Linux desktop app";
const RELEASE_ARTIFACT_DOWNLOAD_STEP =
  "Download exact Linux AppImage for model delivery";
export const RELEASE_SUBJECT_DIRECTORY =
  ".release-evidence/model-delivery-subject";
const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_LICENSE_BYTES = 256 * 1024;
const MAX_RELEASE_SUBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG =
  /^v(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}(?:(?:\.(?:0|[1-9][0-9]{0,8}))|-beta(?:\.[1-9][0-9]{0,8})?)$/u;
const GIT = "/usr/bin/git";
const NULL_DEVICE = "/dev/null";
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode", "nlink"].every(
    (field) => left[field] === right[field],
  );
}

function assertNoSymlinkComponents(root, candidate, description) {
  const path = relative(root, candidate);
  assert(within(root, candidate), `${description} escapes its root`);
  let current = root;
  for (const component of path.split(sep)) {
    current = join(current, component);
    assert(
      !lstatSync(current).isSymbolicLink(),
      `${description} contains a symlink component`,
    );
  }
}

export function inspectStableRegularFile(
  rootPath,
  requestedPath,
  description,
  expectedBytes,
  expectedSha256 = null,
  testHooks = {},
) {
  assert(
    Number.isSafeInteger(expectedBytes) && expectedBytes > 0,
    `${description} expected size is invalid`,
  );
  assert(
    expectedSha256 === null || SHA256.test(expectedSha256),
    `${description} expected digest is invalid`,
  );
  const lexicalRoot = resolve(rootPath);
  const requested = resolve(requestedPath);
  assert(within(lexicalRoot, requested), `${description} escapes its root`);
  assertNoSymlinkComponents(lexicalRoot, requested, description);
  const beforePath = lstatSync(requested, { bigint: true });
  assert(
    beforePath.isFile() &&
      !beforePath.isSymbolicLink() &&
      beforePath.nlink === 1n,
    `${description} must be a private regular non-symlink file`,
  );
  assert(
    beforePath.size === BigInt(expectedBytes),
    `${description} size does not match the immutable pin`,
  );
  const canonicalRoot = realpathSync(lexicalRoot);
  const canonical = realpathSync(requested);
  assert(
    within(canonicalRoot, canonical),
    `${description} resolves outside its root`,
  );
  const descriptor = openSync(
    requested,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert(
      before.isFile() &&
        before.nlink === 1n &&
        sameFileIdentity(before, beforePath),
      `${description} changed before hashing`,
    );
    testHooks.afterOpen?.({ descriptor, requested });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position);
      if (count === 0) break;
      position += count;
      assert(
        position <= expectedBytes,
        `${description} exceeded the immutable size while hashing`,
      );
      hash.update(buffer.subarray(0, count));
    }
    const digest = hash.digest("hex");
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(requested, { bigint: true });
    assert(
      afterPath.isFile() &&
        !afterPath.isSymbolicLink() &&
        afterPath.nlink === 1n,
      `${description} was replaced while hashing`,
    );
    assert(
      sameFileIdentity(before, after) && sameFileIdentity(after, afterPath),
      `${description} changed while hashing`,
    );
    assert(
      position === expectedBytes && BigInt(position) === after.size,
      `${description} size changed while hashing`,
    );
    if (expectedSha256 !== null)
      assert(
        digest === expectedSha256,
        `${description} digest does not match the immutable pin`,
      );
    return {
      path: requested,
      name: basename(requested),
      sizeBytes: position,
      sha256: digest,
      device: Number(after.dev),
      inode: Number(after.ino),
      identity: after,
    };
  } finally {
    closeSync(descriptor);
  }
}

function requiredEnvironment(env, name, pattern) {
  const value = env[name];
  assert(
    typeof value === "string" && pattern.test(value),
    `${name} is missing or invalid`,
  );
  return value;
}

function positiveInteger(env, name) {
  const value = Number(env[name]);
  assert(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
  return value;
}

export function readRunIdentity(env = process.env) {
  assert(env.RUNNER_OS === "Linux", "model delivery verifier requires Linux");
  assert(env.RUNNER_ARCH === "X64", "model delivery verifier requires x64");
  assert(
    env.GITHUB_EVENT_NAME === "push",
    "model delivery verifier requires a tag push event",
  );
  const sourceCommit = requiredEnvironment(env, "GITHUB_SHA", COMMIT);
  const repository = requiredEnvironment(env, "GITHUB_REPOSITORY", REPOSITORY);
  const releaseTag = requiredEnvironment(env, "GITHUB_REF_NAME", TAG);
  const ref = requiredEnvironment(env, "GITHUB_REF", /^refs\/tags\/v[^\s]+$/u);
  assert(
    ref === `refs/tags/${releaseTag}`,
    "GITHUB_REF does not match the tag",
  );
  const runId = positiveInteger(env, "GITHUB_RUN_ID");
  const runAttempt = positiveInteger(env, "GITHUB_RUN_ATTEMPT");
  const token = requiredEnvironment(env, "GITHUB_TOKEN", /^.{20,}$/u);
  const releaseArtifactId = positiveInteger(
    env,
    "SKYTWIN_LINUX_APPIMAGE_ARTIFACT_ID",
  );
  const releaseArtifactSha256 = requiredEnvironment(
    env,
    "SKYTWIN_LINUX_APPIMAGE_ARTIFACT_DIGEST",
    /^(?:sha256:)?[0-9a-f]{64}$/u,
  ).replace(/^sha256:/u, "");
  const releaseArtifactDownloadPath = requiredEnvironment(
    env,
    "SKYTWIN_MODEL_APPIMAGE_DOWNLOAD_PATH",
    /^\/[\S]+$/u,
  );
  return {
    sourceCommit,
    repository,
    releaseTag,
    ref,
    runId,
    runAttempt,
    token,
    releaseArtifactId,
    releaseArtifactSha256,
    releaseArtifactDownloadPath,
  };
}

async function responseJson(response, description) {
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
    if (size > MAX_API_BYTES) {
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
        "User-Agent": "skytwin-model-delivery-verifier",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  return responseJson(response, `GitHub API ${path}`);
}

export async function resolveCurrentRun(
  identity,
  fetchImpl = globalThis.fetch,
) {
  const run = await githubJson(
    identity,
    `/actions/runs/${identity.runId}`,
    fetchImpl,
  );
  assert(
    run.id === identity.runId &&
      run.run_attempt === identity.runAttempt &&
      run.repository?.full_name === identity.repository &&
      run.head_sha === identity.sourceCommit &&
      run.head_branch === identity.releaseTag &&
      run.event === "push" &&
      run.path === WORKFLOW_PATH,
    "current workflow run is not the exact canonical tag-push attempt",
  );
  const attempt = await githubJson(
    identity,
    `/actions/runs/${identity.runId}/attempts/${identity.runAttempt}`,
    fetchImpl,
  );
  assert(
    attempt.id === identity.runId &&
      attempt.run_attempt === identity.runAttempt &&
      attempt.repository?.full_name === identity.repository &&
      attempt.head_sha === identity.sourceCommit &&
      attempt.head_branch === identity.releaseTag &&
      attempt.event === "push" &&
      attempt.path === WORKFLOW_PATH,
    "current workflow attempt is not the exact canonical tag-push attempt",
  );
  return {
    run,
    attempt,
    runAttemptStartedAt: attempt.run_started_at,
    runAttemptStartedTimestamp: parseTimestamp(
      attempt.run_started_at,
      "current workflow attempt start",
    ),
  };
}

function parseTimestamp(value, description) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value),
    `${description} timestamp is invalid`,
  );
  const timestamp = Date.parse(value);
  assert(
    Number.isSafeInteger(timestamp),
    `${description} timestamp is invalid`,
  );
  return timestamp;
}

function exactJob(jobs, name, description) {
  const matches = jobs.filter((job) => job?.name === name);
  assert(matches.length === 1, `${description} job identity is ambiguous`);
  return matches[0];
}

function exactSuccessfulStep(job, name, description) {
  const matches = Array.isArray(job.steps)
    ? job.steps.filter((step) => step?.name === name)
    : [];
  assert(
    matches.length === 1 && matches[0].conclusion === "success",
    `${description} step did not succeed exactly once`,
  );
  return matches[0];
}

export async function resolveAttemptProvenance(
  identity,
  runAttemptStartedAt,
  fetchImpl = globalThis.fetch,
) {
  const runAttemptStartedTimestamp = parseTimestamp(
    runAttemptStartedAt,
    "current workflow attempt start",
  );
  const page = await githubJson(
    identity,
    `/actions/runs/${identity.runId}/attempts/${identity.runAttempt}/jobs?per_page=100&page=1`,
    fetchImpl,
  );
  assert(
    Array.isArray(page?.jobs) && Number.isSafeInteger(page.total_count),
    "exact-attempt GitHub job inventory is malformed",
  );
  assert(
    page.total_count <= 100 && page.jobs.length === page.total_count,
    "exact-attempt GitHub job inventory is incomplete",
  );
  const producer = exactJob(
    page.jobs,
    RELEASE_ARTIFACT_PRODUCER_JOB,
    "Linux AppImage producer",
  );
  assert(
    Number.isSafeInteger(producer.id) &&
      producer.id > 0 &&
      producer.run_id === identity.runId &&
      producer.run_attempt === identity.runAttempt &&
      producer.head_sha === identity.sourceCommit &&
      producer.status === "completed" &&
      producer.conclusion === "success",
    "Linux AppImage producer is not successful in the exact workflow attempt",
  );
  const producerJobStartedAt = parseTimestamp(
    producer.started_at,
    "Linux AppImage producer start",
  );
  const producerJobCompletedAt = parseTimestamp(
    producer.completed_at,
    "Linux AppImage producer completion",
  );
  exactSuccessfulStep(
    producer,
    RELEASE_ARTIFACT_PACKAGE_STEP,
    "Linux AppImage package",
  );
  const uploadStep = exactSuccessfulStep(
    producer,
    RELEASE_ARTIFACT_UPLOAD_STEP,
    "Linux AppImage upload",
  );
  const uploadStartedAt = parseTimestamp(
    uploadStep.started_at,
    "Linux AppImage upload start",
  );
  const uploadCompletedAt = parseTimestamp(
    uploadStep.completed_at,
    "Linux AppImage upload completion",
  );
  assert(
    runAttemptStartedTimestamp <= producerJobStartedAt &&
      producerJobStartedAt <= uploadStartedAt &&
      uploadStartedAt <= uploadCompletedAt &&
      uploadCompletedAt <= producerJobCompletedAt,
    "Linux AppImage producer and upload timestamps are outside the current workflow attempt",
  );

  const verifierName = machineProducerJobName(CLAIM_ID, "linux");
  const verifier = exactJob(page.jobs, verifierName, "model delivery verifier");
  assert(
    Number.isSafeInteger(verifier.id) &&
      verifier.id > 0 &&
      verifier.run_id === identity.runId &&
      verifier.run_attempt === identity.runAttempt &&
      verifier.head_sha === identity.sourceCommit &&
      verifier.status === "in_progress" &&
      verifier.conclusion === null,
    "model delivery verifier is not running in the exact workflow attempt",
  );
  const verifierSteps = Array.isArray(verifier.steps) ? verifier.steps : [];
  const currentVerifierSteps = verifierSteps.filter(
    (step) =>
      step?.name === "Run canonical machine verifier" &&
      ["queued", "in_progress"].includes(step?.status) &&
      step?.conclusion === null,
  );
  assert(
    currentVerifierSteps.length === 1,
    "canonical model delivery verifier step is not active",
  );
  const downloadStep = exactSuccessfulStep(
    verifier,
    RELEASE_ARTIFACT_DOWNLOAD_STEP,
    "exact-ID Linux AppImage download",
  );
  return {
    producerJobId: producer.id,
    producerJobName: producer.name,
    producerJobRunAttempt: producer.run_attempt,
    producerJobConclusion: producer.conclusion,
    runAttemptStartedAt,
    runAttemptStartedTimestamp,
    producerJobStartedAt: producer.started_at,
    producerJobCompletedAt: producer.completed_at,
    producerJobStartedTimestamp: producerJobStartedAt,
    producerJobCompletedTimestamp: producerJobCompletedAt,
    uploadStartedAt: uploadStep.started_at,
    uploadCompletedAt: uploadStep.completed_at,
    uploadStartedTimestamp: uploadStartedAt,
    uploadCompletedTimestamp: uploadCompletedAt,
    verifierJobId: verifier.id,
    verifierJobName: verifier.name,
    verifierJobRunAttempt: verifier.run_attempt,
    verifierJobStatus: verifier.status,
    downloadStepName: downloadStep.name,
    downloadStepConclusion: downloadStep.conclusion,
  };
}

export async function resolveReleaseArtifact(
  identity,
  attemptProvenance,
  fetchImpl = globalThis.fetch,
) {
  const page = await githubJson(
    identity,
    `/actions/runs/${identity.runId}/artifacts?per_page=100&page=1`,
    fetchImpl,
  );
  assert(
    Array.isArray(page?.artifacts) && Number.isSafeInteger(page.total_count),
    "GitHub artifact inventory is malformed",
  );
  assert(
    page.total_count <= 100 && page.artifacts.length === page.total_count,
    "GitHub artifact inventory is incomplete",
  );
  const matches = page.artifacts.filter(
    (artifact) => artifact?.id === identity.releaseArtifactId,
  );
  assert(
    matches.length === 1,
    "current-attempt workflow output does not identify one Linux AppImage artifact",
  );
  const artifact = matches[0];
  const digest = String(artifact.digest ?? "").replace(/^sha256:/u, "");
  assert(
    Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.id === identity.releaseArtifactId &&
      artifact.name === RELEASE_ARTIFACT_NAME &&
      artifact.expired === false &&
      SHA256.test(digest) &&
      digest === identity.releaseArtifactSha256 &&
      artifact.workflow_run?.id === identity.runId &&
      artifact.workflow_run?.head_sha === identity.sourceCommit,
    "Linux AppImage artifact identity is invalid",
  );
  const detail = await githubJson(
    identity,
    `/actions/artifacts/${artifact.id}`,
    fetchImpl,
  );
  assert(
    detail.id === artifact.id &&
      detail.name === RELEASE_ARTIFACT_NAME &&
      detail.expired === false &&
      detail.digest === `sha256:${digest}` &&
      detail.workflow_run?.id === identity.runId &&
      detail.workflow_run?.head_sha === identity.sourceCommit,
    "Linux AppImage artifact detail disagrees with its inventory identity",
  );
  assert(
    detail.created_at === artifact.created_at,
    "Linux AppImage artifact creation timestamp is inconsistent",
  );
  const artifactCreatedTimestamp = parseTimestamp(
    artifact.created_at,
    "Linux AppImage artifact creation",
  );
  assert(
    artifactCreatedTimestamp >= attemptProvenance.uploadStartedTimestamp &&
      artifactCreatedTimestamp <=
        attemptProvenance.producerJobCompletedTimestamp,
    "Linux AppImage artifact was not created inside the exact-attempt producer window",
  );
  return {
    artifactId: artifact.id,
    artifactName: RELEASE_ARTIFACT_NAME,
    artifactSha256: digest,
    artifactCreatedAt: artifact.created_at,
    attemptBindingResult: "workflow-output-and-producer-window-pass",
    kind: RELEASE_ARTIFACT_KIND,
  };
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
    "model verifier source object read",
    `${entries.map((entry) => entry.object).join("\n")}\n`,
  );
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0)
      throw new Error("model verifier source object output is incomplete");
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = header.match(/^([a-f0-9]{40}) blob ([0-9]+)$/u);
    if (!match || match[1] !== entry.object)
      throw new Error("model verifier source object identity is invalid");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("model verifier source object size is invalid");
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd >= output.length || output[bodyEnd] !== 10)
      throw new Error("model verifier source object body is incomplete");
    const bytes = output.subarray(bodyStart, bodyEnd);
    const objectIdentity = createHash("sha1")
      .update(`blob ${size}\0`)
      .update(bytes)
      .digest("hex");
    if (objectIdentity !== entry.object)
      throw new Error("model verifier source object content is invalid");
    entry.size = size;
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
    offset = bodyEnd + 1;
  }
  if (offset !== output.length)
    throw new Error("model verifier source object output has trailing bytes");
}

function captureSourceSnapshot(root, sourceCommit) {
  const head = gitOutput(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "model verifier source identity check",
  ).trim();
  if (head !== sourceCommit)
    throw new Error("GITHUB_SHA does not match checked-out HEAD");

  const tree = gitBytes(
    root,
    ["ls-tree", "-rz", "--full-tree", sourceCommit],
    "model verifier source tree inventory",
  );
  const entries = nullTerminatedRecords(
    tree,
    "model verifier source tree inventory",
  ).map((record) => {
    const tab = record.indexOf(9);
    const header = tab < 0 ? "" : record.subarray(0, tab).toString("ascii");
    const match = header.match(/^([0-7]{6}) ([a-z]+) ([a-f0-9]{40})$/u);
    if (
      !match ||
      match[2] !== "blob" ||
      !CANONICAL_BLOB_MODES.has(match[1]) ||
      !COMMIT.test(match[3])
    )
      throw new Error(
        "model verifier source tree contains an unsupported entry",
      );
    return {
      mode: match[1],
      object: match[3],
      path: decodeGitPath(
        record.subarray(tab + 1),
        "model verifier source tree",
      ),
    };
  });
  if (
    entries.length === 0 ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  )
    throw new Error(
      "model verifier source tree inventory is empty or ambiguous",
    );
  expectedBlobDigests(root, entries);
  return Object.freeze({
    sourceCommit,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

function assertNoSymlinkParents(root, absolute, description) {
  const path = relative(root, absolute);
  let current = root;
  for (const component of path.split(sep).slice(0, -1)) {
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
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
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
  return {
    size: target.length,
    sha256: createHash("sha256").update(target).digest("hex"),
    executable: false,
  };
}

function parseIndexEntries(bytes) {
  return nullTerminatedRecords(bytes, "model verifier index inventory").map(
    (record) => {
      const tab = record.indexOf(9);
      const header = tab < 0 ? "" : record.subarray(0, tab).toString("ascii");
      const match = header.match(/^([0-7]{6}) ([a-f0-9]{40}) ([0-3])$/u);
      if (!match)
        throw new Error("model verifier index inventory is malformed");
      return {
        mode: match[1],
        object: match[2],
        stage: match[3],
        path: decodeGitPath(record.subarray(tab + 1), "model verifier index"),
      };
    },
  );
}

function assertCanonicalIndex(root, snapshot) {
  const indexEntries = parseIndexEntries(
    gitBytes(
      root,
      ["ls-files", "--stage", "-z"],
      "model verifier index inventory",
    ),
  );
  const expected = snapshot.entries.map(({ mode, object, path }) => ({
    mode,
    object,
    stage: "0",
    path,
  }));
  if (JSON.stringify(indexEntries) !== JSON.stringify(expected))
    throw new Error("model verifier index differs from the triggering commit");

  const flags = nullTerminatedRecords(
    gitBytes(root, ["ls-files", "-v", "-z"], "model verifier index flags"),
    "model verifier index flags",
  );
  if (flags.length !== snapshot.entries.length)
    throw new Error("model verifier index flags are incomplete");
  for (let index = 0; index < flags.length; index += 1) {
    const record = flags[index];
    if (record.length < 3 || record[1] !== 32)
      throw new Error("model verifier index flags are malformed");
    const flag = String.fromCharCode(record[0]);
    const path = decodeGitPath(
      record.subarray(2),
      "model verifier index flags",
    );
    if (
      path !== snapshot.entries[index].path ||
      flag === "S" ||
      flag.toLowerCase() === flag
    )
      throw new Error(
        "model verifier index uses skip-worktree or assume-unchanged state",
      );
  }
}

export function assertSourceCheckout(rootPath, identity) {
  const root = realpathSync(resolve(rootPath));
  const snapshot = captureSourceSnapshot(root, identity.sourceCommit);
  assertCanonicalIndex(root, snapshot);
  for (const entry of snapshot.entries) {
    const absolute = resolve(root, entry.path);
    const path = relative(root, absolute);
    if (path === "" || path === ".." || path.startsWith(`..${sep}`))
      throw new Error("model verifier source path escapes the repository");
    let observed;
    try {
      observed =
        entry.mode === "120000"
          ? observeSymlink(
              root,
              absolute,
              `model verifier source ${entry.path}`,
            )
          : observeRegularFile(
              root,
              absolute,
              `model verifier source ${entry.path}`,
            );
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT")
        throw new Error("model verifier source tree changed during inspection");
      throw error;
    }
    if (
      observed.size !== entry.size ||
      observed.sha256 !== entry.sha256 ||
      observed.executable !== (entry.mode === "100755")
    )
      throw new Error("model verifier source tree changed during inspection");
  }
}

export function inspectReleaseSubject(
  root,
  releaseTag,
  artifact,
  actionDownloadPath,
) {
  const version = readFileSync(join(root, "VERSION"), "utf8").trim();
  const tagMatch =
    releaseTag.match(
      /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/u,
    ) ??
    releaseTag.match(
      /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})-beta(?:\.([1-9][0-9]{0,8}))?$/u,
    );
  assert(tagMatch, "release tag cannot be normalized");
  const [, major, minor, patch, rawBuild] = tagMatch;
  const build = rawBuild ?? "0";
  assert(Number(build) < 100, "release tag build segment is outside its bound");
  const repositoryVersion = `${major}.${minor}.${patch}.${build}`;
  const appVersion = `${major}.${minor}.${Number(patch) * 100 + Number(build)}`;
  assert(version === repositoryVersion, "release tag does not match VERSION");
  const lexicalRoot = resolve(root);
  const directory = resolve(lexicalRoot, RELEASE_SUBJECT_DIRECTORY);
  assert(
    isAbsolute(actionDownloadPath) && resolve(actionDownloadPath) === directory,
    "Linux AppImage action download path is not canonical",
  );
  assertNoSymlinkComponents(
    lexicalRoot,
    directory,
    "Linux AppImage artifact directory",
  );
  const directoryStat = lstatSync(directory, { bigint: true });
  assert(
    directoryStat.isDirectory() &&
      !directoryStat.isSymbolicLink() &&
      (directoryStat.mode & 0o777n) === 0o700n,
    "Linux AppImage artifact directory is unsafe",
  );
  assert(
    within(realpathSync(root), realpathSync(directory)),
    "Linux AppImage artifact directory escapes the checkout",
  );
  const entries = readdirSync(directory, { withFileTypes: true });
  assert(
    entries.length === 1,
    "Linux AppImage artifact must contain one subject",
  );
  const expectedName = `SkyTwin-${appVersion}.AppImage`;
  const entry = entries[0];
  assert(
    entry.isFile() && !entry.isSymbolicLink() && entry.name === expectedName,
    "Linux AppImage subject name or type is not canonical",
  );
  const subjectBytes = lstatSync(join(directory, entry.name), {
    bigint: true,
  }).size;
  assert(
    subjectBytes > 0n && subjectBytes <= BigInt(MAX_RELEASE_SUBJECT_BYTES),
    "Linux AppImage subject size is outside the release bound",
  );
  const observed = inspectStableRegularFile(
    root,
    join(directory, entry.name),
    "Linux AppImage subject",
    Number(subjectBytes),
    null,
  );
  return {
    ...observed,
    relativePath: `artifacts/${artifact.artifactName}/${entry.name}`,
    downloadPath: `${RELEASE_SUBJECT_DIRECTORY}/${entry.name}`,
  };
}

function validatePinnedSource(model) {
  assert(
    typeof model.id === "string" &&
      /^[a-z0-9][a-z0-9.-]*$/u.test(model.id) &&
      typeof model.name === "string" &&
      basename(model.name) === model.name &&
      model.name.endsWith(".gguf"),
    "model identity is invalid",
  );
  assert(
    typeof model.repository === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(model.repository),
    "model repository is invalid",
  );
  assert(COMMIT.test(model.revision), "model revision is not immutable");
  assert(SHA256.test(model.sha256), "model digest is invalid");
  assert(
    Number.isSafeInteger(model.exactBytes) && model.exactBytes > 0,
    "model size pin is invalid",
  );
  const source = new URL(model.source);
  assert(
    source.username === "" &&
      source.password === "" &&
      source.protocol === "https:" &&
      source.hostname === "huggingface.co" &&
      source.port === "" &&
      source.pathname ===
        `/${model.repository}/resolve/${model.revision}/${model.name}` &&
      source.search === "" &&
      source.hash === "",
    "model source is not the canonical immutable HTTPS location",
  );
  const metadata = new URL(model.metadata);
  assert(
    metadata.username === "" &&
      metadata.password === "" &&
      metadata.protocol === "https:" &&
      metadata.hostname === "huggingface.co" &&
      metadata.port === "" &&
      metadata.pathname ===
        `/api/models/${model.repository}/revision/${model.revision}` &&
      metadata.search === "?blobs=true" &&
      metadata.hash === "",
    "model metadata is not the canonical immutable HTTPS endpoint",
  );
  assert(
    Array.isArray(model.allowedRedirectHosts) &&
      model.allowedRedirectHosts.length > 0 &&
      model.allowedRedirectHosts.every(
        (host) =>
          typeof host === "string" &&
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
            host,
          ),
      ),
    "model redirect allowlist is invalid",
  );
  assert(
    model.license.spdxId.length > 0 &&
      model.license.cardId.length > 0 &&
      model.license.url ===
        `https://huggingface.co/${model.repository}/blob/${model.revision}/LICENSE` &&
      model.license.source ===
        `https://huggingface.co/${model.repository}/resolve/${model.revision}/LICENSE` &&
      Number.isSafeInteger(model.license.exactBytes) &&
      model.license.exactBytes > 0 &&
      model.license.exactBytes <= MAX_LICENSE_BYTES &&
      SHA256.test(model.license.sha256) &&
      COMMIT.test(model.license.blobId),
    "model license is not pinned to the immutable source revision",
  );
}

export async function observePinnedMetadata(
  model = CANONICAL_MODEL,
  fetchImpl = globalThis.fetch,
) {
  validatePinnedSource(model);
  const response = await fetchImpl(model.metadata, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "identity",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const metadata = await responseJson(response, "immutable model metadata");
  assert(
    metadata?.id === model.repository && metadata?.sha === model.revision,
    "model metadata repository or revision does not match the immutable pin",
  );
  assert(
    metadata?.cardData?.license === model.license.cardId,
    "model metadata card license does not match the reviewed disclosure",
  );
  const siblings = Array.isArray(metadata.siblings) ? metadata.siblings : [];
  const modelSiblings = siblings.filter(
    (sibling) => sibling?.rfilename === model.name,
  );
  assert(
    modelSiblings.length === 1 &&
      modelSiblings[0]?.size === model.exactBytes &&
      modelSiblings[0]?.lfs?.size === model.exactBytes &&
      modelSiblings[0]?.lfs?.sha256 === model.sha256,
    "model metadata does not contain the exact reviewed LFS sibling",
  );
  const licenseSiblings = siblings.filter(
    (sibling) => sibling?.rfilename === "LICENSE",
  );
  assert(
    licenseSiblings.length === 1 &&
      licenseSiblings[0]?.size === model.license.exactBytes &&
      licenseSiblings[0]?.blobId === model.license.blobId,
    "model metadata does not contain the exact reviewed license sibling",
  );
  return {
    repository: metadata.id,
    revision: metadata.sha,
    cardLicense: metadata.cardData.license,
    modelSiblingName: modelSiblings[0].rfilename,
    modelSiblingExactBytes: modelSiblings[0].lfs.size,
    modelSiblingSha256: modelSiblings[0].lfs.sha256,
    licenseSiblingName: licenseSiblings[0].rfilename,
    licenseSiblingExactBytes: licenseSiblings[0].size,
    licenseSiblingBlobId: licenseSiblings[0].blobId,
    verificationResult: "pass",
  };
}

function assertCanonicalLicenseRedirect(model, currentUrl, nextUrl) {
  const next = new URL(nextUrl, currentUrl);
  const canonicalCachePath = `/api/resolve-cache/models/${model.repository}/${model.revision}/LICENSE`;
  const canonicalResolveKey = `/${model.repository}/resolve/${model.revision}/LICENSE`;
  const entries = [...next.searchParams.entries()];
  assert(
    next.protocol === "https:" &&
      next.hostname === "huggingface.co" &&
      next.port === "" &&
      next.username === "" &&
      next.password === "" &&
      next.hash === "" &&
      next.pathname === canonicalCachePath &&
      entries.length === 2 &&
      entries.some(
        ([key, value]) => key === canonicalResolveKey && value === "",
      ) &&
      entries.some(
        ([key, value]) =>
          key === "etag" && value === `\"${model.license.blobId}\"`,
      ),
    "license download redirected outside the immutable Hugging Face cache identity",
  );
  return next;
}

async function readBoundedBytes(response, maximum, description) {
  assert(
    response?.status === 200 && response.body,
    `${description} returned HTTP ${response?.status ?? "unknown"}`,
  );
  assert(
    response.headers.get("content-encoding") === null ||
      response.headers.get("content-encoding") === "identity",
    `${description} used a content encoding`,
  );
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Error(`${description} exceeded its byte bound`);
    }
    chunks.push(value);
  }
  assert(size > 0, `${description} returned an empty response`);
  return Buffer.concat(chunks, size);
}

export async function observePinnedLicense(
  model = CANONICAL_MODEL,
  fetchImpl = globalThis.fetch,
) {
  validatePinnedSource(model);
  let url = model.license.source;
  for (let redirect = 0; redirect <= 1; redirect += 1) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(redirect === 0, "license download exceeded redirect bound");
      const location = response.headers.get("location");
      assert(location, "license download redirect omitted Location");
      const next = assertCanonicalLicenseRedirect(model, url, location);
      await response.body?.cancel();
      url = next.href;
      continue;
    }
    assert(
      response.headers.get("content-length") ===
        String(model.license.exactBytes),
      "license download Content-Length does not match the immutable size",
    );
    const bytes = await readBoundedBytes(
      response,
      model.license.exactBytes,
      "license download",
    );
    assert(
      bytes.length === model.license.exactBytes &&
        createHash("sha256").update(bytes).digest("hex") ===
          model.license.sha256,
      "license bytes do not match the immutable digest pin",
    );
    const blobId = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    assert(
      blobId === model.license.blobId,
      "license bytes do not match the observed repository blob",
    );
    return {
      source: model.license.source,
      exactBytes: bytes.length,
      sha256: model.license.sha256,
      blobId,
      verificationResult: "pass",
    };
  }
  throw new Error("license download exceeded redirect bound");
}

async function fetchPinnedResponse(model, fetchImpl) {
  validatePinnedSource(model);
  let url = model.source;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(
        redirect < MAX_REDIRECTS,
        "model download exceeded redirect bound",
      );
      const location = response.headers.get("location");
      assert(location, "model download redirect omitted Location");
      const next = new URL(location, url);
      assert(
        next.protocol === "https:" &&
          next.port === "" &&
          next.username === "" &&
          next.password === "" &&
          next.hash === "" &&
          model.allowedRedirectHosts.includes(next.hostname),
        "model download redirected outside the trusted host allowlist",
      );
      await response.body?.cancel();
      url = next.href;
      continue;
    }
    assert(
      response.status === 200,
      `model download returned HTTP ${response.status}`,
    );
    assert(response.body, "model download returned no body");
    assert(
      response.headers.get("content-encoding") === null ||
        response.headers.get("content-encoding") === "identity",
      "model download used a content encoding",
    );
    assert(
      response.headers.get("content-length") === String(model.exactBytes),
      "model download Content-Length does not match the immutable size",
    );
    return { response, finalUrl: url };
  }
  throw new Error("model download exceeded redirect bound");
}

async function writeFully(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    assert(
      Number.isSafeInteger(result.bytesWritten) &&
        result.bytesWritten > 0 &&
        result.bytesWritten <= bytes.length - written,
      "model download write made no progress",
    );
    written += result.bytesWritten;
  }
}

function deleteVerifiedCandidate(path, expectedIdentity) {
  const quarantine = `${path}.deleting`;
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert(
      before.isFile() &&
        before.nlink === 1n &&
        sameFileIdentity(before, expectedIdentity),
      "verified model candidate changed before deletion",
    );
    renameSync(path, quarantine);
    const moved = lstatSync(quarantine, { bigint: true });
    assert(
      moved.isFile() &&
        moved.nlink === 1n &&
        moved.dev === before.dev &&
        moved.ino === before.ino &&
        moved.size === before.size,
      "verified model candidate changed during deletion",
    );
    unlinkSync(quarantine);
  } finally {
    closeSync(descriptor);
  }
}

export async function downloadAndVerifyModel(
  model = CANONICAL_MODEL,
  {
    fetchImpl = globalThis.fetch,
    temporaryParent = tmpdir(),
    testHooks = {},
  } = {},
) {
  const temporaryRoot = mkdtempSync(
    join(temporaryParent, "skytwin-model-delivery-"),
  );
  chmodSync(temporaryRoot, 0o700);
  const path = join(temporaryRoot, model.name);
  try {
    const metadataObservation = await observePinnedMetadata(model, fetchImpl);
    const licenseObservation = await observePinnedLicense(model, fetchImpl);
    const { response, finalUrl } = await fetchPinnedResponse(model, fetchImpl);
    const handle = await openFile(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let position = 0;
    const deliveryHash = createHash("sha256");
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        position += value.length;
        assert(
          position <= model.exactBytes,
          "model download exceeded the immutable size",
        );
        await writeFully(handle, value, position - value.length);
        deliveryHash.update(value);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    assert(position === model.exactBytes, "model download was incomplete");
    assert(
      deliveryHash.digest("hex") === model.sha256,
      "model delivery digest does not match the immutable pin",
    );
    const stable = inspectStableRegularFile(
      temporaryRoot,
      path,
      "downloaded model candidate",
      model.exactBytes,
      model.sha256,
      testHooks,
    );
    deleteVerifiedCandidate(path, stable.identity);
    let absent = false;
    try {
      lstatSync(path);
    } catch (error) {
      absent = error?.code === "ENOENT";
    }
    assert(absent, "verified model candidate remained after deletion");
    return {
      id: model.id,
      name: model.name,
      source: model.source,
      // Redirect query strings can contain short-lived signed delivery tokens.
      // Record only the allowlisted delivery host in durable evidence.
      deliveryHost: new URL(finalUrl).hostname,
      sourceRepository: model.repository,
      sourceRevision: model.revision,
      metadata: model.metadata,
      metadataRepository: metadataObservation.repository,
      metadataRevision: metadataObservation.revision,
      metadataCardLicense: metadataObservation.cardLicense,
      metadataSiblingName: metadataObservation.modelSiblingName,
      metadataSiblingExactBytes: metadataObservation.modelSiblingExactBytes,
      metadataSiblingSha256: metadataObservation.modelSiblingSha256,
      metadataLicenseSiblingName: metadataObservation.licenseSiblingName,
      metadataLicenseSiblingExactBytes:
        metadataObservation.licenseSiblingExactBytes,
      metadataLicenseSiblingBlobId: metadataObservation.licenseSiblingBlobId,
      metadataVerificationResult: metadataObservation.verificationResult,
      license: model.license.spdxId,
      licenseName: model.license.name,
      licenseUrl: model.license.url,
      licenseSource: licenseObservation.source,
      licenseExactBytes: licenseObservation.exactBytes,
      licenseSha256: licenseObservation.sha256,
      licenseBlobId: licenseObservation.blobId,
      licenseVerificationResult: licenseObservation.verificationResult,
      exactBytes: stable.sizeBytes,
      sha256: stable.sha256,
      digestVerificationResult: "pass",
      stableFileIdentityResult: "pass",
      deletionResult: "pass",
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function passingCheck(id, assertion, measurement) {
  return {
    id,
    testId: id,
    result: "pass",
    observed: { assertion, measurement, exitCode: 0 },
  };
}

export function buildReport({
  root,
  identity,
  artifact,
  attemptProvenance,
  releaseSubject,
  modelArtifact,
  runtime = process,
}) {
  const verifierPath = machineVerifierPath(CLAIM_ID);
  const verifierCommand = machineVerifierCommand(CLAIM_ID, "linux");
  assert(
    verifierPath && verifierCommand,
    "canonical verifier metadata is missing",
  );
  const verifierBytes = readFileSync(resolve(root, verifierPath));
  return {
    releaseTag: identity.releaseTag,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    runAttemptStartedAt: attemptProvenance.runAttemptStartedAt,
    repository: identity.repository,
    ref: identity.ref,
    releaseArtifactKind: artifact.kind,
    releaseArtifactId: artifact.artifactId,
    releaseArtifactName: artifact.artifactName,
    releaseArtifactSha256: artifact.artifactSha256,
    releaseArtifactCreatedAt: artifact.artifactCreatedAt,
    releaseArtifactAttemptBindingResult: artifact.attemptBindingResult,
    releaseArtifactDownloadPath: releaseSubject.downloadPath,
    releaseArtifactDownloadStepName: attemptProvenance.downloadStepName,
    releaseArtifactDownloadStepConclusion:
      attemptProvenance.downloadStepConclusion,
    releaseArtifactDownloadBindingResult:
      "exact-artifact-id-action-download-pass",
    subjectName: releaseSubject.name,
    subjectPath: releaseSubject.relativePath,
    subjectSha256: releaseSubject.sha256,
    producerJobName: machineProducerJobName(CLAIM_ID, "linux"),
    desktopProducerJobId: attemptProvenance.producerJobId,
    desktopProducerJobName: attemptProvenance.producerJobName,
    desktopProducerJobRunAttempt: attemptProvenance.producerJobRunAttempt,
    desktopProducerJobConclusion: attemptProvenance.producerJobConclusion,
    desktopProducerJobStartedAt: attemptProvenance.producerJobStartedAt,
    desktopProducerJobCompletedAt: attemptProvenance.producerJobCompletedAt,
    desktopUploadStartedAt: attemptProvenance.uploadStartedAt,
    desktopUploadCompletedAt: attemptProvenance.uploadCompletedAt,
    verifierJobId: attemptProvenance.verifierJobId,
    verifierJobName: attemptProvenance.verifierJobName,
    verifierJobRunAttempt: attemptProvenance.verifierJobRunAttempt,
    verifierJobStatus: attemptProvenance.verifierJobStatus,
    verifierPath,
    verifierCommand,
    verifierSha256: createHash("sha256").update(verifierBytes).digest("hex"),
    schemaVersion: 1,
    generatedBy: "release-machine-verifier",
    claimId: CLAIM_ID,
    result: "pass",
    sourceCommit: identity.sourceCommit,
    platform: "linux",
    runnerPlatform: `${runtime.platform}-${runtime.arch}`,
    modelArtifacts: [modelArtifact],
    checks: [
      passingCheck(
        CHECK_IDS[0],
        "The delivered model bytes match the reviewed immutable source pin",
        `${modelArtifact.name} ${modelArtifact.exactBytes} bytes sha256:${modelArtifact.sha256}`,
      ),
      passingCheck(
        CHECK_IDS[1],
        "The model metadata and license bytes are observed at the same immutable source revision",
        `${modelArtifact.metadataRepository}@${modelArtifact.metadataRevision} card=${modelArtifact.metadataCardLicense}; LICENSE ${modelArtifact.licenseExactBytes} bytes sha256:${modelArtifact.licenseSha256}`,
      ),
      passingCheck(
        CHECK_IDS[2],
        "The verified candidate was removed from the isolated verifier workspace",
        "stable inode quarantined and deleted after verification",
      ),
    ],
  };
}

export function parseCanonicalArgs(argv) {
  assert(
    argv.length === 4 &&
      argv[0] === "--platform" &&
      argv[1] === "linux" &&
      argv[2] === "--output",
    "use the canonical --platform linux --output <path> invocation",
  );
  assert(
    argv[3] === ".release-evidence/reports/models.verified-delivery.json",
    "output path is not canonical",
  );
  return { platform: "linux", output: argv[3] };
}

function ensureOutputParent(root, output) {
  const lexicalRoot = resolve(root);
  const resolvedRoot = realpathSync(lexicalRoot);
  const requested = resolve(lexicalRoot, output);
  assert(within(lexicalRoot, requested), "report output escapes the checkout");
  let current = lexicalRoot;
  for (const component of relative(lexicalRoot, dirname(requested)).split(
    sep,
  )) {
    current = join(current, component);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stats = lstatSync(current);
    assert(
      stats.isDirectory() && !stats.isSymbolicLink(),
      "report output parent is unsafe",
    );
    assert(
      within(resolvedRoot, realpathSync(current)),
      "report output parent escapes the checkout",
    );
  }
  return requested;
}

export function writeReport(root, output, report) {
  const path = ensureOutputParent(root, output);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  root = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
} = {}) {
  const args = parseCanonicalArgs(argv);
  const identity = readRunIdentity(env);
  assertSourceCheckout(root, identity);
  const currentRun = await resolveCurrentRun(identity, fetchImpl);
  const attemptProvenance = await resolveAttemptProvenance(
    identity,
    currentRun.runAttemptStartedAt,
    fetchImpl,
  );
  const artifact = await resolveReleaseArtifact(
    identity,
    attemptProvenance,
    fetchImpl,
  );
  const releaseSubject = inspectReleaseSubject(
    root,
    identity.releaseTag,
    artifact,
    identity.releaseArtifactDownloadPath,
  );
  const modelArtifact = await downloadAndVerifyModel(CANONICAL_MODEL, {
    fetchImpl,
  });
  const report = buildReport({
    root,
    identity,
    artifact,
    attemptProvenance,
    releaseSubject,
    modelArtifact,
  });
  writeReport(root, args.output, report);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
