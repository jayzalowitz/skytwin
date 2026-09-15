#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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
    name: "Apache License 2.0",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
  }),
});

const WORKFLOW_PATH = ".github/workflows/build.yml";
const RELEASE_ARTIFACT_NAME = "SkyTwin-Linux-AppImage";
const RELEASE_ARTIFACT_KIND = "desktop-installer";
const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_SUBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const TAG =
  /^v(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}(?:(?:\.(?:0|[1-9][0-9]{0,8}))|-beta(?:\.[1-9][0-9]{0,8})?)$/u;

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
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every(
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
  return {
    sourceCommit,
    repository,
    releaseTag,
    ref,
    runId,
    runAttempt,
    token,
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
  return run;
}

export async function resolveReleaseArtifact(
  identity,
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
    (artifact) => artifact?.name === RELEASE_ARTIFACT_NAME,
  );
  assert(
    matches.length === 1,
    "expected one current-run Linux AppImage artifact",
  );
  const artifact = matches[0];
  const digest = String(artifact.digest ?? "").replace(/^sha256:/u, "");
  assert(
    Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.expired === false &&
      SHA256.test(digest) &&
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
  return {
    artifactId: artifact.id,
    artifactName: RELEASE_ARTIFACT_NAME,
    artifactSha256: digest,
    kind: RELEASE_ARTIFACT_KIND,
  };
}

function executeGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function assertSourceCheckout(root, identity, git = executeGit) {
  const head = git(["rev-parse", "HEAD"], root).trim();
  assert(
    head === identity.sourceCommit,
    "GITHUB_SHA does not match checked-out HEAD",
  );
  const status = git(
    ["status", "--porcelain=v1", "--untracked-files=no"],
    root,
  );
  assert(
    status === "",
    "model verifier requires an unmodified tracked checkout",
  );
}

export function inspectReleaseSubject(root, releaseTag, artifact) {
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
  const directory = resolve(root, "artifacts", RELEASE_ARTIFACT_NAME);
  const directoryStat = lstatSync(directory);
  assert(
    directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
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
      model.license.url ===
        `https://huggingface.co/${model.repository}/blob/${model.revision}/LICENSE`,
    "model license is not pinned to the immutable source revision",
  );
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
      license: model.license.spdxId,
      licenseName: model.license.name,
      licenseUrl: model.license.url,
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
    repository: identity.repository,
    ref: identity.ref,
    releaseArtifactKind: artifact.kind,
    releaseArtifactId: artifact.artifactId,
    releaseArtifactName: artifact.artifactName,
    releaseArtifactSha256: artifact.artifactSha256,
    subjectName: releaseSubject.name,
    subjectPath: releaseSubject.relativePath,
    subjectSha256: releaseSubject.sha256,
    producerJobName: machineProducerJobName(CLAIM_ID, "linux"),
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
        "The model license is tied to the same immutable source revision",
        `${modelArtifact.license} at ${modelArtifact.licenseUrl}`,
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
  await resolveCurrentRun(identity, fetchImpl);
  const artifact = await resolveReleaseArtifact(identity, fetchImpl);
  const releaseSubject = inspectReleaseSubject(
    root,
    identity.releaseTag,
    artifact,
  );
  const modelArtifact = await downloadAndVerifyModel(CANONICAL_MODEL, {
    fetchImpl,
  });
  const report = buildReport({
    root,
    identity,
    artifact,
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
