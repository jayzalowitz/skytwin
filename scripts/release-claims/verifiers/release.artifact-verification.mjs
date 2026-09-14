#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import {
  ARTIFACT_VERIFICATION_DIRECTORY,
  CANONICAL_RELEASE_ASSETS,
  machineProducerJobName,
  machineVerifierCommand,
  machineVerifierPath,
} from "../release-constants.mjs";
import {
  buildCanonicalVerificationInstructions,
  isValidSpdx23Document,
} from "../check-release-claims.mjs";

export const CLAIM_ID = "release.artifact-verification";
export const CHECK_IDS = Object.freeze([
  "release.asset-set",
  "release.checksums",
  "release.sbom",
  "release.provenance",
  "release.verification-instructions",
]);

const WORKFLOW_PATH = ".github/workflows/build.yml";
const REPORT_PATH = `.release-evidence/reports/${CLAIM_ID}.json`;
const MAX_API_BYTES = 16 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_UPDATE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;
const MAX_SBOM_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const VERSION_SEGMENT = "(?:0|[1-9][0-9]{0,8})";
const FOUR_SEGMENT_TAG = new RegExp(
  `^v(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})$`,
);
const BETA_TAG = new RegExp(
  `^v(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})-beta(?:\\.([1-9][0-9]{0,8}))?$`,
);

const ARTIFACT_RULES = new Map([
  [
    "SkyTwin-macOS-dmg",
    { platform: "macos", pattern: /^SkyTwin-APP_VERSION-(?:arm64|x64)\.dmg$/u },
  ],
  [
    "SkyTwin-macOS-zip",
    { platform: "macos", pattern: /^SkyTwin-APP_VERSION-(?:arm64|x64)\.zip$/u },
  ],
  [
    "SkyTwin-macOS-update-manifest",
    {
      platform: "macos",
      pattern: /^latest-mac\.yml$/u,
      updateArtifactName: "SkyTwin-macOS-zip",
    },
  ],
  [
    "SkyTwin-Windows-installer",
    { platform: "windows", pattern: /^SkyTwin Setup APP_VERSION\.exe$/u },
  ],
  [
    "SkyTwin-Windows-update-manifest",
    {
      platform: "windows",
      pattern: /^latest\.yml$/u,
      updateArtifactName: "SkyTwin-Windows-installer",
    },
  ],
  [
    "SkyTwin-Linux-AppImage",
    { platform: "linux", pattern: /^SkyTwin-APP_VERSION\.AppImage$/u },
  ],
  [
    "SkyTwin-Linux-deb",
    {
      platform: "linux",
      pattern: /^skytwin-desktop_APP_VERSION_(?:amd64|arm64)\.deb$/u,
    },
  ],
  [
    "SkyTwin-Linux-rpm",
    {
      platform: "linux",
      pattern: /^skytwin-desktop-APP_VERSION\.(?:x86_64|aarch64)\.rpm$/u,
    },
  ],
  [
    "SkyTwin-Linux-update-manifest",
    {
      platform: "linux",
      pattern: /^latest-linux\.yml$/u,
      updateArtifactName: "SkyTwin-Linux-AppImage",
    },
  ],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameSet(actual, expected) {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
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

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (field) => left[field] === right[field],
  );
}

export function inspectStableRegularFile(
  rootPath,
  requestedPath,
  description,
  maximumBytes = MAX_SUBJECT_BYTES,
  testHooks = {},
) {
  const lexicalRoot = resolve(rootPath);
  const requested = resolve(requestedPath);
  assert(within(lexicalRoot, requested), `${description} escapes its root`);
  assertNoSymlinkComponents(lexicalRoot, requested, description);
  const beforePath = lstatSync(requested, { bigint: true });
  assert(
    beforePath.isFile() && !beforePath.isSymbolicLink(),
    `${description} must be a direct regular non-symlink file`,
  );
  assert(
    beforePath.size > 0n && beforePath.size <= BigInt(maximumBytes),
    `${description} size is outside the release bound`,
  );
  const root = realpathSync(lexicalRoot);
  const canonical = realpathSync(requested);
  assert(within(root, canonical), `${description} resolves outside its root`);
  const descriptor = openSync(
    requested,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert(
      before.isFile() && sameFileIdentity(before, beforePath),
      `${description} changed before hashing`,
    );
    testHooks.afterOpen?.({ descriptor, requested });
    const digest1 = createHash("sha1");
    const digest256 = createHash("sha256");
    const digest512 = createHash("sha512");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, position);
      if (count === 0) break;
      position += count;
      assert(
        position <= maximumBytes,
        `${description} exceeded the release size bound while hashing`,
      );
      digest1.update(buffer.subarray(0, count));
      digest256.update(buffer.subarray(0, count));
      digest512.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(requested, { bigint: true });
    assert(
      afterPath.isFile() && !afterPath.isSymbolicLink(),
      `${description} was replaced while hashing`,
    );
    assert(
      sameFileIdentity(before, after) && sameFileIdentity(after, afterPath),
      `${description} changed while hashing`,
    );
    assert(
      BigInt(position) === after.size,
      `${description} size changed while hashing`,
    );
    return {
      path: requested,
      name: basename(requested),
      sizeBytes: position,
      sha1: digest1.digest("hex"),
      sha256: digest256.digest("hex"),
      sha512: digest512.digest("base64"),
      device: Number(after.dev),
      inode: Number(after.ino),
    };
  } finally {
    closeSync(descriptor);
  }
}

