#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  machineProducerJobName,
  machineVerifierCommand,
  machineVerifierPath,
} from "../release-constants.mjs";

export const CLAIM_ID = "release.signing";
export const CHECK_IDS = Object.freeze([
  "release.platform-signature-validation",
]);

const WORKFLOW_PATH = ".github/workflows/build.yml";
const MAX_API_BYTES = 16 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;
const MACOS_NATIVE_TOOLS = Object.freeze({
  codesign: "/usr/bin/codesign",
  spctl: "/usr/sbin/spctl",
  xcrun: "/usr/bin/xcrun",
  hdiutil: "/usr/bin/hdiutil",
  ditto: "/usr/bin/ditto",
  lipo: "/usr/bin/lipo",
  plutil: "/usr/bin/plutil",
});
const MACOS_VERIFICATION_METHODS = Object.freeze({
  "SkyTwin-macOS-dmg": "gatekeeper+stapler+dmg-contained-app-codesign",
  "SkyTwin-macOS-zip": "ditto-contained-app+codesign+gatekeeper+stapler",
});
const WINDOWS_VERIFICATION_METHOD =
  "Get-AuthenticodeSignature(Status=Valid)+pinned-signer-certificate";
const WINDOWS_TIMESTAMP_VALIDATION =
  "presence-and-fingerprint-recorded-not-independently-validated";
const WINDOWS_NSIS_PAYLOAD = "$PLUGINSDIR/app-64.7z";
const WINDOWS_EXECUTABLE_MEMBER = "SkyTwin.exe";
const VERSION_SEGMENT = "(?:0|[1-9][0-9]{0,8})";
const FOUR_SEGMENT_TAG = new RegExp(
  `^v(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})$`,
);
const BETA_TAG = new RegExp(
  `^v(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})-beta(?:\\.([1-9][0-9]{0,8}))?$`,
);

