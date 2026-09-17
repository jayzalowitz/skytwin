#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_RELEASE_ASSETS } from "../release-claims/release-constants.mjs";
import {
  hashStableRegularFile,
  readStableRegularFile,
} from "./file-integrity.mjs";
import {
  artifactPlatform,
  assertUpdateManifest,
  assertReleaseIdentity,
  expectedFilename,
} from "./generate-release-manifest.mjs";
import {
  assertArtifactManifest,
  buildReleaseSpdx,
} from "./generate-release-spdx.mjs";

const MANIFEST_KEYS = [
  "schemaVersion",
  "generatedBy",
  "releaseSurface",
  "repository",
  "sourceCommit",
  "sourceRef",
  "releaseTag",
  "appVersion",
  "runId",
  "created",
  "assets",
].sort();
const ASSET_KEYS = [
  "artifactName",
  "filename",
  "subjectPath",
  "stagedPath",
  "platform",
  "kind",
  "size",
  "sha1",
  "sha256",
  "sha512",
].sort();

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  );
}

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
  for (const name of ["root", "manifest"])
    if (!result[name]) throw new Error(`missing --${name}`);
  return result;
}

export function readArtifactManifest(root, path) {
  const bytes = readStableRegularFile(root, resolve(path), {
    maxBytes: 16 * 1024 * 1024,
  }).bytes;
  const manifest = JSON.parse(bytes.toString("utf8"));
  assertArtifactManifest(manifest);
  if (
    !exactKeys(manifest, MANIFEST_KEYS) ||
    manifest.releaseSurface !== "desktop"
  )
    throw new Error("invalid release artifact manifest shape");
  return manifest;
}

export function verifyReleaseManifest(options) {
  const root = resolve(options.root);
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("release material root must be a real directory");
  const rootEntries = readdirSync(root, { withFileTypes: true });
  const rootInventory = rootEntries.map((entry) => entry.name).sort();
  if (
    JSON.stringify(rootInventory) !==
      JSON.stringify(
        [
          "artifact-verification",
          "assets",
          "release-artifact-manifest.json",
        ].sort(),
      ) ||
    rootEntries.some(
      (entry) =>
        entry.isSymbolicLink() ||
        (["artifact-verification", "assets"].includes(entry.name)
          ? !entry.isDirectory()
          : !entry.isFile()),
    )
  )
    throw new Error("release material root has an unexpected inventory");
  const manifest = readArtifactManifest(root, options.manifest);
  assertReleaseIdentity({
    repository: manifest.repository,
    commit: manifest.sourceCommit,
    ref: manifest.sourceRef,
    releaseTag: manifest.releaseTag,
    appVersion: manifest.appVersion,
    runId: manifest.runId,
    created: manifest.created,
  });
  const optionFields = new Map([
    ["repository", "repository"],
    ["commit", "sourceCommit"],
    ["ref", "sourceRef"],
    ["releaseTag", "releaseTag"],
    ["appVersion", "appVersion"],
    ["runId", "runId"],
    ["created", "created"],
  ]);
  for (const [option, field] of optionFields) {
    if (
      options[option] !== undefined &&
      String(options[option]) !== manifest[field]
    )
      throw new Error(`${field} does not match manifest`);
  }

  const canonical = new Map(CANONICAL_RELEASE_ASSETS);
  const seenFilenames = new Set();
  const seenSubjectPaths = new Set();
  const artifactCounts = new Map();
  if (manifest.assets.length !== canonical.size)
    throw new Error("manifest must contain exactly nine release subjects");
  if (
    JSON.stringify(manifest.assets.map(({ filename }) => filename)) !==
    JSON.stringify(
      manifest.assets
        .map(({ filename }) => filename)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    )
  )
    throw new Error("manifest subjects are not in canonical filename order");
  for (const asset of manifest.assets) {
    if (
      !exactKeys(asset, ASSET_KEYS) ||
      !canonical.has(asset.artifactName) ||
      asset.kind !== canonical.get(asset.artifactName) ||
      basename(asset.filename) !== asset.filename ||
      asset.subjectPath !==
        posix.join("artifacts", asset.artifactName, asset.filename) ||
      asset.stagedPath !== posix.join("assets", asset.filename) ||
      asset.platform !== artifactPlatform(asset.artifactName) ||
      !expectedFilename(asset.artifactName, manifest.appVersion)?.test(
        asset.filename,
      ) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^[0-9a-f]{40}$/u.test(asset.sha1 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(asset.sha256 ?? "") ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(asset.sha512 ?? "")
    )
      throw new Error("invalid release subject record");
    if (
      seenFilenames.has(asset.filename) ||
      seenSubjectPaths.has(asset.subjectPath)
    )
      throw new Error("duplicate release subject identity");
    seenFilenames.add(asset.filename);
    seenSubjectPaths.add(asset.subjectPath);
    artifactCounts.set(
      asset.artifactName,
      (artifactCounts.get(asset.artifactName) ?? 0) + 1,
    );
    const observed = hashStableRegularFile(root, join(root, asset.stagedPath));
    if (
      observed.size !== asset.size ||
      observed.sha1 !== asset.sha1 ||
      observed.sha256 !== asset.sha256 ||
      observed.sha512 !== asset.sha512
    )
      throw new Error(`${asset.filename} does not match manifest`);
  }
  if (
    [...canonical.keys()].some(
      (artifactName) => artifactCounts.get(artifactName) !== 1,
    )
  )
    throw new Error("manifest does not cover the exact canonical artifact set");
  for (const asset of manifest.assets.filter(
    ({ kind }) => kind === "update-manifest",
  ))
    assertUpdateManifest(asset, manifest.assets, manifest.appVersion, root);

  const actualNames = readdirSync(join(root, "assets"), { withFileTypes: true })
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        basename(entry.name) !== entry.name
      )
        throw new Error(`invalid staged release subject ${entry.name}`);
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...seenFilenames].sort()))
    throw new Error("staged release subject set does not match manifest");

  const verificationDirectory = join(root, "artifact-verification");
  for (const entry of readdirSync(verificationDirectory, {
    withFileTypes: true,
  })) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      (!["SHA256SUMS", "release.spdx.json", "VERIFY.md"].includes(entry.name) &&
        !/^[0-9a-f]{64}\.attestation\.jsonl$/u.test(entry.name))
    )
      throw new Error(
        `artifact verification directory has unexpected material ${entry.name}`,
      );
  }
  const expectedSums = `${manifest.assets.map((asset) => `${asset.sha256}  ${asset.filename}`).join("\n")}\n`;
  const actualSums = readStableRegularFile(
    verificationDirectory,
    join(verificationDirectory, "SHA256SUMS"),
    { maxBytes: 4 * 1024 * 1024 },
  ).bytes.toString("utf8");
  if (actualSums !== expectedSums)
    throw new Error("SHA256SUMS does not match manifest");
  const expectedSpdx = `${JSON.stringify(buildReleaseSpdx(manifest), null, 2)}\n`;
  const actualSpdx = readStableRegularFile(
    verificationDirectory,
    join(verificationDirectory, "release.spdx.json"),
    { maxBytes: 32 * 1024 * 1024 },
  ).bytes.toString("utf8");
  if (actualSpdx !== expectedSpdx)
    throw new Error("release.spdx.json does not match manifest");
  return {
    valid: true,
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    subjects: manifest.assets.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyReleaseManifest({
    root: args.root,
    manifest: args.manifest,
    repository: args.repository,
    commit: args.commit,
    ref: args.ref,
    releaseTag: args.releaseTag,
    appVersion: args.appVersion,
    runId: args.runId,
    created: args.created,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
