#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_VERIFICATION_DIRECTORY,
  CANONICAL_ARTIFACT_VERIFICATION_ASSETS,
  CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  CANONICAL_RELEASE_SAFETY_ASSET_PATHS,
  RELEASE_CLAIM_CI_ARTIFACT_FILES,
} from "./release-constants.mjs";

const READ_ATTEMPTS = 3;
const REDRAFT_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

function withTimeout(options) {
  return { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function readJsonWithRetry({ fetchImpl, url, headers, operation }) {
  let lastError;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, withTimeout({ headers }));
      if (!response.ok)
        throw new Error(`${operation} returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${operation} failed after ${READ_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function resolveReleaseTagCommit({
  repository,
  tag,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !tag || !token)
    throw new Error("GitHub release context is required");

  const headers = githubHeaders(token);
  const api = `https://api.github.com/repos/${repository}`;
  const ref = await readJsonWithRetry({
    fetchImpl,
    url: `${api}/git/ref/tags/${encodeURIComponent(tag)}`,
    headers,
    operation: "release tag lookup",
  });
  let object = ref?.object;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (object?.type === "commit" && /^[a-f0-9]{40}$/i.test(object.sha ?? ""))
      return object.sha.toLowerCase();
    if (
      object?.type !== "tag" ||
      !/^[a-f0-9]{40}$/i.test(object.sha ?? "") ||
      visited.has(object.sha)
    )
      break;
    visited.add(object.sha);
    const annotated = await readJsonWithRetry({
      fetchImpl,
      url: `${api}/git/tags/${object.sha}`,
      headers,
      operation: "annotated release tag lookup",
    });
    object = annotated?.object;
  }
  throw new Error(`release tag ${tag} does not resolve to a commit`);
}

export async function assertReleaseTagTargetsCommit(context) {
  const resolved = await resolveReleaseTagCommit(context);
  const expected = String(context.commit ?? "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(expected))
    throw new Error("release commit must be a full 40-character SHA");
  if (resolved !== expected)
    throw new Error(
      `release tag ${context.tag} resolves to ${resolved}, not ${expected}`,
    );
}

export async function assertReleaseCommitOnMain({
  repository,
  commit,
  token,
  fetchImpl = globalThis.fetch,
}) {
  const expected = String(commit ?? "").toLowerCase();
  if (!repository || !token)
    throw new Error("GitHub release context is required");
  if (!/^[a-f0-9]{40}$/.test(expected))
    throw new Error("release commit must be a full 40-character SHA");

  const comparison = await readJsonWithRetry({
    fetchImpl,
    url: `https://api.github.com/repos/${repository}/compare/${expected}...main`,
    headers: githubHeaders(token),
    operation: "release commit main ancestry lookup",
  });
  if (
    !["ahead", "identical"].includes(comparison?.status) ||
    String(comparison?.merge_base_commit?.sha ?? "").toLowerCase() !== expected
  )
    throw new Error(
      `release commit ${expected} is not an ancestor of the current main branch`,
    );
}

export async function assertReleaseSource(context) {
  await assertReleaseTagTargetsCommit(context);
  await assertReleaseCommitOnMain(context);
}

export async function assertReleaseTagAbsent({
  repository,
  tag,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !tag || !token)
    throw new Error("GitHub release context is required");

  const headers = githubHeaders(token);
  const api = `https://api.github.com/repos/${repository}`;
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchImpl(
      `${api}/releases?per_page=100&page=${page}`,
      withTimeout({ headers }),
    );
    if (!response.ok)
      throw new Error(
        `release inventory lookup returned HTTP ${response.status}`,
      );
    const releases = await response.json();
    if (!Array.isArray(releases))
      throw new Error("release inventory response was not an array");
    if (releases.some((release) => release?.tag_name === tag))
      throw new Error(
        `release tag ${tag} already exists; refusing to update an existing draft or public release`,
      );
    if (releases.length < 100) return;
  }
  throw new Error("release inventory exceeded the fail-safe pagination limit");
}

async function getReleaseById({ api, releaseId, headers, fetchImpl }) {
  return readJsonWithRetry({
    fetchImpl,
    url: `${api}/releases/${releaseId}`,
    headers,
    operation: "release-by-ID lookup",
  });
}

async function redraftAndFail({
  api,
  releaseId,
  headers,
  fetchImpl,
  releaseMatches,
  reason,
}) {
  let lastError;
  for (let attempt = 1; attempt <= REDRAFT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(
        `${api}/releases/${releaseId}`,
        withTimeout({
          method: "PATCH",
          headers: {
            ...headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ draft: true }),
        }),
      );
      if (!response.ok)
        throw new Error(`fail-safe re-draft returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    try {
      const release = await getReleaseById({
        api,
        releaseId,
        headers,
        fetchImpl,
      });
      if (releaseMatches(release, true))
        throw new Error(`${reason}; release was returned to draft`);
      lastError = new Error(
        "release-by-ID check did not confirm the exact draft",
      );
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("returned to draft"))
        throw error;
      lastError = error;
    }
  }
  throw new Error(
    `${reason}; unable to confirm fail-safe re-draft after ${REDRAFT_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function publishVerifiedDraft({
  manifestPath,
  repository,
  tag,
  commit,
  releaseId,
  expectedManifestSha256,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (
    !manifestPath ||
    !repository ||
    !tag ||
    !commit ||
    !token ||
    !/^[a-f0-9]{64}$/u.test(expectedManifestSha256 ?? "")
  )
    throw new Error("manifest path and GitHub release context are required");
  const numericReleaseId = Number(releaseId);
  if (!Number.isSafeInteger(numericReleaseId) || numericReleaseId <= 0)
    throw new Error("a positive GitHub release ID is required");

  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  if (manifestSha256 !== expectedManifestSha256)
    throw new Error("evidence manifest changed after publication verification");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.repository !== repository ||
    manifest.tag !== tag ||
    manifest.releaseCommit !== commit
  )
    throw new Error("evidence manifest is not bound to this release context");

  const expected = new Map();
  for (const artifact of manifest.releaseAssets ?? []) {
    for (const subject of artifact.subjects ?? []) {
      if (expected.has(subject.name))
        throw new Error(
          `duplicate flattened release asset name: ${subject.name}`,
        );
      expected.set(subject.name, subject.sha256);
    }
  }
  const canonicalVerificationAssets = new Map(
    CANONICAL_ARTIFACT_VERIFICATION_ASSETS,
  );
  const seenVerificationKinds = new Set();
  for (const asset of manifest.verificationAssets ?? []) {
    const canonicalKind = canonicalVerificationAssets.get(asset?.name);
    const expectedKind =
      canonicalKind ??
      (/^[a-f0-9]{64}\.attestation\.jsonl$/.test(asset?.name ?? "")
        ? "provenance-bundle"
        : null);
    if (
      !expectedKind ||
      asset.kind !== expectedKind ||
      asset.path !== `${ARTIFACT_VERIFICATION_DIRECTORY}/${asset.name}` ||
      !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")
    )
      throw new Error("invalid artifact-verification asset in manifest");
    if (expected.has(asset.name))
      throw new Error(
        `artifact-verification asset name conflicts with ${asset.name}`,
      );
    expected.set(asset.name, asset.sha256);
    seenVerificationKinds.add(asset.kind);
  }
  for (const [, kind] of CANONICAL_ARTIFACT_VERIFICATION_ASSETS) {
    if (!seenVerificationKinds.has(kind))
      throw new Error(`missing artifact-verification ${kind} asset`);
  }
  if (!seenVerificationKinds.has("provenance-bundle"))
    throw new Error("missing artifact-verification provenance bundles");
  const durableReports = new Map();
  const canonicalDurableReports = new Set(
    CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  );
  for (const evidence of manifest.evidence ?? []) {
    const reportPath = evidence?.reportPath;
    const reportSha256 = evidence?.reportSha256;
    if (!canonicalDurableReports.has(reportPath))
      throw new Error(`unexpected durable evidence report path: ${reportPath}`);
    if (!/^[a-f0-9]{64}$/.test(reportSha256 ?? ""))
      throw new Error(`invalid durable evidence digest for ${reportPath}`);
    const previous = durableReports.get(reportPath);
    if (previous && previous !== reportSha256)
      throw new Error(`conflicting durable evidence digests for ${reportPath}`);
    durableReports.set(reportPath, reportSha256);
  }
  for (const reportPath of CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS) {
    if (!durableReports.has(reportPath))
      throw new Error(`missing durable evidence report: ${reportPath}`);
    const reportName = basename(reportPath);
    if (expected.has(reportName))
      throw new Error(
        `durable evidence asset name conflicts with ${reportName}`,
      );
    expected.set(reportName, durableReports.get(reportPath));
  }
  const safetyFiles = manifest.ciEvidenceArtifact?.files;
  if (!Array.isArray(safetyFiles))
    throw new Error("CI safety evidence asset inventory is missing");
  const safetyFilesByPath = new Map(
    safetyFiles.map((file) => [file?.path, file]),
  );
  const canonicalCiPaths = RELEASE_CLAIM_CI_ARTIFACT_FILES.map(
    ({ downloadedPath }) => downloadedPath,
  );
  if (
    safetyFilesByPath.size !== safetyFiles.length ||
    safetyFiles.length !== canonicalCiPaths.length ||
    canonicalCiPaths.some((path) => !safetyFilesByPath.has(path))
  )
    throw new Error("CI safety evidence asset inventory is not canonical");
  if (
    safetyFilesByPath.get("artifacts/release-claims-ci/result.json")?.sha256 !==
    durableReports.get("artifacts/release-claims-ci/result.json")
  )
    throw new Error("CI result digest conflicts with durable evidence");
  for (const path of CANONICAL_RELEASE_SAFETY_ASSET_PATHS) {
    const file = safetyFilesByPath.get(path);
    if (!file || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? ""))
      throw new Error(`missing CI safety evidence release asset: ${path}`);
    const name = basename(path);
    if (expected.has(name))
      throw new Error(`CI safety evidence asset name conflicts with ${name}`);
    expected.set(name, file.sha256);
  }
  const manifestName = basename(manifestPath);
  if (expected.has(manifestName))
    throw new Error(
      `release subject conflicts with evidence manifest: ${manifestName}`,
    );
  expected.set(manifestName, manifestSha256);

  const headers = githubHeaders(token);
  const api = `https://api.github.com/repos/${repository}`;
  const releaseMatches = (release, draft) => {
    if (
      release?.id !== numericReleaseId ||
      release?.tag_name !== tag ||
      release?.draft !== draft ||
      release?.prerelease !== true
    )
      return false;
    const actual = new Map();
    for (const asset of release.assets ?? []) {
      if (actual.has(asset.name)) return false;
      actual.set(
        asset.name,
        String(asset.digest ?? "").replace(/^sha256:/, ""),
      );
    }
    return (
      actual.size === expected.size &&
      [...expected].every(([name, digest]) => actual.get(name) === digest)
    );
  };

  const draft = await getReleaseById({
    api,
    releaseId: numericReleaseId,
    headers,
    fetchImpl,
  });
  if (!releaseMatches(draft, true))
    throw new Error(
      "draft metadata and assets do not exactly match the verified evidence manifest",
    );

  // target_commitish is ignored when a release tag already exists. Resolve the
  // Git ref itself immediately before the one and only publication request.
  await assertReleaseSource({
    repository,
    tag,
    commit,
    token,
    fetchImpl,
  });

  let published;
  let publishError;
  try {
    const response = await fetchImpl(
      `${api}/releases/${numericReleaseId}`,
      withTimeout({
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ draft: false }),
      }),
    );
    if (!response.ok)
      throw new Error(`draft publication returned HTTP ${response.status}`);
    published = await response.json();
  } catch (error) {
    publishError = error;
  }

  // Never repeat draft:false: a lost response is an ambiguous commit. Resolve
  // by ID, and use only the idempotent draft:true transition on any mismatch.
  if (!releaseMatches(published, false)) {
    try {
      const reconciled = await getReleaseById({
        api,
        releaseId: numericReleaseId,
        headers,
        fetchImpl,
      });
      if (releaseMatches(reconciled, true))
        throw new Error(
          `publication was not confirmed and the release remains a draft: ${publishError instanceof Error ? publishError.message : "unexpected publication response"}`,
        );
      if (releaseMatches(reconciled, false)) published = reconciled;
      else
        await redraftAndFail({
          api,
          releaseId: numericReleaseId,
          headers,
          fetchImpl,
          releaseMatches,
          reason: "GitHub did not confirm the exact expected publication",
        });
    } catch (error) {
      if (error instanceof Error && error.message.includes("remains a draft"))
        throw error;
      if (error instanceof Error && error.message.includes("returned to draft"))
        throw error;
      await redraftAndFail({
        api,
        releaseId: numericReleaseId,
        headers,
        fetchImpl,
        releaseMatches,
        reason: `publication outcome was ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  try {
    const confirmed = await getReleaseById({
      api,
      releaseId: numericReleaseId,
      headers,
      fetchImpl,
    });
    if (!releaseMatches(confirmed, false))
      throw new Error(
        "published release changed during publication verification",
      );
    await assertReleaseSource({
      repository,
      tag,
      commit,
      token,
      fetchImpl,
    });
  } catch (error) {
    await redraftAndFail({
      api,
      releaseId: numericReleaseId,
      headers,
      fetchImpl,
      releaseMatches,
      reason: `published release confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const context = {
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    commit: process.env.GITHUB_SHA,
    releaseId: process.env.RELEASE_ID,
    expectedManifestSha256: process.env.RELEASE_EVIDENCE_MANIFEST_SHA256,
    token: process.env.GITHUB_TOKEN,
  };
  if (mode === "--assert-absent") await assertReleaseTagAbsent(context);
  else if (mode === "--assert-tag-target") await assertReleaseSource(context);
  else
    await publishVerifiedDraft({
      ...context,
      manifestPath: mode,
    });
}
