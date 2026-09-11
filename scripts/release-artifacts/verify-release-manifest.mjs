#!/usr/bin/env node

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashStableRegularFile } from "./generate-release-manifest.mjs";

const EXACT_MANIFEST_KEYS = [
  "schemaVersion",
  "generatedBy",
  "releaseSurface",
  "repository",
  "sourceCommit",
  "ref",
  "releaseTag",
  "appVersion",
  "runId",
  "assets",
].sort();
const EXACT_ASSET_KEYS = [
  "artifactName",
  "filename",
  "platform",
  "kind",
  "size",
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

export function verifyReleaseManifest(options) {
  const root = realpathSync(resolve(options.root));
  const manifestPath = resolve(options.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tagMatch =
    typeof manifest.releaseTag === "string"
      ? manifest.releaseTag.match(
          /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/,
        )
      : null;
  const expectedAppVersion = tagMatch
    ? `${tagMatch[1]}.${tagMatch[2]}.${Number(tagMatch[3]) * 100 + Number(tagMatch[4])}`
    : null;
  if (
    !exactKeys(manifest, EXACT_MANIFEST_KEYS) ||
    manifest.schemaVersion !== 1 ||
    manifest.generatedBy !== "release-artifact-verifier" ||
    manifest.releaseSurface !== "desktop" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository) ||
    !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) ||
    !tagMatch ||
    Number(tagMatch[4]) >= 100 ||
    Number(tagMatch[3]) > 999999 ||
    manifest.ref !== `refs/tags/${manifest.releaseTag}` ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
      manifest.appVersion,
    ) ||
    manifest.appVersion !== expectedAppVersion ||
    !/^[1-9][0-9]*$/.test(manifest.runId) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0
  ) {
    throw new Error("invalid release manifest");
  }
  for (const field of [
    "repository",
    "sourceCommit",
    "ref",
    "releaseTag",
    "appVersion",
    "runId",
  ]) {
    if (options[field] !== undefined && options[field] !== manifest[field])
      throw new Error(`${field} does not match manifest`);
  }
  const assetDirectory = join(root, "assets");
  const actualNames = readdirSync(assetDirectory, { withFileTypes: true })
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        basename(entry.name) !== entry.name
      ) {
        throw new Error(`invalid release asset ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  const expectedNames = [];
  const seenArtifacts = new Set();
  for (const asset of manifest.assets) {
    if (
      !exactKeys(asset, EXACT_ASSET_KEYS) ||
      typeof asset.artifactName !== "string" ||
      typeof asset.filename !== "string" ||
      basename(asset.filename) !== asset.filename ||
      !["macos", "windows", "linux"].includes(asset.platform) ||
      !["installer", "archive", "package", "update-manifest"].includes(
        asset.kind,
      ) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512)
    ) {
      throw new Error("invalid release asset record");
    }
    if (
      seenArtifacts.has(asset.artifactName) ||
      expectedNames.includes(asset.filename)
    ) {
      throw new Error("duplicate release asset identity");
    }
    seenArtifacts.add(asset.artifactName);
    expectedNames.push(asset.filename);
    const observed = hashStableRegularFile(
      root,
      join(assetDirectory, asset.filename),
    );
    if (
      observed.size !== asset.size ||
      observed.sha256 !== asset.sha256 ||
      observed.sha512 !== asset.sha512
    ) {
      throw new Error(`${asset.filename} does not match manifest`);
    }
  }
  expectedNames.sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    throw new Error("release asset set does not match manifest");
  const expectedSums =
    manifest.assets
      .map((asset) => `${asset.sha256}  ${asset.filename}`)
      .sort()
      .join("\n") + "\n";
  const sums =
    readFileSync(join(root, "SHA256SUMS"), "utf8")
      .split("\n")
      .filter(Boolean)
      .sort()
      .join("\n") + "\n";
  if (sums !== expectedSums)
    throw new Error("SHA256SUMS does not match manifest");
  return {
    valid: true,
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    assets: manifest.assets.length,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = verifyReleaseManifest({
    root: args.root,
    manifest: args.manifest,
    repository: args.repository,
    sourceCommit: args.commit,
    ref: args.ref,
    releaseTag: args["release-tag"],
    appVersion: args["app-version"],
    runId: args["run-id"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