function escapedPattern(pattern, appVersion) {
  const escaped = appVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    pattern.source.replace("APP_VERSION", escaped),
    pattern.flags,
  );
}

export function normalizeReleaseVersion(releaseTag) {
  const match =
    releaseTag.match(FOUR_SEGMENT_TAG) ?? releaseTag.match(BETA_TAG);
  assert(match, "release tag is not a canonical four-segment or beta tag");
  const [, major, minor, patch, rawBuild] = match;
  const build = rawBuild ?? "0";
  assert(
    Number(build) < 100 && Number(patch) <= 999999,
    "release tag cannot be represented as an app version",
  );
  return {
    repositoryVersion: `${major}.${minor}.${patch}.${build}`,
    appVersion: `${major}.${minor}.${Number(patch) * 100 + Number(build)}`,
  };
}

export function assertSourceCheckout({
  root,
  sourceCommit,
  releaseTag,
  executeGit,
}) {
  assert(
    /^[0-9a-f]{40}$/.test(sourceCommit),
    "source commit must be a full lowercase Git SHA",
  );
  const head = executeGit(["rev-parse", "HEAD"], root).trim();
  assert(
    head === sourceCommit,
    `source commit ${sourceCommit} does not match checked-out HEAD ${head}`,
  );
  // Downloaded artifacts and evidence are intentionally untracked. Reject any
  // index/worktree mutation of source, while allowing those expected inputs.
  const status = executeGit(
    ["status", "--porcelain=v1", "--untracked-files=no"],
    root,
  );
  assert(
    status === "",
    "release verifier requires an unmodified tracked source checkout",
  );
  const versions = normalizeReleaseVersion(releaseTag);
  const versionFile = readFileSync(join(root, "VERSION"), "utf8").trim();
  const packageVersion = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  assert(
    versionFile === versions.repositoryVersion,
    `VERSION ${versionFile} does not match release tag ${releaseTag}`,
  );
  assert(
    packageVersion === versions.repositoryVersion,
    `package.json version ${packageVersion} does not match release tag ${releaseTag}`,
  );
  return versions;
}

function defaultExecuteGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function readRunIdentity(env = process.env) {
  assert(
    env.RUNNER_OS === "Linux",
    "release artifact verifier must run on a Linux runner",
  );
  assert(
    env.RUNNER_ARCH === "X64",
    "release artifact verifier must run on an x64 runner",
  );
  const sourceCommit = env.GITHUB_SHA;
  const repository = env.GITHUB_REPOSITORY;
  const releaseTag = env.GITHUB_REF_NAME;
  const ref = env.GITHUB_REF;
  const runId = Number(env.GITHUB_RUN_ID);
  assert(/^[0-9a-f]{40}$/.test(sourceCommit ?? ""), "GITHUB_SHA is invalid");
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? ""),
    "GITHUB_REPOSITORY is invalid",
  );
  assert(typeof releaseTag === "string", "GITHUB_REF_NAME is missing");
  normalizeReleaseVersion(releaseTag);
  assert(
    ref === `refs/tags/${releaseTag}`,
    "GITHUB_REF does not identify the release tag exactly",
  );
  assert(
    Number.isSafeInteger(runId) && runId > 0,
    "GITHUB_RUN_ID must be a positive integer",
  );
  assert(
    typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length >= 20,
    "GITHUB_TOKEN is required",
  );
  return {
    sourceCommit,
    repository,
    releaseTag,
    ref,
    runId,
    token: env.GITHUB_TOKEN,
  };
}

