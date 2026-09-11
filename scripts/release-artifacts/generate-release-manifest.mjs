#!/usr/bin/env node

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  closeSync,
  fstatSync,
  readSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_IDENTITY = [
  "repository",
  "commit",
  "ref",
  "releaseTag",
  "appVersion",
  "runId",
];

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate --${name}`);
    result[name] = value;
  }
  for (const name of ["root", "output", "contract", ...REQUIRED_IDENTITY]) {
    if (!result[name]) throw new Error(`missing --${name}`);
  }
  assertReleaseIdentity(result);
  return result;
}

function assertReleaseIdentity(identity) {
  if (!/^[0-9a-f]{40}$/.test(identity.commit))
    throw new Error("commit must be a full lowercase Git SHA");
  const tagMatch = identity.releaseTag.match(
    /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
  );
  if (!tagMatch)
    throw new Error("releaseTag must match the four-segment VERSION");
  if (identity.ref !== `refs/tags/${identity.releaseTag}`)
    throw new Error("ref must identify releaseTag exactly");
  if (!/^[1-9][0-9]*$/.test(identity.runId))
    throw new Error("runId must be a positive integer");
  if (
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
      identity.appVersion,
    )
  )
    throw new Error("appVersion must be a three-segment numeric version");
  const [, major, minor, patch, build] = tagMatch;
  if (Number(build) >= 100 || Number(patch) > 999999)
    throw new Error("releaseTag cannot be represented as an app version");
  const expectedAppVersion = `${major}.${minor}.${Number(patch) * 100 + Number(build)}`;
  if (identity.appVersion !== expectedAppVersion)
    throw new Error("appVersion does not match releaseTag");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository))
    throw new Error("repository must be owner/name");
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

export function hashStableRegularFile(root, path) {
  const resolvedRoot = realpathSync(root);
  const resolvedPath = realpathSync(path);
  if (!within(resolvedRoot, resolvedPath))
    throw new Error(`${path} escapes artifact root`);
  const beforePath = statSync(path, { bigint: true });
  if (!beforePath.isFile()) throw new Error(`${path} is not a regular file`);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${path} is not a regular file`);
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      sha256.update(buffer.subarray(0, count));
      sha512.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const afterPath = statSync(path, { bigint: true });
    for (const field of ["dev", "ino", "size", "mtimeNs"]) {
      if (
        before[field] !== after[field] ||
        before[field] !== beforePath[field] ||
        after[field] !== afterPath[field]
      ) {
        throw new Error(`${path} changed while hashing`);
      }
    }
    return {
      sha256: sha256.digest("hex"),
      sha512: sha512.digest("base64"),
      size: Number(after.size),
    };
  } finally {
    closeSync(fd);
  }
}

