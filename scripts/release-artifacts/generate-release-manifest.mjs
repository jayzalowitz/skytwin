#!/usr/bin/env node

import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_RELEASE_ASSETS } from "../release-claims/release-constants.mjs";
import {
  pathsOverlap,
  readStableRegularFile,
  stageStableRegularFile,
} from "./file-integrity.mjs";
import { writeReleaseSpdx } from "./generate-release-spdx.mjs";

const PLATFORMS = new Map([
  ["SkyTwin-macOS-dmg", "macos"],
  ["SkyTwin-macOS-zip", "macos"],
  ["SkyTwin-macOS-update-manifest", "macos"],
  ["SkyTwin-Windows-installer", "windows"],
  ["SkyTwin-Windows-update-manifest", "windows"],
  ["SkyTwin-Linux-AppImage", "linux"],
  ["SkyTwin-Linux-deb", "linux"],
  ["SkyTwin-Linux-rpm", "linux"],
  ["SkyTwin-Linux-update-manifest", "linux"],
]);

const UPDATE_TARGETS = new Map([
  [
    "SkyTwin-macOS-update-manifest",
    {
      primary: "SkyTwin-macOS-zip",
      artifacts: ["SkyTwin-macOS-zip", "SkyTwin-macOS-dmg"],
    },
  ],
  [
    "SkyTwin-Windows-update-manifest",
    {
      primary: "SkyTwin-Windows-installer",
      artifacts: ["SkyTwin-Windows-installer"],
    },
  ],
  [
    "SkyTwin-Linux-update-manifest",
    {
      primary: "SkyTwin-Linux-AppImage",
      artifacts: [
        "SkyTwin-Linux-AppImage",
        "SkyTwin-Linux-deb",
        "SkyTwin-Linux-rpm",
      ],
    },
  ],
]);

export function expectedFilename(artifactName, appVersion) {
  const version = appVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new Map([
    [
      "SkyTwin-macOS-dmg",
      new RegExp(`^SkyTwin-${version}-(?:arm64|x64)\\.dmg$`, "u"),
    ],
    [
      "SkyTwin-macOS-zip",
      new RegExp(`^SkyTwin-${version}-(?:arm64|x64)-mac\\.zip$`, "u"),
    ],
    ["SkyTwin-macOS-update-manifest", /^latest-mac\.yml$/u],
    [
      "SkyTwin-Windows-installer",
      new RegExp(`^SkyTwin-Setup-${version}\\.exe$`, "u"),
    ],
    ["SkyTwin-Windows-update-manifest", /^latest\.yml$/u],
    [
      "SkyTwin-Linux-AppImage",
      new RegExp(`^SkyTwin-${version}\\.AppImage$`, "u"),
    ],
    [
      "SkyTwin-Linux-deb",
      new RegExp(`^skytwin-desktop_${version}_(?:amd64|arm64)\\.deb$`, "u"),
    ],
    [
      "SkyTwin-Linux-rpm",
      new RegExp(
        `^skytwin-desktop-${version}\\.(?:x86_64|aarch64)\\.rpm$`,
        "u",
      ),
    ],
    ["SkyTwin-Linux-update-manifest", /^latest-linux\.yml$/u],
  ]).get(artifactName);
}

export function artifactPlatform(artifactName) {
  return PLATFORMS.get(artifactName);
}

const REQUIRED_OPTIONS = [
  "root",
  "output",
  "repository",
  "commit",
  "ref",
  "releaseTag",
  "appVersion",
  "runId",
  "created",
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
  for (const name of REQUIRED_OPTIONS)
    if (!result[name]) throw new Error(`missing --${name}`);
  return result;
}

function canonicalTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return (
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().replace(".000Z", "Z") === value
  );
}

export function assertReleaseIdentity(identity) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.repository ?? ""))
    throw new Error("repository must be owner/name");
  if (!/^[0-9a-f]{40}$/u.test(identity.commit ?? ""))
    throw new Error("commit must be a full lowercase Git SHA");
  if (
    typeof identity.releaseTag !== "string" ||
    !/^v[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(identity.releaseTag)
  )
    throw new Error("releaseTag must be an explicit safe v-prefixed tag");
  if (identity.ref !== `refs/tags/${identity.releaseTag}`)
    throw new Error("ref must identify releaseTag exactly");
  if (!/^[1-9][0-9]*$/u.test(String(identity.runId ?? "")))
    throw new Error("runId must be a positive integer");
  if (
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(
      identity.appVersion ?? "",
    )
  )
    throw new Error(
      "appVersion must be an explicit three-segment numeric version",
    );
  if (!canonicalTimestamp(identity.created ?? ""))
    throw new Error(
      "created must be an exact UTC timestamp without fractional seconds",
    );
}