async function responseJson(response, description) {
  assert(
    response?.ok === true,
    `${description} returned HTTP ${response?.status ?? "unknown"}`,
  );
  const reader = response.body?.getReader();
  assert(reader, `${description} returned an empty response body`);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_API_BYTES) {
      await reader.cancel();
      throw new Error(
        `${description} response size is outside the release bound`,
      );
    }
    chunks.push(value);
  }
  assert(size > 0, `${description} response size is outside the release bound`);
  const bytes = Buffer.concat(chunks, size);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

async function githubJson(repository, path, token, fetchImpl) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "skytwin-release-machine-verifier",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  return responseJson(response, `GitHub API ${path}`);
}

export async function resolveCurrentRunArtifacts(
  identity,
  fetchImpl = globalThis.fetch,
) {
  const run = await githubJson(
    identity.repository,
    `/actions/runs/${identity.runId}`,
    identity.token,
    fetchImpl,
  );
  assert(
    run.id === identity.runId &&
      run.repository?.full_name === identity.repository &&
      run.head_sha === identity.sourceCommit &&
      run.head_branch === identity.releaseTag &&
      run.event === "push" &&
      run.path === WORKFLOW_PATH,
    "current workflow run is not the canonical tag-push build for this repository and commit",
  );
  const page = await githubJson(
    identity.repository,
    `/actions/runs/${identity.runId}/artifacts?per_page=100&page=1`,
    identity.token,
    fetchImpl,
  );
  assert(
    Array.isArray(page?.artifacts) && Number.isSafeInteger(page.total_count),
    "GitHub artifact inventory is malformed",
  );
  assert(
    page.total_count <= 100 && page.artifacts.length === page.total_count,
    "GitHub artifact inventory is paginated or incomplete",
  );
  const resolved = new Map();
  for (const [artifactName, kind] of CANONICAL_RELEASE_ASSETS) {
    const matches = page.artifacts.filter(
      (artifact) => artifact?.name === artifactName,
    );
    assert(
      matches.length === 1,
      `expected exactly one current-run ${artifactName} artifact, found ${matches.length}`,
    );
    const artifact = matches[0];
    assert(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        artifact.expired === false,
      `${artifactName} artifact identity is invalid or expired`,
    );
    const digest = String(artifact.digest ?? "").replace(/^sha256:/u, "");
    assert(
      /^[0-9a-f]{64}$/.test(digest),
      `${artifactName} artifact digest is invalid`,
    );
    assert(
      artifact.workflow_run?.id === identity.runId &&
        artifact.workflow_run?.head_sha === identity.sourceCommit,
      `${artifactName} artifact is not bound to the current run and commit`,
    );
    const detail = await githubJson(
      identity.repository,
      `/actions/artifacts/${artifact.id}`,
      identity.token,
      fetchImpl,
    );
    assert(
      detail.id === artifact.id &&
        detail.name === artifactName &&
        detail.expired === false &&
        detail.digest === `sha256:${digest}` &&
        detail.workflow_run?.id === identity.runId &&
        detail.workflow_run?.head_sha === identity.sourceCommit,
      `${artifactName} artifact detail disagrees with the current-run inventory`,
    );
    resolved.set(artifactName, {
      artifactId: artifact.id,
      artifactSha256: digest,
      artifactName,
      kind,
    });
  }
  return resolved;
}

export function inspectCanonicalSubjects(rootPath, appVersion) {
  const root = realpathSync(resolve(rootPath));
  const seenNames = new Set();
  const subjects = new Map();
  for (const [artifactName, kind] of CANONICAL_RELEASE_ASSETS) {
    const rule = ARTIFACT_RULES.get(artifactName);
    assert(rule, `missing verifier rule for ${artifactName}`);
    const directory = resolve(root, "artifacts", artifactName);
    assert(
      within(root, directory),
      `${artifactName} directory escapes the checkout`,
    );
    const directoryStat = lstatSync(directory);
    assert(
      directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
      `${artifactName} must be a direct real directory`,
    );
    const canonicalDirectory = realpathSync(directory);
    assert(
      within(root, canonicalDirectory),
      `${artifactName} directory resolves outside the checkout`,
    );
    const entries = readdirSync(directory, { withFileTypes: true });
    assert(
      entries.length === 1,
      `${artifactName} must contain exactly one direct subject`,
    );
    const entry = entries[0];
    assert(
      entry.isFile() &&
        !entry.isSymbolicLink() &&
        basename(entry.name) === entry.name,
      `${artifactName} subject must be a direct regular non-symlink file`,
    );
    const pattern = escapedPattern(rule.pattern, appVersion);
    assert(
      pattern.test(entry.name),
      `${artifactName} has unexpected filename ${entry.name}`,
    );
    assert(
      !seenNames.has(entry.name),
      `duplicate published subject filename ${entry.name}`,
    );
    seenNames.add(entry.name);
    const subject = inspectStableRegularFile(
      root,
      join(directory, entry.name),
      `${artifactName} subject`,
      kind === "update-manifest"
        ? MAX_UPDATE_MANIFEST_BYTES
        : MAX_SUBJECT_BYTES,
    );
    subjects.set(artifactName, {
      ...subject,
      artifactName,
      kind,
      platform: rule.platform,
      relativePath: `artifacts/${artifactName}/${entry.name}`,
    });
  }
  return subjects;
}

