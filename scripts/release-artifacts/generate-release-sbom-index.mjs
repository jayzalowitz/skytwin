#!/usr/bin/env node

import {
  constants,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashStableRegularFile } from "./generate-release-manifest.mjs";

const PLATFORMS = ["macos", "windows", "linux"];

function deterministicUuid(input) {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validPlatformSbom(value) {
  return (
    value &&
    typeof value === "object" &&
    value.bomFormat === "CycloneDX" &&
    typeof value.specVersion === "string" &&
    /^1\.[5-9]$/.test(value.specVersion) &&
    typeof value.serialNumber === "string" &&
    /^urn:uuid:[0-9a-f-]{36}$/i.test(value.serialNumber) &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    value.metadata &&
    typeof value.metadata === "object" &&
    Array.isArray(value.components) &&
    value.components.length > 0
  );
}

export function generateReleaseSbomIndex(options) {
  const manifestPath = resolve(options.manifest);
  const sbomRoot = resolve(options.sbomRoot);
  const output = resolve(options.output);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.generatedBy !== "release-artifact-verifier" ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length === 0
  )
    throw new Error("invalid release manifest");
  const platformSboms = new Map();
  for (const platform of PLATFORMS) {
    const filename = `${platform}.cdx.json`;
    const path = join(sbomRoot, filename);
    const identity = hashStableRegularFile(sbomRoot, path);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!validPlatformSbom(parsed))
      throw new Error(`${filename} is not a supported CycloneDX SBOM`);
    platformSboms.set(platform, { filename, identity, parsed });
  }
  const canonicalManifest = JSON.stringify(manifest);
  const stagedSbomRoot = join(dirname(output), "sboms");
  mkdirSync(stagedSbomRoot, { recursive: false });
  for (const { filename, identity } of platformSboms.values()) {
    const destination = join(stagedSbomRoot, filename);
    copyFileSync(
      join(sbomRoot, filename),
      destination,
      constants.COPYFILE_EXCL,
    );
    const stagedIdentity = hashStableRegularFile(dirname(output), destination);
    if (
      stagedIdentity.sha256 !== identity.sha256 ||
      stagedIdentity.size !== identity.size
    ) {
      throw new Error(`${filename} changed while staging`);
    }
  }
  const components = manifest.assets.map((asset) => {
    if (!PLATFORMS.includes(asset.platform))
      throw new Error(`unexpected asset platform ${asset.platform}`);
    const platformSbom = platformSboms.get(asset.platform);
    return {
      type: "application",
      "bom-ref": `artifact:sha256:${asset.sha256}`,
      name: asset.filename,
      version: manifest.releaseTag,
      hashes: [{ alg: "SHA-256", content: asset.sha256 }],
      externalReferences: [
        { type: "bom", url: platformSbom.parsed.serialNumber },
      ],
      properties: [
        { name: "skytwin:artifact-name", value: asset.artifactName },
        { name: "skytwin:platform", value: asset.platform },
        { name: "skytwin:kind", value: asset.kind },
        { name: "skytwin:source-commit", value: manifest.sourceCommit },
        { name: "skytwin:platform-sbom-file", value: platformSbom.filename },
        {
          name: "skytwin:platform-sbom-sha256",
          value: platformSbom.identity.sha256,
        },
      ],
    };
  });
  const index = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${deterministicUuid(canonicalManifest)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `release:${manifest.repository}:${manifest.releaseTag}`,
        name: "SkyTwin desktop release",
        version: manifest.releaseTag,
        properties: [
          { name: "skytwin:repository", value: manifest.repository },
          { name: "skytwin:source-commit", value: manifest.sourceCommit },
          { name: "skytwin:workflow-run-id", value: manifest.runId },
        ],
      },
    },
    components,
  };
  writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
  return index;
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
  for (const name of ["manifest", "sbom-root", "output"])
    if (!result[name]) throw new Error(`missing --${name}`);
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  generateReleaseSbomIndex({
    manifest: args.manifest,
    sbomRoot: args["sbom-root"],
    output: args.output,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