function exactDirectoryNames(root) {
  const expected = CANONICAL_RELEASE_ASSETS.map(([name]) => name).sort();
  const actual = readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error(
          `${join(root, entry.name)} is not a real artifact directory`,
        );
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "artifact root must contain exactly the nine canonical artifact directories",
    );
}

function directRegularFiles(directory) {
  const directoryStat = lstatSync(directory, { bigint: true });
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error(`${directory} is not a real artifact directory`);
  const files = readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      if (
        basename(entry.name) !== entry.name ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      )
        throw new Error(
          `${join(directory, entry.name)} is not a direct regular file`,
        );
      return entry.name;
    })
    .sort();
  if (files.length === 0)
    throw new Error(`${directory} contains no release subjects`);
  return files;
}

function assertArtifactVersion(filename, appVersion) {
  const escaped = appVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`(?:^|[^0-9])${escaped}(?:[^0-9]|$)`, "u").test(filename))
    throw new Error(`${filename} does not identify app version ${appVersion}`);
}

function topLevelValue(contents, key) {
  const matches = [
    ...contents.matchAll(
      new RegExp(`^${key}:\\s*(?:"([^"]+)"|'([^']+)'|(.+?))\\s*$`, "gmu"),
    ),
  ];
  if (matches.length !== 1)
    throw new Error(`update manifest has invalid ${key}`);
  return matches[0][1] ?? matches[0][2] ?? matches[0][3];
}

function plainYamlScalar(value, path) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1);
    if (unquoted.includes(trimmed[0]))
      throw new Error(`${path} has unsupported quoted metadata`);
    return unquoted;
  }
  if (trimmed.includes('"') || trimmed.includes("'"))
    throw new Error(`${path} has malformed scalar metadata`);
  return trimmed;
}