const PLATFORM_CONFIG = Object.freeze({
  macos: Object.freeze({
    nodePlatform: "darwin",
    runnerOs: "macOS",
    runnerArch: "ARM64",
    primaryArtifactName: "SkyTwin-macOS-dmg",
    artifacts: Object.freeze([
      Object.freeze({
        artifactName: "SkyTwin-macOS-dmg",
        kind: "desktop-installer",
        pattern: /^SkyTwin-APP_VERSION-arm64\.dmg$/u,
      }),
      Object.freeze({
        artifactName: "SkyTwin-macOS-zip",
        kind: "desktop-archive",
        pattern: /^SkyTwin-APP_VERSION-arm64-mac\.zip$/u,
      }),
    ]),
  }),
  windows: Object.freeze({
    nodePlatform: "win32",
    runnerOs: "Windows",
    runnerArch: "X64",
    primaryArtifactName: "SkyTwin-Windows-installer",
    artifacts: Object.freeze([
      Object.freeze({
        artifactName: "SkyTwin-Windows-installer",
        kind: "desktop-installer",
        pattern: /^SkyTwin-Setup-APP_VERSION\.exe$/u,
      }),
    ]),
  }),
  linux: Object.freeze({
    nodePlatform: "linux",
    runnerOs: "Linux",
    runnerArch: "X64",
    primaryArtifactName: "SkyTwin-Linux-AppImage",
    artifacts: Object.freeze([
      Object.freeze({
        artifactName: "SkyTwin-Linux-AppImage",
        kind: "desktop-installer",
        pattern: /^SkyTwin-APP_VERSION\.AppImage$/u,
      }),
      Object.freeze({
        artifactName: "SkyTwin-Linux-deb",
        kind: "desktop-installer",
        pattern: /^skytwin-desktop_APP_VERSION_amd64\.deb$/u,
      }),
      Object.freeze({
        artifactName: "SkyTwin-Linux-rpm",
        kind: "desktop-installer",
        pattern: /^skytwin-desktop-APP_VERSION\.x86_64\.rpm$/u,
      }),
    ]),
  }),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, description) {
  assert(isRecord(value), `${description} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${description} has unexpected or missing fields`,
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

function sameFileIdentity(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
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
  maximumBytes = MAX_SUBJECT_BYTES,
  testHooks = {},
) {
  const lexicalRoot = resolve(rootPath);
  const requested = resolve(requestedPath);
  assert(within(lexicalRoot, requested), `${description} escapes its root`);
  assertNoSymlinkComponents(lexicalRoot, requested, description);
  const beforePath = lstatSync(requested, { bigint: true });
  assert(
    beforePath.isFile() &&
      !beforePath.isSymbolicLink() &&
      beforePath.nlink === 1n,
    `${description} must be a direct regular non-symlink non-hard-linked file`,
  );
  assert(
    beforePath.size > 0n && beforePath.size <= BigInt(maximumBytes),
    `${description} size is outside the release bound`,
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
    const digest = createHash("sha256");
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
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(requested, { bigint: true });
    assert(
      afterPath.isFile() &&
        !afterPath.isSymbolicLink() &&
        afterPath.nlink === 1n &&
        after.nlink === 1n,
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
      sha256: digest.digest("hex"),
      device: after.dev.toString(),
      inode: after.ino.toString(),
    };
  } finally {
    closeSync(descriptor);
  }
}

function escapedPattern(pattern, appVersion) {
  const escaped = appVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
    /^[0-9a-f]{40}$/u.test(sourceCommit),
    "source commit must be a full lowercase Git SHA",
  );
  assert(
    executeGit(["rev-parse", "HEAD"], root).trim() === sourceCommit,
    "source commit does not match checked-out HEAD",
  );
  assert(
    executeGit(["status", "--porcelain=v1", "--untracked-files=no"], root) ===
      "",
    "release verifier requires an unmodified tracked source checkout",
  );
  const versions = normalizeReleaseVersion(releaseTag);
  assert(
    readFileSync(join(root, "VERSION"), "utf8").trim() ===
      versions.repositoryVersion,
    "VERSION does not match the release tag",
  );
  assert(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ===
      versions.repositoryVersion,
    "package.json version does not match the release tag",
  );
  return versions;
}

function defaultExecuteGit(args, cwd) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const git =
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git";
  const env = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  });
  const result = spawnSync(
    git,
    [
      "--no-pager",
      "--literal-pathspecs",
      "-c",
      `core.hooksPath=${nullDevice}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      `core.excludesFile=${nullDevice}`,
      ...args,
    ],
    {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  assert(
    result.status === 0 && result.signal === null,
    `git ${args[0]} failed while establishing source identity`,
  );
  return result.stdout;
}

export function readRunIdentity(platform, env = process.env) {
  const config = PLATFORM_CONFIG[platform];
  assert(config, `unsupported release signing platform: ${platform}`);
  assert(
    env.RUNNER_OS === config.runnerOs,
    `RUNNER_OS does not match ${platform}`,
  );
  assert(
    env.RUNNER_ARCH === config.runnerArch,
    `RUNNER_ARCH does not match the canonical ${platform} runner`,
  );
  const sourceCommit = env.GITHUB_SHA;
  const repository = env.GITHUB_REPOSITORY;
  const releaseTag = env.GITHUB_REF_NAME;
  const ref = env.GITHUB_REF;
  const runId = Number(env.GITHUB_RUN_ID);
  assert(/^[0-9a-f]{40}$/u.test(sourceCommit ?? ""), "GITHUB_SHA is invalid");
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? ""),
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
      throw new Error(`${description} response exceeds the release bound`);
    }
    chunks.push(value);
  }
  assert(size > 0, `${description} returned an empty response body`);
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, size)));
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
        "User-Agent": "skytwin-release-signing-verifier",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  return responseJson(response, `GitHub API ${path}`);
}

export async function resolveCurrentRunArtifacts(
  identity,
  platform,
  fetchImpl = globalThis.fetch,
) {
  const config = PLATFORM_CONFIG[platform];
  assert(config, `unsupported release signing platform: ${platform}`);
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
  for (const expected of config.artifacts) {
    const matches = page.artifacts.filter(
      (artifact) => artifact?.name === expected.artifactName,
    );
    assert(
      matches.length === 1,
      `expected exactly one current-run ${expected.artifactName} artifact, found ${matches.length}`,
    );
    const artifact = matches[0];
    const digest = String(artifact.digest ?? "").replace(/^sha256:/u, "");
    assert(
      Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        artifact.expired === false &&
        /^[0-9a-f]{64}$/u.test(digest) &&
        artifact.workflow_run?.id === identity.runId &&
        artifact.workflow_run?.head_sha === identity.sourceCommit,
      `${expected.artifactName} artifact is not an unexpired digest-bound artifact from the current run`,
    );
    const detail = await githubJson(
      identity.repository,
      `/actions/artifacts/${artifact.id}`,
      identity.token,
      fetchImpl,
    );
    assert(
      detail.id === artifact.id &&
        detail.name === expected.artifactName &&
        detail.expired === false &&
        detail.digest === `sha256:${digest}` &&
        detail.workflow_run?.id === identity.runId &&
        detail.workflow_run?.head_sha === identity.sourceCommit,
      `${expected.artifactName} artifact detail disagrees with the current-run inventory`,
    );
    resolved.set(expected.artifactName, {
      artifactId: artifact.id,
      artifactName: expected.artifactName,
      artifactSha256: digest,
      kind: expected.kind,
    });
  }
  return resolved;
}

export function inspectPlatformSubjects(rootPath, platform, appVersion) {
  const config = PLATFORM_CONFIG[platform];
  assert(config, `unsupported release signing platform: ${platform}`);
  const root = realpathSync(resolve(rootPath));
  const seenNames = new Set();
  const subjects = new Map();
  for (const expected of config.artifacts) {
    const directory = resolve(root, "artifacts", expected.artifactName);
    assert(
      within(root, directory),
      `${expected.artifactName} escapes checkout`,
    );
    const directoryStat = lstatSync(directory);
    assert(
      directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
      `${expected.artifactName} must be a direct real directory`,
    );
    assert(
      within(root, realpathSync(directory)),
      `${expected.artifactName} resolves outside checkout`,
    );
    const entries = readdirSync(directory, { withFileTypes: true });
    assert(
      entries.length === 1,
      `${expected.artifactName} must contain exactly one direct subject`,
    );
    const entry = entries[0];
    assert(
      entry.isFile() &&
        !entry.isSymbolicLink() &&
        basename(entry.name) === entry.name,
      `${expected.artifactName} subject must be a direct regular non-symlink file`,
    );
    assert(
      escapedPattern(expected.pattern, appVersion).test(entry.name),
      `${expected.artifactName} has unexpected filename ${entry.name}`,
    );
    assert(
      !seenNames.has(entry.name),
      `duplicate release subject filename ${entry.name}`,
    );
    seenNames.add(entry.name);
    const subject = inspectStableRegularFile(
      root,
      join(directory, entry.name),
      `${expected.artifactName} subject`,
    );
    subjects.set(expected.artifactName, {
      ...subject,
      artifactName: expected.artifactName,
      kind: expected.kind,
      relativePath: `artifacts/${expected.artifactName}/${entry.name}`,
    });
  }
  return subjects;
}

export function readTrustPolicy(platform, env = process.env) {
  // These pins are operator assertions, not facts this code can derive. Future
  // workflow wiring must inject both from protected operator/environment
  // configuration—never tagged-workflow literals or artifact-derived values.
  // This verifier proves only that the supplied pin has the expected form and
  // matches the native signature observation; it cannot prove pin provenance.
  if (platform === "macos") {
    const teamId = env.SKYTWIN_MACOS_TEAM_ID;
    assert(
      /^[A-Z0-9]{10}$/u.test(teamId ?? ""),
      "SKYTWIN_MACOS_TEAM_ID must pin the expected 10-character Apple Team ID",
    );
    return { teamId };
  }
  if (platform === "windows") {
    const signerSha256 = env.SKYTWIN_WINDOWS_SIGNER_SHA256;
    assert(
      /^[0-9a-fA-F]{64}$/u.test(signerSha256 ?? ""),
      "SKYTWIN_WINDOWS_SIGNER_SHA256 must pin the expected signer certificate SHA-256 fingerprint",
    );
    return { signerSha256: signerSha256.toLowerCase() };
  }
  throw new Error(
    "Linux release signing policy is not configured: AppImage, deb, and rpm require explicit verification methods and pinned trust roots before release.signing can pass",
  );
}

export function executeNativeCommand(
  file,
  args,
  { env = process.env, cwd } = {},
) {
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: MAX_TOOL_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function checkedCommand(execute, file, args, options, description) {
  const result = execute(file, args, options);
  assert(
    isRecord(result) &&
      result.exitCode === 0 &&
      result.signal == null &&
      typeof result.stdout === "string" &&
      typeof result.stderr === "string" &&
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
        MAX_TOOL_OUTPUT_BYTES,
    `${description} failed`,
  );
  return `${result.stdout}\n${result.stderr}`;
}

function uniqueMetadata(output, key, description) {
  const values = [...output.matchAll(new RegExp(`^${key}=(.+)$`, "gmu"))].map(
    (match) => match[1].trim(),
  );
  assert(
    values.length === 1 && values[0].length > 0,
    `${description} has missing or ambiguous ${key}`,
  );
  return values[0];
}

export function parseMacCodeSignature(
  output,
  expectedTeamId,
  description,
  { requireRuntime = true } = {},
) {
  const identifier = uniqueMetadata(output, "Identifier", description);
  const teamId = uniqueMetadata(output, "TeamIdentifier", description);
  const cdHash = uniqueMetadata(output, "CDHash", description);
  const authorities = [...output.matchAll(/^Authority=(.+)$/gmu)].map((match) =>
    match[1].trim(),
  );
  assert(
    teamId === expectedTeamId,
    `${description} Apple Team ID is untrusted`,
  );
  const signerAuthorities = authorities.filter((value) =>
    /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(value),
  );
  assert(
    authorities.length === 3 &&
      signerAuthorities.length === 1 &&
      authorities[0] === signerAuthorities[0] &&
      authorities[1] === "Developer ID Certification Authority" &&
      authorities[2] === "Apple Root CA",
    `${description} Developer ID authority chain is missing or ambiguous`,
  );
  const signer = signerAuthorities[0];
  assert(
    signer.endsWith(`(${teamId})`),
    `${description} Developer ID authority does not match its TeamIdentifier`,
  );
  assert(
    /^[0-9a-fA-F]{40}$/u.test(cdHash),
    `${description} has an invalid CDHash`,
  );
  if (requireRuntime)
    assert(
      /^CodeDirectory .*flags=.*\(runtime\)/mu.test(output),
      `${description} does not enable the hardened runtime`,
    );
  return {
    identifier,
    teamId,
    signer,
    cdHash: cdHash.toLowerCase(),
  };
}

export function parseMacGatekeeper(output, description) {
  const accepted = output
    .split(/\r?\n/u)
    .filter((line) => /^(?:[^\r\n]+: )?accepted$/u.test(line.trim()));
  const source = [...output.matchAll(/^source=(.+)$/gmu)].map((match) =>
    match[1].trim(),
  );
  assert(
    accepted.length === 1 &&
      source.length === 1 &&
      source[0] === "Notarized Developer ID",
    `${description} is not accepted as a notarized Developer ID subject`,
  );
}

function inspectMacApp(extractionRoot, appPath, description) {
  const lexicalRoot = resolve(extractionRoot);
  const requested = resolve(appPath);
  assert(within(lexicalRoot, requested), `${description} escapes extraction`);
  assertNoSymlinkComponents(lexicalRoot, requested, description);
  const appStat = lstatSync(requested);
  assert(
    appStat.isDirectory() && !appStat.isSymbolicLink(),
    `${description} must contain a direct SkyTwin.app bundle`,
  );
  assert(
    within(realpathSync(lexicalRoot), realpathSync(requested)),
    `${description} resolves outside extraction`,
  );
  const executable = join(requested, "Contents", "MacOS", "SkyTwin");
  const packagedExecutable = inspectStableRegularFile(
    lexicalRoot,
    executable,
    `${description} packaged executable`,
    MAX_SUBJECT_BYTES,
  );
  return { path: requested, packagedExecutable };
}

function verifyMacApp(
  appPath,
  expectedTeamId,
  expectedAppVersion,
  execute,
  env,
  description,
) {
  checkedCommand(
    execute,
    MACOS_NATIVE_TOOLS.codesign,
    ["--verify", "--deep", "--strict", "--verbose=4", appPath],
    { env },
    `${description} code-signature verification`,
  );
  const signature = parseMacCodeSignature(
    checkedCommand(
      execute,
      MACOS_NATIVE_TOOLS.codesign,
      ["--display", "--verbose=4", appPath],
      { env },
      `${description} signature inspection`,
    ),
    expectedTeamId,
    description,
  );
  assert(
    signature.identifier === "com.skytwin.desktop",
    `${description} has an unexpected signed application identifier`,
  );
  const architectures = checkedCommand(
    execute,
    MACOS_NATIVE_TOOLS.lipo,
    ["-archs", join(appPath, "Contents", "MacOS", "SkyTwin")],
    { env },
    `${description} packaged executable architecture inspection`,
  )
    .trim()
    .split(/\s+/u);
  assert(
    architectures.length === 1 && architectures[0] === "arm64",
    `${description} packaged executable is not the canonical arm64 architecture`,
  );
  const bundleVersion = checkedCommand(
    execute,
    MACOS_NATIVE_TOOLS.plutil,
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(appPath, "Contents", "Info.plist"),
    ],
    { env },
    `${description} signed bundle version inspection`,
  ).trim();
  assert(
    bundleVersion === expectedAppVersion,
    `${description} signed bundle version does not match the release tag`,
  );
  parseMacGatekeeper(
    checkedCommand(
      execute,
      MACOS_NATIVE_TOOLS.spctl,
      ["--assess", "--type", "execute", "--verbose=4", appPath],
      { env },
      `${description} Gatekeeper assessment`,
    ),
    description,
  );
  const stapler = checkedCommand(
    execute,
    MACOS_NATIVE_TOOLS.xcrun,
    ["stapler", "validate", appPath],
    { env },
    `${description} notarization ticket validation`,
  );
  assert(
    /The validate action worked!/u.test(stapler),
    `${description} has no valid stapled notarization ticket`,
  );
  return {
    ...signature,
    bundleVersion,
    executableArchitecture: architectures[0],
  };
}

export function verifyMacSubjects(
  subjects,
  policy,
  { execute = executeNativeCommand, appVersion } = {},
) {
  assert(
    subjects.size === 2 &&
      subjects.has("SkyTwin-macOS-dmg") &&
      subjects.has("SkyTwin-macOS-zip"),
    "macOS signing verification requires the exact DMG and ZIP subject set",
  );
  const commandEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
  };
  assert(
    typeof appVersion === "string" && appVersion.length > 0,
    "macOS signing verification requires the release app version",
  );
  const results = new Map();
  let canonicalAppIdentity = null;
  for (const artifactName of ["SkyTwin-macOS-dmg", "SkyTwin-macOS-zip"]) {
    const subject = subjects.get(artifactName);
    const extractionRoot = mkdtempSync(join(tmpdir(), "skytwin-signing-"));
    let detachMount = null;
    try {
      let appPath;
      if (artifactName === "SkyTwin-macOS-dmg") {
        parseMacGatekeeper(
          checkedCommand(
            execute,
            MACOS_NATIVE_TOOLS.spctl,
            [
              "--assess",
              "--type",
              "open",
              "--context",
              "context:primary-signature",
              "--verbose=4",
              subject.path,
            ],
            { env: commandEnv },
            "macOS DMG Gatekeeper assessment",
          ),
          "macOS DMG",
        );
        const dmgStapler = checkedCommand(
          execute,
          MACOS_NATIVE_TOOLS.xcrun,
          ["stapler", "validate", subject.path],
          { env: commandEnv },
          "macOS DMG notarization ticket validation",
        );
        assert(
          /The validate action worked!/u.test(dmgStapler),
          "macOS DMG has no valid stapled notarization ticket",
        );
        const mount = join(extractionRoot, "mounted");
        mkdirSync(mount);
        checkedCommand(
          execute,
          MACOS_NATIVE_TOOLS.hdiutil,
          [
            "attach",
            "-readonly",
            "-nobrowse",
            "-noautoopen",
            "-mountpoint",
            mount,
            subject.path,
          ],
          { env: commandEnv },
          "macOS DMG mount",
        );
        detachMount = mount;
        appPath = inspectMacApp(mount, join(mount, "SkyTwin.app"), "macOS DMG");
      } else {
        const extracted = join(extractionRoot, "unzipped");
        mkdirSync(extracted);
        checkedCommand(
          execute,
          MACOS_NATIVE_TOOLS.ditto,
          ["-x", "-k", "--sequesterRsrc", subject.path, extracted],
          { env: commandEnv },
          "macOS ZIP extraction",
        );
        const entries = readdirSync(extracted, { withFileTypes: true });
        assert(
          entries.length === 1 &&
            entries[0].name === "SkyTwin.app" &&
            entries[0].isDirectory() &&
            !entries[0].isSymbolicLink(),
          "macOS ZIP must contain only one direct real SkyTwin.app bundle",
        );
        appPath = inspectMacApp(
          extracted,
          join(extracted, "SkyTwin.app"),
          "macOS ZIP",
        );
      }
      const appSignature = verifyMacApp(
        appPath.path,
        policy.teamId,
        appVersion,
        execute,
        commandEnv,
        artifactName,
      );
      const observedExecutable = inspectStableRegularFile(
        extractionRoot,
        appPath.packagedExecutable.path,
        `${artifactName} packaged executable after native verification`,
        MAX_SUBJECT_BYTES,
      );
      assert(
        observedExecutable.sha256 === appPath.packagedExecutable.sha256 &&
          observedExecutable.sizeBytes ===
            appPath.packagedExecutable.sizeBytes &&
          observedExecutable.device === appPath.packagedExecutable.device &&
          observedExecutable.inode === appPath.packagedExecutable.inode,
        `${artifactName} packaged executable changed during native verification`,
      );
      canonicalAppIdentity = canonicalAppIdentity ?? appSignature;
      assert(
        appSignature.teamId === canonicalAppIdentity.teamId &&
          appSignature.signer === canonicalAppIdentity.signer &&
          appSignature.identifier === canonicalAppIdentity.identifier &&
          appSignature.cdHash === canonicalAppIdentity.cdHash &&
          appSignature.bundleVersion === canonicalAppIdentity.bundleVersion &&
          appSignature.executableArchitecture ===
            canonicalAppIdentity.executableArchitecture,
        "macOS packaged subjects have different signed application identities",
      );
      results.set(artifactName, {
        signatureResult: "pass",
        notarizationResult: "pass",
        verificationMethod: MACOS_VERIFICATION_METHODS[artifactName],
        signer: appSignature.signer,
        signerTeamId: appSignature.teamId,
        signedIdentifier: appSignature.identifier,
        signedContentCdHash: appSignature.cdHash,
        signedBundleVersion: appSignature.bundleVersion,
        executableArchitecture: appSignature.executableArchitecture,
      });
    } finally {
      try {
        if (detachMount !== null)
          checkedCommand(
            execute,
            MACOS_NATIVE_TOOLS.hdiutil,
            ["detach", detachMount],
            { env: commandEnv },
            "macOS DMG detach",
          );
      } finally {
        rmSync(extractionRoot, { recursive: true, force: true });
      }
    }
  }
  return results;
}

function normalizeSevenZipMemberPath(value, description) {
  assert(
    typeof value === "string" && value.length > 0,
    `${description} contains an empty member name`,
  );
  const normalized = value.replaceAll("\\", "/");
  assert(
    !normalized.startsWith("/") &&
      !/^[a-z]:/iu.test(normalized) &&
      !normalized.includes(":") &&
      !normalized.startsWith("-") &&
      !normalized.startsWith("@"),
    `${description} contains an unsafe member name`,
  );
  const components = normalized.split("/");
  assert(
    components.every(
      (component) =>
        component.length > 0 &&
        component !== "." &&
        component !== ".." &&
        !/[. ]$/u.test(component) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(component),
    ),
    `${description} contains an unsafe Windows path component`,
  );
  return normalized;
}

export function parseSevenZipListing(output, archivePath, description) {
  assert(
    typeof output === "string" && output.length <= MAX_TOOL_OUTPUT_BYTES,
    `${description} listing is missing or too large`,
  );
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf(" = ");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 3);
    if (key === "Path") {
      if (current) records.push(current);
      current = { Path: value };
    } else if (current) {
      assert(
        !Object.hasOwn(current, key),
        `${description} has duplicate ${key}`,
      );
      current[key] = value;
    }
  }
  if (current) records.push(current);
  if (
    records[0] &&
    (resolve(records[0].Path) === resolve(archivePath) ||
      records[0].Path === basename(archivePath))
  )
    records.shift();
  assert(
    records.length > 0 && records.length <= 100_000,
    `${description} member count is outside the release bound`,
  );
  let expandedBytes = 0;
  const seen = new Set();
  for (const record of records) {
    const normalizedPath = normalizeSevenZipMemberPath(
      record.Path,
      description,
    );
    const folded = normalizedPath.toLowerCase();
    assert(!seen.has(folded), `${description} has a case-colliding member`);
    seen.add(folded);
    assert(
      !Object.hasOwn(record, "Symbolic Link") &&
        !Object.hasOwn(record, "Hard Link"),
      `${description} contains a link member`,
    );
    const size = Number(record.Size ?? "0");
    assert(
      Number.isSafeInteger(size) && size >= 0,
      `${description} has an invalid member size`,
    );
    expandedBytes += size;
    assert(
      Number.isSafeInteger(expandedBytes) && expandedBytes <= MAX_SUBJECT_BYTES,
      `${description} expanded size exceeds the release bound`,
    );
    record.normalizedPath = normalizedPath;
  }
  return records;
}

function assertExactExtractedFile(root, expectedPath, description) {
  const rootStat = lstatSync(root);
  assert(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    `${description} root must remain a direct directory`,
  );
  const expected = expectedPath.split("/").join(sep);
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      assert(!stat.isSymbolicLink(), `${description} contains a reparse point`);
      if (stat.isDirectory()) walk(path);
      else {
        assert(
          stat.isFile() && stat.nlink === 1n,
          `${description} contains a special file or hard link`,
        );
        files.push(relative(root, path));
      }
    }
  }
  walk(root);
  assert(
    files.length === 1 && files[0] === expected,
    `${description} did not produce the exact requested file`,
  );
  return join(root, expected);
}

function executeSevenZip(execute, sevenZip, args, commandEnv, description) {
  return checkedCommand(
    execute,
    sevenZip,
    args,
    { env: commandEnv },
    description,
  );
}

function deriveWindowsExecutable(
  subjectPath,
  extractionRoot,
  sevenZip,
  execute,
  commandEnv,
) {
  const firstListing = parseSevenZipListing(
    executeSevenZip(
      execute,
      sevenZip,
      ["l", "-slt", "-tNSIS", subjectPath],
      commandEnv,
      "Windows NSIS listing",
    ),
    subjectPath,
    "Windows NSIS archive",
  );
  assert(
    firstListing.filter(
      (record) => record.normalizedPath === WINDOWS_NSIS_PAYLOAD,
    ).length === 1,
    `Windows NSIS archive must contain exact ${WINDOWS_NSIS_PAYLOAD}`,
  );
  executeSevenZip(
    execute,
    sevenZip,
    ["t", "-tNSIS", subjectPath],
    commandEnv,
    "Windows NSIS integrity test",
  );
  const firstRoot = join(extractionRoot, "nsis");
  mkdirSync(firstRoot, { mode: 0o700 });
  executeSevenZip(
    execute,
    sevenZip,
    [
      "x",
      "-tNSIS",
      subjectPath,
      WINDOWS_NSIS_PAYLOAD,
      `-o${firstRoot}`,
      "-y",
      "-bb0",
      "-bd",
    ],
    commandEnv,
    "Windows NSIS payload extraction",
  );
  const payloadPath = assertExactExtractedFile(
    firstRoot,
    WINDOWS_NSIS_PAYLOAD,
    "Windows NSIS payload extraction",
  );
  const payloadBefore = inspectStableRegularFile(
    firstRoot,
    payloadPath,
    "Windows application payload",
    MAX_SUBJECT_BYTES,
  );
  const secondListing = parseSevenZipListing(
    executeSevenZip(
      execute,
      sevenZip,
      ["l", "-slt", "-t7z", payloadPath],
      commandEnv,
      "Windows application payload listing",
    ),
    payloadPath,
    "Windows application payload",
  );
  assert(
    secondListing.filter(
      (record) => record.normalizedPath === WINDOWS_EXECUTABLE_MEMBER,
    ).length === 1,
    `Windows application payload must contain exact ${WINDOWS_EXECUTABLE_MEMBER}`,
  );
  executeSevenZip(
    execute,
    sevenZip,
    ["t", "-t7z", payloadPath],
    commandEnv,
    "Windows application payload integrity test",
  );
  const executableRoot = join(extractionRoot, "application");
  mkdirSync(executableRoot, { mode: 0o700 });
  executeSevenZip(
    execute,
    sevenZip,
    [
      "x",
      "-t7z",
      payloadPath,
      WINDOWS_EXECUTABLE_MEMBER,
      `-o${executableRoot}`,
      "-y",
      "-bb0",
      "-bd",
    ],
    commandEnv,
    "Windows executable extraction",
  );
  const executablePath = assertExactExtractedFile(
    executableRoot,
    WINDOWS_EXECUTABLE_MEMBER,
    "Windows executable extraction",
  );
  const executable = inspectStableRegularFile(
    executableRoot,
    executablePath,
    "contained Windows executable",
    MAX_SUBJECT_BYTES,
  );
  const descriptor = openSync(
    executablePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const dosHeader = Buffer.alloc(0x40);
    assert(
      readSync(descriptor, dosHeader, 0, dosHeader.length, 0) ===
        dosHeader.length,
      "contained Windows executable has a truncated DOS header",
    );
    assert(
      dosHeader.subarray(0, 2).toString("ascii") === "MZ",
      "contained Windows executable is not PE/MZ",
    );
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    assert(
      peOffset + peHeader.length <= executable.sizeBytes &&
        readSync(descriptor, peHeader, 0, peHeader.length, peOffset) ===
          peHeader.length &&
        peHeader.subarray(0, 4).toString("binary") === "PE\0\0" &&
        peHeader.readUInt16LE(4) === 0x8664,
      "contained Windows executable is not AMD64 PE",
    );
  } finally {
    closeSync(descriptor);
  }
  const payloadAfter = inspectStableRegularFile(
    firstRoot,
    payloadPath,
    "Windows application payload",
    MAX_SUBJECT_BYTES,
  );
  assert(
    payloadBefore.sha256 === payloadAfter.sha256 &&
      payloadBefore.sizeBytes === payloadAfter.sizeBytes &&
      payloadBefore.device === payloadAfter.device &&
      payloadBefore.inode === payloadAfter.inode,
    "Windows application payload changed during extraction",
  );
  return { executableRoot, executable, executablePath };
}

const WINDOWS_SIGNATURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:SKYTWIN_SIGNATURE_SUBJECT
if ($null -eq $signature -or $null -eq $signature.SignerCertificate) { throw 'missing Authenticode signer' }
$certificate = $signature.SignerCertificate
$timestamp = $signature.TimeStamperCertificate
$ekuExtension = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
if ($null -eq $ekuExtension) { throw 'missing enhanced key usage' }
$eku = [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($ekuExtension, $ekuExtension.Critical)
$ekuOids = @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value })
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:SKYTWIN_SIGNATURE_SUBJECT)
[ordered]@{
  status = [string]$signature.Status
  signatureType = [string]$signature.SignatureType
  signerSubject = [string]$certificate.Subject
  signerIssuer = [string]$certificate.Issuer
  signerSha256 = $certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant()
  codeSigningEku = $ekuOids -contains '1.3.6.1.5.5.7.3.3'
  timestampPresent = $null -ne $timestamp
  timestampSignerSha256 = if ($null -eq $timestamp) { '' } else { $timestamp.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256).ToLowerInvariant() }
  productVersion = [string]$version.ProductVersion
  fileVersionMajor = [int]$version.FileMajorPart
  fileVersionMinor = [int]$version.FileMinorPart
  fileVersionBuild = [int]$version.FileBuildPart
  fileVersionPrivate = [int]$version.FilePrivatePart
} | ConvertTo-Json -Compress
`;

export function parseWindowsSignature(output, expectedSignerSha256) {
  let value;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new Error("Windows Authenticode verifier returned invalid JSON");
  }
  exactKeys(
    value,
    [
      "status",
      "signatureType",
      "signerSubject",
      "signerIssuer",
      "signerSha256",
      "codeSigningEku",
      "timestampPresent",
      "timestampSignerSha256",
      "productVersion",
      "fileVersionMajor",
      "fileVersionMinor",
      "fileVersionBuild",
      "fileVersionPrivate",
    ],
    "Windows Authenticode result",
  );
  assert(value.status === "Valid", "Windows Authenticode status is not Valid");
  assert(
    value.signatureType === "Authenticode",
    "Windows subject does not carry an Authenticode signature",
  );
  assert(
    typeof value.signerSubject === "string" &&
      value.signerSubject.length > 0 &&
      typeof value.signerIssuer === "string" &&
      value.signerIssuer.length > 0 &&
      value.signerSubject !== value.signerIssuer,
    "Windows signer certificate identity is missing or self-issued",
  );
  assert(
    value.signerSha256 === expectedSignerSha256,
    "Windows signer certificate fingerprint is untrusted",
  );
  assert(
    value.codeSigningEku === true,
    "Windows signer certificate lacks the code-signing EKU",
  );
  assert(
    value.timestampPresent === true &&
      /^[0-9a-f]{64}$/u.test(value.timestampSignerSha256),
    "Windows Authenticode signature lacks a timestamp certificate identity",
  );
  assert(
    typeof value.productVersion === "string" &&
      [
        value.fileVersionMajor,
        value.fileVersionMinor,
        value.fileVersionBuild,
        value.fileVersionPrivate,
      ].every((part) => Number.isSafeInteger(part) && part >= 0),
    "Windows subject product version is malformed",
  );
  return value;
}

function verifyWindowsSignature(path, powershell, commandEnv, policy, execute) {
  const result = checkedCommand(
    execute,
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_SIGNATURE_SCRIPT,
    ],
    {
      env: { ...commandEnv, SKYTWIN_SIGNATURE_SUBJECT: path },
    },
    "Windows Authenticode verification",
  );
  return parseWindowsSignature(result.trim(), policy.signerSha256);
}