function parseUpdateManifest(path, description) {
  const contents = readFileSync(path, "utf8");
  const document = parseDocument(contents, {
    maxAliasCount: 0,
    uniqueKeys: true,
  });
  assert(
    document.errors.length === 0 && document.warnings.length === 0,
    `${description} is not strict YAML`,
  );
  const value = document.toJS({ maxAliasCount: 0 });
  assert(isRecord(value), `${description} must be a YAML mapping`);
  assert(
    typeof value.version === "string" && Array.isArray(value.files),
    `${description} is missing version or files`,
  );
  assert(
    typeof value.path === "string" && typeof value.sha512 === "string",
    `${description} is missing its primary target identity`,
  );
  return value;
}

export function verifyUpdateManifests(subjects, appVersion) {
  const byFilename = new Map(
    [...subjects.values()].map((subject) => [subject.name, subject]),
  );
  for (const subject of subjects.values()) {
    if (subject.kind !== "update-manifest") continue;
    const rule = ARTIFACT_RULES.get(subject.artifactName);
    const value = parseUpdateManifest(subject.path, subject.artifactName);
    assert(
      value.version === appVersion,
      `${subject.artifactName} version does not match ${appVersion}`,
    );
    assert(
      value.files.length === 1,
      `${subject.artifactName} must identify exactly one canonical update target`,
    );
    const seen = new Set();
    for (const entry of value.files) {
      assert(
        isRecord(entry),
        `${subject.artifactName} has malformed update target metadata`,
      );
      const allowedKeys = Object.keys(entry).every((key) =>
        ["url", "sha512", "size", "blockMapSize"].includes(key),
      );
      assert(
        allowedKeys,
        `${subject.artifactName} has unsupported update target metadata`,
      );
      assert(
        typeof entry.url === "string" &&
          basename(entry.url) === entry.url &&
          !seen.has(entry.url),
        `${subject.artifactName} has an unsafe or duplicate update target`,
      );
      seen.add(entry.url);
      const target = byFilename.get(entry.url);
      assert(
        target &&
          target.platform === subject.platform &&
          target.kind !== "update-manifest",
        `${subject.artifactName} references a noncanonical target ${entry.url}`,
      );
      assert(
        entry.sha512 === target.sha512,
        `${subject.artifactName} has stale SHA-512 for ${entry.url}`,
      );
      assert(
        entry.size === undefined ||
          (Number.isSafeInteger(entry.size) && entry.size === target.sizeBytes),
        `${subject.artifactName} has stale size for ${entry.url}`,
      );
      if (entry.blockMapSize !== undefined)
        assert(
          Number.isSafeInteger(entry.blockMapSize) && entry.blockMapSize > 0,
          `${subject.artifactName} has invalid block map size`,
        );
    }
    const primary = byFilename.get(value.path);
    const expectedPrimary = subjects.get(rule.updateArtifactName);
    assert(
      primary &&
        expectedPrimary &&
        primary.artifactName === rule.updateArtifactName &&
        primary.path === expectedPrimary.path &&
        seen.has(primary.name),
      `${subject.artifactName} primary update target is not canonical`,
    );
    assert(
      value.sha512 === primary.sha512,
      `${subject.artifactName} primary SHA-512 is stale`,
    );
  }
}

function directMaterial(root, filename, maximumBytes) {
  return inspectStableRegularFile(
    root,
    join(root, ARTIFACT_VERIFICATION_DIRECTORY, filename),
    `artifact-verification material ${filename}`,
    maximumBytes,
  );
}