function parseUpdateFiles(contents, path) {
  const lines = contents.replace(/\r\n/gu, "\n").split("\n");
  const starts = lines
    .map((line, index) => (line === "files:" ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length !== 1)
    throw new Error(`${path} must have exactly one files list`);
  const entries = [];
  let index = starts[0] + 1;
  while (index < lines.length && lines[index].startsWith(" ")) {
    const match = lines[index].match(/^  - url: ([^\s].*)$/u);
    if (!match) throw new Error(`${path} has malformed files metadata`);
    const entry = { url: plainYamlScalar(match[1], path) };
    index += 1;
    while (index < lines.length && lines[index].startsWith("    ")) {
      const field = lines[index].match(/^    ([A-Za-z][A-Za-z0-9]*): (.+)$/u);
      if (!field || !["sha512", "size", "blockMapSize"].includes(field[1]))
        throw new Error(`${path} has unsupported file metadata`);
      if (entry[field[1]] !== undefined)
        throw new Error(`${path} has duplicate file ${field[1]}`);
      if (["size", "blockMapSize"].includes(field[1])) {
        if (!/^[1-9][0-9]*$/u.test(field[2]))
          throw new Error(`${path} has invalid file ${field[1]}`);
        entry[field[1]] = Number(field[2]);
      } else entry[field[1]] = plainYamlScalar(field[2], path);
      index += 1;
    }
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(entry.sha512 ?? ""))
      throw new Error(`${path} has invalid file sha512`);
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error(`${path} has an empty files list`);
  if (lines.slice(index).some((line) => /^\s+-\s/u.test(line)))
    throw new Error(`${path} has trailing files metadata`);
  return entries;
}

export function assertUpdateManifest(asset, assets, appVersion, output) {
  const contents = readStableRegularFile(
    output,
    join(output, asset.stagedPath),
    { maxBytes: 4 * 1024 * 1024 },
  ).bytes.toString("utf8");
  if (topLevelValue(contents, "version") !== appVersion)
    throw new Error(
      `${asset.filename} does not identify app version ${appVersion}`,
    );
  const contract = UPDATE_TARGETS.get(asset.artifactName);
  if (!contract)
    throw new Error(`${asset.filename} has no canonical updater contract`);
  const available = new Map(
    assets
      .filter((candidate) =>
        contract.artifacts.includes(candidate.artifactName),
      )
      .map((candidate) => [candidate.filename, candidate]),
  );
  const entries = parseUpdateFiles(contents, asset.filename);
  if (entries.length !== contract.artifacts.length)
    throw new Error(
      `${asset.filename} must contain exactly ${contract.artifacts.length} updater subjects`,
    );
  if (new Set(entries.map((entry) => entry.url)).size !== entries.length)
    throw new Error(`${asset.filename} has duplicate updater subjects`);
  for (const entry of entries) {
    if (basename(entry.url) !== entry.url)
      throw new Error(`${asset.filename} references a non-local subject`);
    const expected = available.get(entry.url);
    if (!expected)
      throw new Error(
        `${asset.filename} references an unexpected subject ${entry.url}`,
      );
    if (
      entry.sha512 !== expected.sha512 ||
      (entry.size !== undefined && entry.size !== expected.size)
    )
      throw new Error(`${asset.filename} has stale identity for ${entry.url}`);
  }
  if (
    available.size !== contract.artifacts.length ||
    entries.some((entry) => !available.has(entry.url)) ||
    [...available].some(
      ([name]) => !entries.some((entry) => entry.url === name),
    )
  )
    throw new Error(
      `${asset.filename} does not cover its exact updater subjects`,
    );
  const primary = entries.find(
    (entry) => entry.url === topLevelValue(contents, "path"),
  );
  const expectedPrimary = assets.find(
    (candidate) => candidate.artifactName === contract.primary,
  );
  if (
    !primary ||
    !expectedPrimary ||
    primary.url !== expectedPrimary.filename ||
    primary.sha512 !== topLevelValue(contents, "sha512")
  )
    throw new Error(`${asset.filename} has an invalid primary update identity`);
}

export function generateReleaseManifest(options) {
  assertReleaseIdentity(options);
  const root = resolve(options.root);
  const output = resolve(options.output);
  if (pathsOverlap(root, output))
    throw new Error("artifact root and output must not overlap");
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("artifact root must be a real directory");
  exactDirectoryNames(root);
  mkdirSync(output, { recursive: false });
  mkdirSync(join(output, "assets"));

  const assets = [];
  const seenFilenames = new Set();
  for (const [artifactName, kind] of CANONICAL_RELEASE_ASSETS) {
    const directory = join(root, artifactName);
    const filenames = directRegularFiles(directory);
    if (filenames.length !== 1)
      throw new Error(
        `${artifactName} must contain exactly one release subject`,
      );
    for (const filename of filenames) {
      if (!expectedFilename(artifactName, options.appVersion)?.test(filename))
        throw new Error(`${artifactName} has unexpected filename ${filename}`);
      if (seenFilenames.has(filename))
        throw new Error(`duplicate release filename ${filename}`);
      seenFilenames.add(filename);
      if (kind !== "update-manifest")
        assertArtifactVersion(filename, options.appVersion);
      const stagedPath = posix.join("assets", filename);
      const identity = stageStableRegularFile(
        root,
        join(directory, filename),
        join(output, stagedPath),
        options.testHooks?.[artifactName],
      );
      if (identity.size === 0)
        throw new Error(`${artifactName} contains an empty release subject`);
      assets.push({
        artifactName,
        filename,
        subjectPath: posix.join("artifacts", artifactName, filename),
        stagedPath,
        platform: PLATFORMS.get(artifactName),
        kind,
        size: identity.size,
        sha1: identity.sha1,
        sha256: identity.sha256,
        sha512: identity.sha512,
      });
    }
  }
  assets.sort((left, right) =>
    left.filename < right.filename
      ? -1
      : left.filename > right.filename
        ? 1
        : 0,
  );
  for (const asset of assets.filter(({ kind }) => kind === "update-manifest"))
    assertUpdateManifest(asset, assets, options.appVersion, output);

  const manifest = {
    schemaVersion: 2,
    generatedBy: "release-artifact-material-generator",
    releaseSurface: "desktop",
    repository: options.repository,
    sourceCommit: options.commit,
    sourceRef: options.ref,
    releaseTag: options.releaseTag,
    appVersion: options.appVersion,
    runId: String(options.runId),
    created: options.created,
    assets,
  };
  const manifestPath = join(output, "release-artifact-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  const verificationDirectory = join(output, "artifact-verification");
  mkdirSync(verificationDirectory);
  writeFileSync(
    join(verificationDirectory, "SHA256SUMS"),
    `${assets.map((asset) => `${asset.sha256}  ${asset.filename}`).join("\n")}\n`,
    { flag: "wx" },
  );
  writeReleaseSpdx({
    root: output,
    manifest,
    output: join(verificationDirectory, "release.spdx.json"),
  });
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  generateReleaseManifest({
    root: args.root,
    output: args.output,
    repository: args.repository,
    commit: args.commit,
    ref: args.ref,
    releaseTag: args.releaseTag,
    appVersion: args.appVersion,
    runId: args.runId,
    created: args.created,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