export function verifyWindowsSubjects(
  subjects,
  policy,
  { execute = executeNativeCommand, env = process.env, appVersion } = {},
) {
  assert(
    subjects.size === 1 && subjects.has("SkyTwin-Windows-installer"),
    "Windows signing verification requires the exact installer subject set",
  );
  const subject = subjects.get("SkyTwin-Windows-installer");
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  assert(
    /^[a-z]:\\Windows$/iu.test(systemRoot ?? ""),
    "Windows signing verification requires a canonical local SystemRoot",
  );
  if (typeof env.SystemRoot === "string" && typeof env.WINDIR === "string")
    assert(
      env.SystemRoot.toLowerCase() === env.WINDIR.toLowerCase(),
      "Windows SystemRoot and WINDIR disagree",
    );
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const sevenZip = `${systemRoot.slice(0, 2)}\\Program Files\\7-Zip\\7z.exe`;
  assert(
    typeof appVersion === "string" && appVersion.length > 0,
    "Windows signing verification requires the release app version",
  );
  const commandEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
  };
  const installerBefore = inspectStableRegularFile(
    join(subject.path, ".."),
    subject.path,
    "Windows installer",
    MAX_SUBJECT_BYTES,
  );
  const signature = verifyWindowsSignature(
    subject.path,
    powershell,
    commandEnv,
    policy,
    execute,
  );
  const extractionRoot = mkdtempSync(
    join(tmpdir(), "skytwin-signing-windows-"),
  );
  let primaryError;
  try {
    const derived = deriveWindowsExecutable(
      subject.path,
      extractionRoot,
      sevenZip,
      execute,
      commandEnv,
    );
    const executableBefore = derived.executable;
    const executableSignature = verifyWindowsSignature(
      derived.executablePath,
      powershell,
      commandEnv,
      policy,
      execute,
    );
    assert(
      executableSignature.signerSubject === signature.signerSubject &&
        executableSignature.signerIssuer === signature.signerIssuer &&
        executableSignature.signerSha256 === signature.signerSha256,
      "contained Windows executable signer does not match the installer signer",
    );
    assert(
      executableSignature.productVersion === appVersion,
      "contained Windows executable ProductVersion does not match the release app version",
    );
    const expectedVersionParts = appVersion.split(".").map(Number);
    assert(
      expectedVersionParts.length === 3 &&
        expectedVersionParts.every(Number.isSafeInteger) &&
        executableSignature.fileVersionMajor === expectedVersionParts[0] &&
        executableSignature.fileVersionMinor === expectedVersionParts[1] &&
        executableSignature.fileVersionBuild === expectedVersionParts[2] &&
        executableSignature.fileVersionPrivate === 0,
      "contained Windows executable FileVersionInfo does not match the release app version",
    );
    const executableAfter = inspectStableRegularFile(
      derived.executableRoot,
      derived.executablePath,
      "contained Windows executable",
      MAX_SUBJECT_BYTES,
    );
    assert(
      executableBefore.sha256 === executableAfter.sha256 &&
        executableBefore.sizeBytes === executableAfter.sizeBytes &&
        executableBefore.device === executableAfter.device &&
        executableBefore.inode === executableAfter.inode,
      "contained Windows executable changed during signature verification",
    );
    const installerAfter = inspectStableRegularFile(
      join(subject.path, ".."),
      subject.path,
      "Windows installer",
      MAX_SUBJECT_BYTES,
    );
    assert(
      installerBefore.sha256 === installerAfter.sha256 &&
        installerBefore.sizeBytes === installerAfter.sizeBytes &&
        installerBefore.device === installerAfter.device &&
        installerBefore.inode === installerAfter.inode,
      "Windows installer changed during verification",
    );
    return new Map([
      [
        "SkyTwin-Windows-installer",
        {
          signatureResult: "pass",
          verificationMethod: WINDOWS_VERIFICATION_METHOD,
          authenticodeStatus: signature.status,
          authenticodeSignatureType: signature.signatureType,
          signer: signature.signerSubject,
          signerIssuer: signature.signerIssuer,
          signerCertificateSha256: signature.signerSha256,
          signerCertificatePinned: true,
          codeSigningEku: signature.codeSigningEku,
          timestampCertificatePresent: signature.timestampPresent,
          timestampSignerCertificateSha256: signature.timestampSignerSha256,
          timestampCertificateValidation: WINDOWS_TIMESTAMP_VALIDATION,
          containedExecutable: {
            derivationMethod: "nsis-7zip",
            derivationPath:
              `${WINDOWS_NSIS_PAYLOAD}!/${WINDOWS_EXECUTABLE_MEMBER}`.replace(
                "$PLUGINSDIR/",
                "",
              ),
            name: basename(derived.executablePath),
            sha256: executableBefore.sha256,
            sizeBytes: executableBefore.sizeBytes,
            architecture: "AMD64",
            productVersion: executableSignature.productVersion,
            fileVersionMajor: executableSignature.fileVersionMajor,
            fileVersionMinor: executableSignature.fileVersionMinor,
            fileVersionBuild: executableSignature.fileVersionBuild,
            fileVersionPrivate: executableSignature.fileVersionPrivate,
            signatureResult: "pass",
            verificationMethod: WINDOWS_VERIFICATION_METHOD,
            authenticodeStatus: executableSignature.status,
            authenticodeSignatureType: executableSignature.signatureType,
            signer: executableSignature.signerSubject,
            signerIssuer: executableSignature.signerIssuer,
            signerCertificateSha256: executableSignature.signerSha256,
            signerCertificatePinned: true,
            codeSigningEku: executableSignature.codeSigningEku,
            timestampCertificatePresent: executableSignature.timestampPresent,
            timestampSignerCertificateSha256:
              executableSignature.timestampSignerSha256,
            timestampCertificateValidation: WINDOWS_TIMESTAMP_VALIDATION,
          },
        },
      ],
    ]);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      rmSync(extractionRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

export function verifyLinuxSubjects() {
  throw new Error(
    "Linux release signing policy is not configured: checksum/provenance evidence cannot substitute for AppImage, deb, and rpm package-signature trust",
  );
}

function passingCheck(assertion, measurement) {
  return {
    id: CHECK_IDS[0],
    testId: CHECK_IDS[0],
    result: "pass",
    observed: { assertion, measurement, exitCode: 0 },
  };
}

function assertMacReportObservation(result, artifactName, appVersion) {
  exactKeys(
    result,
    [
      "signatureResult",
      "notarizationResult",
      "verificationMethod",
      "signer",
      "signerTeamId",
      "signedIdentifier",
      "signedContentCdHash",
      "signedBundleVersion",
      "executableArchitecture",
    ],
    `${artifactName} signing observation`,
  );
  assert(
    result.signatureResult === "pass" &&
      result.notarizationResult === "pass" &&
      result.verificationMethod === MACOS_VERIFICATION_METHODS[artifactName] &&
      /^[A-Z0-9]{10}$/u.test(result.signerTeamId) &&
      new RegExp(
        `^Developer ID Application: .+ \\(${result.signerTeamId}\\)$`,
        "u",
      ).test(result.signer) &&
      result.signedIdentifier === "com.skytwin.desktop" &&
      /^[0-9a-f]{40}$/u.test(result.signedContentCdHash) &&
      result.signedBundleVersion === appVersion &&
      result.executableArchitecture === "arm64",
    `${artifactName} has incomplete or inconsistent macOS signing observations`,
  );
}

function assertWindowsReportObservation(result, artifactName, appVersion) {
  exactKeys(
    result,
    [
      "signatureResult",
      "verificationMethod",
      "authenticodeStatus",
      "authenticodeSignatureType",
      "signer",
      "signerIssuer",
      "signerCertificateSha256",
      "signerCertificatePinned",
      "codeSigningEku",
      "timestampCertificatePresent",
      "timestampSignerCertificateSha256",
      "timestampCertificateValidation",
      "containedExecutable",
    ],
    `${artifactName} signing observation`,
  );
  assert(
    result.signatureResult === "pass" &&
      result.verificationMethod === WINDOWS_VERIFICATION_METHOD &&
      result.authenticodeStatus === "Valid" &&
      result.authenticodeSignatureType === "Authenticode" &&
      typeof result.signer === "string" &&
      result.signer.length > 0 &&
      typeof result.signerIssuer === "string" &&
      result.signerIssuer.length > 0 &&
      result.signer !== result.signerIssuer &&
      /^[0-9a-f]{64}$/u.test(result.signerCertificateSha256) &&
      result.signerCertificatePinned === true &&
      result.codeSigningEku === true &&
      result.timestampCertificatePresent === true &&
      /^[0-9a-f]{64}$/u.test(result.timestampSignerCertificateSha256) &&
      result.timestampCertificateValidation === WINDOWS_TIMESTAMP_VALIDATION &&
      isRecord(result.containedExecutable),
    `${artifactName} has incomplete or inconsistent Windows signing observations`,
  );
  exactKeys(
    result.containedExecutable,
    [
      "derivationMethod",
      "derivationPath",
      "name",
      "sha256",
      "sizeBytes",
      "architecture",
      "productVersion",
      "fileVersionMajor",
      "fileVersionMinor",
      "fileVersionBuild",
      "fileVersionPrivate",
      "signatureResult",
      "verificationMethod",
      "authenticodeStatus",
      "authenticodeSignatureType",
      "signer",
      "signerIssuer",
      "signerCertificateSha256",
      "signerCertificatePinned",
      "codeSigningEku",
      "timestampCertificatePresent",
      "timestampSignerCertificateSha256",
      "timestampCertificateValidation",
    ],
    `${artifactName} contained executable observation`,
  );
  const executable = result.containedExecutable;
  assert(
    executable.derivationMethod === "nsis-7zip" &&
      executable.derivationPath === "app-64.7z!/SkyTwin.exe" &&
      executable.name === "SkyTwin.exe" &&
      SHA256_DIGEST.test(executable.sha256 ?? "") &&
      Number.isSafeInteger(executable.sizeBytes) &&
      executable.sizeBytes > 0 &&
      executable.architecture === "AMD64" &&
      executable.productVersion === appVersion &&
      executable.fileVersionMajor === Number(appVersion.split(".")[0]) &&
      executable.fileVersionMinor === Number(appVersion.split(".")[1]) &&
      executable.fileVersionBuild === Number(appVersion.split(".")[2]) &&
      executable.fileVersionPrivate === 0 &&
      executable.signatureResult === "pass" &&
      executable.verificationMethod === WINDOWS_VERIFICATION_METHOD &&
      executable.authenticodeStatus === "Valid" &&
      executable.authenticodeSignatureType === "Authenticode" &&
      executable.signer === result.signer &&
      executable.signerIssuer === result.signerIssuer &&
      executable.signerCertificateSha256 === result.signerCertificateSha256 &&
      executable.signerCertificatePinned === true &&
      executable.codeSigningEku === true &&
      executable.timestampCertificatePresent === true &&
      SHA256_DIGEST.test(executable.timestampSignerCertificateSha256 ?? "") &&
      executable.timestampCertificateValidation ===
        WINDOWS_TIMESTAMP_VALIDATION,
    `${artifactName} has incomplete or inconsistent contained executable signing observations`,
  );
}

export function buildReport({
  root,
  platform,
  identity,
  apiArtifacts,
  subjects,
  verification,
  runtime = process,
}) {
  const config = PLATFORM_CONFIG[platform];
  assert(config && platform !== "linux", "unsupported passing signing report");
  assert(
    apiArtifacts.size === config.artifacts.length &&
      subjects.size === config.artifacts.length &&
      verification.size === config.artifacts.length,
    "signing report inputs do not cover the exact platform subject set",
  );
  const primarySubject = subjects.get(config.primaryArtifactName);
  const primaryArtifact = apiArtifacts.get(config.primaryArtifactName);
  assert(
    primarySubject && primaryArtifact,
    "primary signing subject is missing",
  );
  const verifierPath = machineVerifierPath(CLAIM_ID);
  const verifierCommand = machineVerifierCommand(CLAIM_ID, platform);
  assert(
    verifierPath && verifierCommand,
    "canonical verifier metadata is missing",
  );
  const verifier = inspectStableRegularFile(
    root,
    resolve(root, verifierPath),
    "canonical release signing verifier",
    4 * 1024 * 1024,
  );
  const coveredSubjects = config.artifacts
    .map(({ artifactName }) => {
      const subject = subjects.get(artifactName);
      const artifact = apiArtifacts.get(artifactName);
      const result = verification.get(artifactName);
      assert(
        subject && artifact && isRecord(result),
        `${artifactName} lacks a complete signing observation`,
      );
      if (platform === "macos")
        assertMacReportObservation(result, artifactName, identity.appVersion);
      else
        assertWindowsReportObservation(
          result,
          artifactName,
          identity.appVersion,
        );
      return {
        artifactId: artifact.artifactId,
        artifactName,
        artifactSha256: artifact.artifactSha256,
        kind: artifact.kind,
        path: subject.relativePath,
        name: subject.name,
        sha256: subject.sha256,
        sizeBytes: subject.sizeBytes,
        platform: `${platform}-${runtime.arch}`,
        ...result,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (platform === "macos") {
    const [canonical, comparison] = coveredSubjects;
    assert(
      canonical.signer === comparison.signer &&
        canonical.signerTeamId === comparison.signerTeamId &&
        canonical.signedIdentifier === comparison.signedIdentifier &&
        canonical.signedContentCdHash === comparison.signedContentCdHash &&
        canonical.signedBundleVersion === comparison.signedBundleVersion &&
        canonical.executableArchitecture === comparison.executableArchitecture,
      "macOS signing report subjects have different signed application identities",
    );
  }
  return {
    releaseTag: identity.releaseTag,
    runId: identity.runId,
    repository: identity.repository,
    ref: identity.ref,
    releaseArtifactKind: primaryArtifact.kind,
    releaseArtifactId: primaryArtifact.artifactId,
    releaseArtifactName: primaryArtifact.artifactName,
    releaseArtifactSha256: primaryArtifact.artifactSha256,
    subjectName: primarySubject.name,
    subjectPath: primarySubject.relativePath,
    subjectSha256: primarySubject.sha256,
    producerJobName: machineProducerJobName(CLAIM_ID, platform),
    verifierPath,
    verifierCommand,
    verifierSha256: verifier.sha256,
    schemaVersion: 1,
    generatedBy: "release-machine-verifier",
    claimId: CLAIM_ID,
    result: "pass",
    sourceCommit: identity.sourceCommit,
    platform,
    runnerPlatform: `${runtime.platform}-${runtime.arch}`,
    coveredSubjects,
    checks: [
      passingCheck(
        platform === "windows"
          ? "Windows Get-AuthenticodeSignature reported Status=Valid for the exact installer and contained AMD64 SkyTwin executable; both signer certificates matched the operator-supplied pin"
          : "Every canonical macOS package subject passed notarization validation and contained the same arm64 Developer ID signed app from the pinned team",
        platform === "windows"
          ? `${coveredSubjects.length} exact subject byte identity plus contained executable SHA-256 from ${apiArtifacts.size} current-run ID/name/digest-bound artifact; timestamp certificate presence and SHA-256 fingerprint recorded without an independent timestamp trust assertion`
          : `${coveredSubjects.length} exact subject byte identities from ${apiArtifacts.size} current-run ID/name/digest-bound artifacts`,
      ),
    ],
  };
}

export function parseCanonicalArgs(argv) {
  const platform = argv[1];
  const expected = machineVerifierCommand(CLAIM_ID, platform);
  assert(
    argv.length === 4 &&
      argv[0] === "--platform" &&
      PLATFORM_CONFIG[platform] &&
      argv[2] === "--output" &&
      expected &&
      argv[3] === `.release-evidence/reports/${CLAIM_ID}.${platform}.json`,
    `usage: node ${machineVerifierPath(CLAIM_ID)} --platform <macos|windows|linux> --output .release-evidence/reports/${CLAIM_ID}.<platform>.json`,
  );
  return { platform, output: argv[3] };
}

function writeReport(root, relativePath, report) {
  const output = resolve(root, relativePath);
  const evidenceRoot = join(root, ".release-evidence");
  const reportsRoot = join(evidenceRoot, "reports");
  assert(
    within(reportsRoot, output),
    "report output escapes reports directory",
  );
  for (const [directory, description] of [
    [evidenceRoot, "release evidence directory"],
    [reportsRoot, "release evidence reports directory"],
  ]) {
    let exists = true;
    try {
      lstatSync(directory);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    assert(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        realpathSync(directory) === directory,
      `${description} must be a direct real directory inside checkout`,
    );
  }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function runCanonicalVerifier(
  argv = process.argv.slice(2),
  {
    env = process.env,
    root = process.cwd(),
    runtime = process,
    fetchImpl = globalThis.fetch,
    executeGit = defaultExecuteGit,
    executeNative = executeNativeCommand,
  } = {},
) {
  const args = parseCanonicalArgs(argv);
  const config = PLATFORM_CONFIG[args.platform];
  assert(
    runtime.platform === config.nodePlatform &&
      runtime.arch === config.runnerArch.toLowerCase(),
    `release signing verifier must execute natively on canonical ${args.platform}-${config.runnerArch.toLowerCase()}`,
  );
  const canonicalRoot = realpathSync(resolve(root));
  const runIdentity = readRunIdentity(args.platform, env);
  const versions = assertSourceCheckout({
    root: canonicalRoot,
    sourceCommit: runIdentity.sourceCommit,
    releaseTag: runIdentity.releaseTag,
    executeGit,
  });
  const identity = { ...runIdentity, ...versions };
  const apiArtifacts = await resolveCurrentRunArtifacts(
    identity,
    args.platform,
    fetchImpl,
  );
  const subjects = inspectPlatformSubjects(
    canonicalRoot,
    args.platform,
    versions.appVersion,
  );
  const policy = readTrustPolicy(args.platform, env);
  const verification =
    args.platform === "macos"
      ? verifyMacSubjects(subjects, policy, {
          execute: executeNative,
          env,
          appVersion: versions.appVersion,
        })
      : args.platform === "windows"
        ? verifyWindowsSubjects(subjects, policy, {
            execute: executeNative,
            env,
            appVersion: versions.appVersion,
          })
        : verifyLinuxSubjects(subjects, policy);
  const report = buildReport({
    root: canonicalRoot,
    platform: args.platform,
    identity,
    apiArtifacts,
    subjects,
    verification,
    runtime,
  });
  const after = inspectPlatformSubjects(
    canonicalRoot,
    args.platform,
    versions.appVersion,
  );
  for (const [artifactName, subject] of subjects) {
    const observed = after.get(artifactName);
    assert(
      observed.sha256 === subject.sha256 &&
        observed.sizeBytes === subject.sizeBytes &&
        observed.device === subject.device &&
        observed.inode === subject.inode,
      `${artifactName} subject changed while signing evidence was collected`,
    );
  }
  writeReport(canonicalRoot, args.output, report);
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