function verifyChecksums(material, subjects) {
  const expected =
    [...subjects.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((subject) => `${subject.sha256}  ${subject.name}`)
      .join("\n") + "\n";
  assert(
    readFileSync(material.path, "utf8") === expected,
    "SHA256SUMS does not exactly cover the canonical subjects",
  );
}

function spdxFileMatchesSubject(file, subject) {
  return (
    file?.fileName === subject.name &&
    Array.isArray(file?.checksums) &&
    file.checksums.some(
      (checksum) =>
        checksum?.algorithm === "SHA256" &&
        checksum?.checksumValue === subject.sha256,
    )
  );
}

function verifySpdx(material, subjects, identity) {
  let sbom;
  try {
    sbom = JSON.parse(readFileSync(material.path, "utf8"));
  } catch {
    throw new Error("release.spdx.json is not valid JSON");
  }
  assert(
    isValidSpdx23Document(sbom),
    "release.spdx.json does not satisfy the SPDX 2.3 structural contract",
  );
  const encodedTag = encodeURIComponent(identity.releaseTag);
  const expectedReleaseUrl = `https://github.com/${identity.repository}/releases/tag/${encodedTag}`;
  const expectedNamespace = `${expectedReleaseUrl}/spdx/${identity.sourceCommit}`;
  const expectedVcs = `git+https://github.com/${identity.repository}.git@${identity.sourceCommit}`;
  assert(
    sbom.documentNamespace === expectedNamespace &&
      sbom.name === `SkyTwin desktop ${identity.releaseTag}` &&
      sameSet(sbom.creationInfo.creators, [
        "Organization: SkyTwin",
        "Tool: SkyTwin release artifact material generator",
      ]),
    "release.spdx.json is not bound to the source repository and commit",
  );
  assert(
    sbom.packages.length === 1,
    "release.spdx.json must describe exactly one release package",
  );
  const releasePackage = sbom.packages[0];
  assert(
    releasePackage.name === "SkyTwin desktop release artifacts" &&
      releasePackage.versionInfo === identity.appVersion &&
      releasePackage.downloadLocation === expectedReleaseUrl &&
      releasePackage.sourceInfo ===
        `Built from Git commit ${identity.sourceCommit} at ${identity.ref}.` &&
      releasePackage.comment ===
        `Release artifact set for ${identity.releaseTag}; generated by GitHub Actions run ${identity.runId}.` &&
      Array.isArray(releasePackage.externalRefs) &&
      releasePackage.externalRefs.length === 1 &&
      releasePackage.externalRefs[0]?.referenceCategory === "OTHER" &&
      releasePackage.externalRefs[0]?.referenceType === "vcs" &&
      releasePackage.externalRefs[0]?.referenceLocator === expectedVcs,
    "release.spdx.json package is not exactly bound to the release source",
  );
  const described = new Set(sbom.documentDescribes);
  const describesRelationships = sbom.relationships.filter(
    (relationship) =>
      relationship.spdxElementId === sbom.SPDXID &&
      relationship.relationshipType === "DESCRIBES" &&
      relationship.relatedSpdxElement === releasePackage.SPDXID,
  );
  const contained = new Set(
    sbom.relationships
      .filter(
        (relationship) =>
          described.has(relationship.spdxElementId) &&
          relationship.relationshipType === "CONTAINS",
      )
      .map((relationship) => relationship.relatedSpdxElement),
  );
  assert(
    describesRelationships.length === 1 &&
      sbom.relationships.length === sbom.files.length + 1 &&
      sbom.relationships.every(
        (relationship) =>
          (relationship.spdxElementId === sbom.SPDXID &&
            relationship.relationshipType === "DESCRIBES" &&
            relationship.relatedSpdxElement === releasePackage.SPDXID) ||
          (relationship.spdxElementId === releasePackage.SPDXID &&
            relationship.relationshipType === "CONTAINS" &&
            sbom.files.some(
              (file) => file.SPDXID === relationship.relatedSpdxElement,
            )),
      ),
    "release.spdx.json relationships do not exactly describe and contain the release subjects",
  );
  const covered = new Set();
  const matchedFileIds = new Set();
  for (const file of sbom.files) {
    if (!contained.has(file.SPDXID)) continue;
    for (const subject of subjects.values()) {
      if (!spdxFileMatchesSubject(file, subject)) continue;
      const expectedChecksums = new Map([
        ["SHA1", subject.sha1],
        ["SHA256", subject.sha256],
        ["SHA512", Buffer.from(subject.sha512, "base64").toString("hex")],
      ]);
      const actualChecksums = new Map(
        file.checksums.map((checksum) => [
          checksum.algorithm,
          checksum.checksumValue,
        ]),
      );
      assert(
        file.checksums.length === expectedChecksums.size &&
          actualChecksums.size === expectedChecksums.size &&
          [...expectedChecksums].every(
            ([algorithm, digest]) => actualChecksums.get(algorithm) === digest,
          ),
        `release.spdx.json has stale or incomplete checksums for ${subject.name}`,
      );
      assert(
        !covered.has(subject.relativePath),
        `release.spdx.json covers ${subject.name} more than once`,
      );
      covered.add(subject.relativePath);
      matchedFileIds.add(file.SPDXID);
    }
  }
  assert(
    sameSet(
      [...covered],
      [...subjects.values()].map((subject) => subject.relativePath),
    ) &&
      sameSet(
        [...matchedFileIds],
        sbom.files.map((file) => file.SPDXID),
      ),
    "release.spdx.json does not exactly cover every canonical subject by digest",
  );
  const expectedVerificationCode = createHash("sha1")
    .update(
      [...subjects.values()]
        .map((subject) => subject.sha1)
        .sort()
        .join(""),
    )
    .digest("hex");
  assert(
    releasePackage.packageVerificationCode?.packageVerificationCodeValue ===
      expectedVerificationCode,
    "release.spdx.json package verification code does not match the exact subject bytes",
  );
}

export function canonicalInstructions(subjects, identity) {
  return buildCanonicalVerificationInstructions({
    subjects: [...subjects.values()].map((subject) => ({
      name: subject.name,
      sha256: subject.sha256,
    })),
    repository: identity.repository,
    sourceCommit: identity.sourceCommit,
    sourceRef: identity.ref,
  });
}

export function verifyGitHubArtifactAttestation(
  { subjectPath, bundlePath, identity },
  execute = execFileSync,
  hostEnvironment = process.env,
) {
  const output = execute(
    "gh",
    [
      "attestation",
      "verify",
      subjectPath,
      "--repo",
      identity.repository,
      "--bundle",
      bundlePath,
      "--source-digest",
      identity.sourceCommit,
      "--source-ref",
      identity.ref,
      "--signer-workflow",
      `github.com/${identity.repository}/${WORKFLOW_PATH}`,
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: {
        GH_TOKEN: identity.token,
        PATH: hostEnvironment.PATH ?? "",
        HOME: hostEnvironment.HOME ?? "",
        XDG_CONFIG_HOME: hostEnvironment.XDG_CONFIG_HOME ?? "",
        SSL_CERT_FILE: hostEnvironment.SSL_CERT_FILE ?? "",
        SSL_CERT_DIR: hostEnvironment.SSL_CERT_DIR ?? "",
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const verified = JSON.parse(output);
  assert(
    Array.isArray(verified) && verified.length > 0,
    "GitHub CLI returned no verified provenance attestations",
  );
}

export async function verifyMaterials({
  root,
  subjects,
  identity,
  verifyAttestation = verifyGitHubArtifactAttestation,
}) {
  const directory = resolve(root, ARTIFACT_VERIFICATION_DIRECTORY);
  const directoryStat = lstatSync(directory);
  assert(
    directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
    "artifact-verification materials must be a direct real directory",
  );
  assert(
    within(realpathSync(root), realpathSync(directory)),
    "artifact-verification directory escapes the checkout",
  );
  const expectedNames = [
    "SHA256SUMS",
    "release.spdx.json",
    "VERIFY.md",
    ...new Set(
      [...subjects.values()].map(
        (subject) => `${subject.sha256}.attestation.jsonl`,
      ),
    ),
  ].sort();
  const actualNames = readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      assert(
        entry.isFile() &&
          !entry.isSymbolicLink() &&
          basename(entry.name) === entry.name,
        `unsafe artifact-verification material ${entry.name}`,
      );
      return entry.name;
    })
    .sort();
  assert(
    sameSet(actualNames, expectedNames),
    "artifact-verification material inventory is missing or contains unexpected files",
  );

  const checksums = directMaterial(root, "SHA256SUMS", MAX_CHECKSUM_BYTES);
  const spdx = directMaterial(root, "release.spdx.json", MAX_SBOM_BYTES);
  const instructions = directMaterial(
    root,
    "VERIFY.md",
    MAX_INSTRUCTIONS_BYTES,
  );
  verifyChecksums(checksums, subjects);
  verifySpdx(spdx, subjects, identity);
  assert(
    readFileSync(instructions.path, "utf8") ===
      canonicalInstructions(subjects, identity),
    "VERIFY.md is not the canonical source- and subject-bound guide",
  );

  const bundles = new Map();
  for (const subject of subjects.values()) {
    const filename = `${subject.sha256}.attestation.jsonl`;
    let bundle = bundles.get(filename);
    if (!bundle) {
      bundle = directMaterial(root, filename, MAX_BUNDLE_BYTES);
      bundles.set(filename, bundle);
    }
    await verifyAttestation({
      subjectPath: subject.path,
      bundlePath: bundle.path,
      subject,
      identity,
    });
  }
  for (const material of [checksums, spdx, instructions, ...bundles.values()]) {
    const maximumBytes =
      material.name === "SHA256SUMS"
        ? MAX_CHECKSUM_BYTES
        : material.name === "VERIFY.md"
          ? MAX_INSTRUCTIONS_BYTES
          : material.name === "release.spdx.json"
            ? MAX_SBOM_BYTES
            : MAX_BUNDLE_BYTES;
    const observed = directMaterial(root, material.name, maximumBytes);
    assert(
      observed.sha256 === material.sha256 &&
        observed.sizeBytes === material.sizeBytes &&
        observed.device === material.device &&
        observed.inode === material.inode,
      `${material.name} changed while artifact-verification evidence was collected`,
    );
  }
  return { checksums, spdx, instructions, bundles };
}

function reference(material) {
  return {
    path: `${ARTIFACT_VERIFICATION_DIRECTORY}/${material.name}`,
    sha256: material.sha256,
  };
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
  apiArtifacts,
  subjects,
  materials,
  runtime = process,
}) {
  assert(
    apiArtifacts.size === CANONICAL_RELEASE_ASSETS.length &&
      CANONICAL_RELEASE_ASSETS.every(
        ([artifactName, kind]) =>
          apiArtifacts.get(artifactName)?.artifactName === artifactName &&
          apiArtifacts.get(artifactName)?.kind === kind,
      ),
    "API artifact set is not the exact canonical release set",
  );
  const appImage = subjects.get("SkyTwin-Linux-AppImage");
  const appImageArtifact = apiArtifacts.get("SkyTwin-Linux-AppImage");
  assert(
    appImage && appImageArtifact,
    "canonical Linux AppImage binding is missing",
  );
  const verifierPath = machineVerifierPath(CLAIM_ID);
  const verifierCommand = machineVerifierCommand(CLAIM_ID, "linux");
  assert(
    verifierPath && verifierCommand,
    "canonical verifier metadata is unavailable",
  );
  const verifier = inspectStableRegularFile(
    root,
    resolve(root, verifierPath),
    "canonical release artifact verifier",
    4 * 1024 * 1024,
  );
  const checksumReference = reference(materials.checksums);
  const sbomReference = reference(materials.spdx);
  const instructionsReference = reference(materials.instructions);
  const coveredSubjects = [...subjects.values()]
    .map((subject) => {
      const bundle = materials.bundles.get(
        `${subject.sha256}.attestation.jsonl`,
      );
      return {
        path: subject.relativePath,
        sha256: subject.sha256,
        checksum: {
          ...checksumReference,
          algorithm: "sha256",
          subjectSha256: subject.sha256,
          result: "pass",
        },
        sbom: {
          ...sbomReference,
          format: "spdx-json",
          subjectSha256: subject.sha256,
          result: "pass",
        },
        provenance: {
          verificationMethod: "gh-attestation-verify",
          bundlePath: `${ARTIFACT_VERIFICATION_DIRECTORY}/${bundle.name}`,
          bundleSha256: bundle.sha256,
          sourceCommit: identity.sourceCommit,
          subjectSha256: subject.sha256,
          result: "pass",
        },
        verificationInstructions: {
          ...instructionsReference,
          subjectSha256: subject.sha256,
          result: "pass",
        },
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    releaseTag: identity.releaseTag,
    runId: identity.runId,
    repository: identity.repository,
    ref: identity.ref,
    releaseArtifactKind: appImageArtifact.kind,
    releaseArtifactId: appImageArtifact.artifactId,
    releaseArtifactName: appImageArtifact.artifactName,
    releaseArtifactSha256: appImageArtifact.artifactSha256,
    subjectName: appImage.name,
    subjectPath: appImage.relativePath,
    subjectSha256: appImage.sha256,
    producerJobName: machineProducerJobName(CLAIM_ID, "linux"),
    verifierPath,
    verifierCommand,
    verifierSha256: verifier.sha256,
    schemaVersion: 1,
    generatedBy: "release-machine-verifier",
    claimId: CLAIM_ID,
    result: "pass",
    sourceCommit: identity.sourceCommit,
    platform: "linux",
    runnerPlatform: `${runtime.platform}-${runtime.arch}`,
    coveredSubjects,
    checks: [
      passingCheck(
        CHECK_IDS[0],
        "Exact canonical current-run release artifact set was admitted",
        `${subjects.size} direct subjects across ${apiArtifacts.size} ID/name/digest-bound GitHub artifacts`,
      ),
      passingCheck(
        CHECK_IDS[1],
        "SHA256SUMS exactly matched every admitted subject",
        `${coveredSubjects.length} subject SHA-256 entries recomputed from stable file descriptors`,
      ),
      passingCheck(
        CHECK_IDS[2],
        "SPDX 2.3 structure and subject coverage were independently validated",
        `${coveredSubjects.length} source-bound subjects covered by SHA-256`,
      ),
      passingCheck(
        CHECK_IDS[3],
        "Every subject provenance bundle passed GitHub cryptographic verification",
        `${coveredSubjects.length} bundles constrained by repository, source digest, tag ref, workflow, and SLSA predicate`,
      ),
      passingCheck(
        CHECK_IDS[4],
        "Verification instructions exactly matched the canonical generated guide",
        `${coveredSubjects.length} digest-specific gh attestation commands`,
      ),
    ],
  };
}

export function parseCanonicalArgs(argv) {
  assert(
    argv.length === 4 &&
      argv[0] === "--platform" &&
      argv[1] === "linux" &&
      argv[2] === "--output" &&
      argv[3] === REPORT_PATH,
    `usage: ${machineVerifierCommand(CLAIM_ID, "linux")}`,
  );
  return { platform: argv[1], output: argv[3] };
}

export async function runCanonicalVerifier(
  argv = process.argv.slice(2),
  {
    env = process.env,
    root = process.cwd(),
    fetchImpl = globalThis.fetch,
    executeGit = defaultExecuteGit,
    verifyAttestation = verifyGitHubArtifactAttestation,
    runtime = process,
  } = {},
) {
  const args = parseCanonicalArgs(argv);
  assert(
    runtime.platform === "linux" && runtime.arch === "x64",
    "release artifact verifier must execute natively on linux-x64",
  );
  const canonicalRoot = realpathSync(resolve(root));
  const runIdentity = readRunIdentity(env);
  const versions = assertSourceCheckout({
    root: canonicalRoot,
    sourceCommit: runIdentity.sourceCommit,
    releaseTag: runIdentity.releaseTag,
    executeGit,
  });
  const identity = { ...runIdentity, ...versions };
  const apiArtifacts = await resolveCurrentRunArtifacts(identity, fetchImpl);
  const subjects = inspectCanonicalSubjects(canonicalRoot, versions.appVersion);
  verifyUpdateManifests(subjects, versions.appVersion);
  const materials = await verifyMaterials({
    root: canonicalRoot,
    subjects,
    identity,
    verifyAttestation,
  });
  const report = buildReport({
    root: canonicalRoot,
    identity,
    apiArtifacts,
    subjects,
    materials,
    runtime,
  });

  // Re-inspect subjects after all parsers and external verifiers finish. This
  // makes mutation during verification a hard failure, not a stale report.
  const after = inspectCanonicalSubjects(canonicalRoot, versions.appVersion);
  for (const [artifactName, subject] of subjects) {
    const observed = after.get(artifactName);
    assert(
      observed.sha256 === subject.sha256 &&
        observed.sizeBytes === subject.sizeBytes &&
        observed.device === subject.device &&
        observed.inode === subject.inode,
      `${artifactName} subject changed while release evidence was collected`,
    );
  }

  const output = resolve(canonicalRoot, args.output);
  const reportsRoot = resolve(canonicalRoot, ".release-evidence", "reports");
  assert(
    within(reportsRoot, output),
    "report output must be inside .release-evidence/reports",
  );
  mkdirSync(reportsRoot, { recursive: true });
  assertNoSymlinkComponents(
    canonicalRoot,
    reportsRoot,
    "release evidence reports directory",
  );
  const reportsStat = lstatSync(reportsRoot);
  assert(
    reportsStat.isDirectory() &&
      !reportsStat.isSymbolicLink() &&
      within(canonicalRoot, realpathSync(reportsRoot)),
    "release evidence reports directory must be a real directory inside the checkout",
  );
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return report;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCanonicalVerifier().catch((error) => {
    console.error(
      `[${CLAIM_ID}] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