export function generateReleaseManifest(options) {
  assertReleaseIdentity(options);
  const root = resolve(options.root);
  const output = resolve(options.output);
  const contractPath = resolve(options.contract);
  if (!existsSync(root)) throw new Error("artifact root does not exist");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  if (
    contract.schemaVersion !== 1 ||
    contract.releaseSurface !== "desktop" ||
    !Array.isArray(contract.artifacts)
  ) {
    throw new Error("unsupported release artifact contract");
  }
  const seenArtifactNames = new Set();
  const seenBasenames = new Set();
  const assets = [];
  const updateManifests = [];
  for (const expected of contract.artifacts) {
    if (
      !expected ||
      typeof expected !== "object" ||
      typeof expected.artifactName !== "string" ||
      !["macos", "windows", "linux"].includes(expected.platform) ||
      !["installer", "archive", "package", "update-manifest"].includes(
        expected.kind,
      ) ||
      typeof expected.filenamePattern !== "string"
    )
      throw new Error("invalid artifact contract entry");
    if (seenArtifactNames.has(expected.artifactName))
      throw new Error(`duplicate contract artifact ${expected.artifactName}`);
    seenArtifactNames.add(expected.artifactName);
    const directory = join(root, expected.artifactName);
    const entries = statDirectoryFiles(directory);
    if (entries.length !== 1)
      throw new Error(`${expected.artifactName} must contain exactly one file`);
    const filename = entries[0];
    const pattern = new RegExp(expected.filenamePattern, "u");
    if (!pattern.test(filename))
      throw new Error(
        `${expected.artifactName} has unexpected filename ${filename}`,
      );
    if (seenBasenames.has(filename))
      throw new Error(`duplicate release filename ${filename}`);
    seenBasenames.add(filename);
    const sourcePath = join(directory, filename);
    if (expected.kind === "update-manifest") {
      updateManifests.push({ path: sourcePath, platform: expected.platform });
    } else {
      assertArtifactVersion(filename, options.appVersion);
    }
    const identity = hashStableRegularFile(root, sourcePath);
    assets.push({
      artifactName: expected.artifactName,
      filename,
      platform: expected.platform,
      kind: expected.kind,
      size: identity.size,
      sha256: identity.sha256,
      sha512: identity.sha512,
    });
  }
  for (const update of updateManifests) {
    assertUpdateManifest(
      update.path,
      options.appVersion,
      assets.filter(
        (asset) =>
          asset.platform === update.platform &&
          asset.kind !== "update-manifest",
      ),
    );
  }
  assets.sort((left, right) => left.filename.localeCompare(right.filename));
  mkdirSync(output, { recursive: false });
  const staged = join(output, "assets");
  mkdirSync(staged);
  for (const asset of assets) {
    const source = join(root, asset.artifactName, asset.filename);
    const destination = join(staged, asset.filename);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    const copied = hashStableRegularFile(output, destination);
    if (
      copied.sha256 !== asset.sha256 ||
      copied.sha512 !== asset.sha512 ||
      copied.size !== asset.size
    )
      throw new Error(`${asset.filename} changed while staging`);
  }
  const manifest = {
    schemaVersion: 1,
    generatedBy: "release-artifact-verifier",
    releaseSurface: contract.releaseSurface,
    repository: options.repository,
    sourceCommit: options.commit,
    ref: options.ref,
    releaseTag: options.releaseTag,
    appVersion: options.appVersion,
    runId: options.runId,
    assets,
  };
  writeFileSync(
    join(output, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  writeFileSync(
    join(output, "SHA256SUMS"),
    assets.map((asset) => `${asset.sha256}  ${asset.filename}`).join("\n") +
      "\n",
    { flag: "wx" },
  );
  return manifest;
}

function assertArtifactVersion(filename, appVersion) {
  const escaped = appVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`(?:^|[^0-9])${escaped}(?:[^0-9]|$)`, "u");
  if (!token.test(filename)) {
    throw new Error(`${filename} does not identify app version ${appVersion}`);
  }
}

function assertUpdateManifest(path, appVersion, expectedAssets) {
  const contents = readFileSync(path, "utf8");
  const matches = [
    ...contents.matchAll(/^version:\s*["']?([^\s"']+)["']?\s*$/gmu),
  ];
  if (matches.length !== 1 || matches[0][1] !== appVersion) {
    throw new Error(`${path} does not identify app version ${appVersion}`);
  }
  const entries = parseUpdateFiles(contents, path);
  const expectedByName = new Map(
    expectedAssets.map((asset) => [asset.filename, asset]),
  );
  if (
    entries.length !== expectedByName.size ||
    new Set(entries.map((entry) => entry.url)).size !== entries.length ||
    entries.some((entry) => !expectedByName.has(entry.url))
  ) {
    throw new Error(
      `${path} does not reference the exact platform release set`,
    );
  }
  for (const entry of entries) {
    const expected = expectedByName.get(entry.url);
    if (
      entry.sha512 !== expected.sha512 ||
      (entry.size !== undefined && entry.size !== expected.size)
    ) {
      throw new Error(`${path} has stale identity for ${entry.url}`);
    }
  }
  const primaryPath = topLevelValue(contents, "path");
  const primarySha512 = topLevelValue(contents, "sha512");
  const primary = entries.find((entry) => entry.url === primaryPath);
  if (!primary || primary.sha512 !== primarySha512) {
    throw new Error(`${path} has an invalid primary update identity`);
  }
}

function parseUpdateFiles(contents, path) {
  const lines = contents.replace(/\r\n/g, "\n").split("\n");
  const fileBlocks = lines
    .map((line, lineIndex) => (line === "files:" ? lineIndex : -1))
    .filter((lineIndex) => lineIndex >= 0);
  if (fileBlocks.length !== 1)
    throw new Error(`${path} must have exactly one files list`);
  const filesIndex = fileBlocks[0];
  const entries = [];
  let index = filesIndex + 1;
  while (index < lines.length && lines[index].startsWith(" ")) {
    const match = lines[index].match(/^  - url: ([^\s].*)$/u);
    if (!match) throw new Error(`${path} has malformed files metadata`);
    const entry = { url: match[1] };
    index += 1;
    while (index < lines.length && lines[index].startsWith("    ")) {
      const field = lines[index].match(/^    ([A-Za-z][A-Za-z0-9]*): (.+)$/u);
      if (!field) throw new Error(`${path} has malformed file metadata`);
      if (!["sha512", "size", "blockMapSize"].includes(field[1]))
        throw new Error(`${path} has unsupported file metadata ${field[1]}`);
      if (field[1] === "sha512") {
        if (entry.sha512 !== undefined)
          throw new Error(`${path} has duplicate file sha512`);
        entry.sha512 = field[2];
      }
      if (field[1] === "size") {
        if (entry.size !== undefined)
          throw new Error(`${path} has duplicate file size`);
        if (!/^[1-9][0-9]*$/.test(field[2]))
          throw new Error(`${path} has invalid file size`);
        entry.size = Number(field[2]);
      }
      if (field[1] === "blockMapSize") {
        if (entry.blockMapSize !== undefined)
          throw new Error(`${path} has duplicate block map size`);
        if (!/^[1-9][0-9]*$/.test(field[2]))
          throw new Error(`${path} has invalid block map size`);
        entry.blockMapSize = Number(field[2]);
      }
      index += 1;
    }
    if (
      typeof entry.sha512 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)
    ) {
      throw new Error(`${path} has invalid file sha512`);
    }
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error(`${path} has an empty files list`);
  if (lines.slice(index).some((line) => /^\s+-\s/u.test(line)))
    throw new Error(`${path} has trailing files metadata`);
  return entries;
}

function topLevelValue(contents, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...contents.matchAll(
      new RegExp(`^${escaped}: ["']?([^\\s"']+)["']?\\s*$`, "gmu"),
    ),
  ];
  if (matches.length !== 1)
    throw new Error(`update manifest has invalid ${key}`);
  return matches[0][1];
}

function statDirectoryFiles(directory) {
  const resolved = realpathSync(directory);
  const entries = readFileNames(resolved);
  for (const entry of entries) {
    if (entry === "." || entry === ".." || basename(entry) !== entry)
      throw new Error(`invalid artifact filename ${entry}`);
  }
  return entries;
}

function readFileNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error(`${join(directory, entry.name)} is not a regular file`);
      return entry.name;
    })
    .sort();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  generateReleaseManifest({
    root: args.root,
    output: args.output,
    contract: args.contract,
    repository: args.repository,
    commit: args.commit,
    ref: args.ref,
    releaseTag: args.releaseTag,
    appVersion: args.appVersion,
    runId: args.runId,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
