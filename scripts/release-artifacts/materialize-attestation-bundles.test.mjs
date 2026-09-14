import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalVerificationInstructions } from "../release-claims/check-release-claims.mjs";
import { generateReleaseManifest } from "./generate-release-manifest.mjs";
import {
  buildVerificationInstructions,
  materializeAttestationBundles,
} from "./materialize-attestation-bundles.mjs";

const temporary = [];
const VERSION = "0.7.0";

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function sha512(value) {
  return createHash("sha512").update(value).digest("base64");
}

function updateManifest(name, bytes) {
  const digest = sha512(bytes);
  return `version: ${VERSION}\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${Buffer.byteLength(bytes)}\npath: ${name}\nsha512: ${digest}\n`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "skytwin-release-bundles-"));
  temporary.push(directory);
  const root = join(directory, "artifacts");
  const output = join(directory, "output");
  const subjects = new Map([
    ["SkyTwin-macOS-dmg", [[`SkyTwin-${VERSION}-arm64.dmg`, "mac dmg"]]],
    ["SkyTwin-macOS-zip", [[`SkyTwin-${VERSION}-arm64.zip`, "mac zip"]]],
    [
      "SkyTwin-macOS-update-manifest",
      [
        [
          "latest-mac.yml",
          updateManifest(`SkyTwin-${VERSION}-arm64.zip`, "mac zip"),
        ],
      ],
    ],
    [
      "SkyTwin-Windows-installer",
      [[`SkyTwin Setup ${VERSION}.exe`, "windows exe"]],
    ],
    [
      "SkyTwin-Windows-update-manifest",
      [
        [
          "latest.yml",
          updateManifest(`SkyTwin Setup ${VERSION}.exe`, "windows exe"),
        ],
      ],
    ],
    ["SkyTwin-Linux-AppImage", [[`SkyTwin-${VERSION}.AppImage`, "appimage"]]],
    ["SkyTwin-Linux-deb", [[`skytwin-desktop_${VERSION}_amd64.deb`, "deb"]]],
    ["SkyTwin-Linux-rpm", [[`skytwin-desktop-${VERSION}.x86_64.rpm`, "rpm"]]],
    [
      "SkyTwin-Linux-update-manifest",
      [
        [
          "latest-linux.yml",
          updateManifest(`SkyTwin-${VERSION}.AppImage`, "appimage"),
        ],
      ],
    ],
  ]);
  mkdirSync(root);
  for (const [artifactName, files] of subjects) {
    const artifactDirectory = join(root, artifactName);
    mkdirSync(artifactDirectory);
    for (const [name, bytes] of files)
      writeFileSync(join(artifactDirectory, name), bytes);
  }
  return { directory, root, output };
}

function prepared() {
  const value = fixture();
  const manifest = generateReleaseManifest({
    ...value,
    repository: "owner/repo",
    commit: "a".repeat(40),
    ref: "refs/tags/v0.7.0-beta",
    releaseTag: "v0.7.0-beta",
    appVersion: "0.7.0",
    runId: "42",
    created: "2026-09-14T18:00:00Z",
  });
  const bundleRoot = mkdtempSync(join(tmpdir(), "skytwin-attestation-bundle-"));
  temporary.push(bundleRoot);
  const bundle = join(bundleRoot, "bundle.jsonl");
  writeFileSync(bundle, `${JSON.stringify({ bundle: "verified fixture" })}\n`);
  return {
    ...value,
    manifest,
    manifestPath: join(value.output, "release-artifact-manifest.json"),
    verificationDirectory: join(value.output, "artifact-verification"),
    bundle,
    bundleRoot,
  };
}

describe("attestation bundle materializer", () => {
  it("offers a CLI that completes the canonical verification directory", () => {
    const value = prepared();
    const result = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./materialize-attestation-bundles.mjs", import.meta.url),
        ),
        "--manifest",
        value.manifestPath,
        "--bundle",
        value.bundle,
        "--output",
        value.verificationDirectory,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({ subjects: 9, bundles: 9 });
    expect(
      readFileSync(join(value.verificationDirectory, "VERIFY.md"), "utf8"),
    ).toContain("gh attestation verify");
  });

  it("writes canonical instructions and one exact bundle path per subject digest", () => {
    const value = prepared();
    const result = materializeAttestationBundles({
      manifest: value.manifestPath,
      bundle: value.bundle,
      output: value.verificationDirectory,
    });
    expect(result).toEqual({ subjects: 9, bundles: 9 });
    const expectedBundle = readFileSync(value.bundle);
    for (const asset of value.manifest.assets)
      expect(
        readFileSync(
          join(
            value.verificationDirectory,
            `${asset.sha256}.attestation.jsonl`,
          ),
        ),
      ).toEqual(expectedBundle);
    const instructions = readFileSync(
      join(value.verificationDirectory, "VERIFY.md"),
      "utf8",
    );
    const instructionInput = {
      subjects: value.manifest.assets.map((asset) => ({
        name: asset.filename,
        sha256: asset.sha256,
      })),
      repository: value.manifest.repository,
      sourceCommit: value.manifest.sourceCommit,
      sourceRef: value.manifest.sourceRef,
    };
    expect(buildVerificationInstructions(instructionInput)).toBe(
      buildCanonicalVerificationInstructions(instructionInput),
    );
    expect(instructions).toContain(
      "--source-digest 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    );
    expect(instructions).toContain("--source-ref 'refs/tags/v0.7.0-beta'");
    expect(instructions.match(/gh attestation verify/gu)).toHaveLength(9);
  });

  it("deduplicates bundle filenames when two subjects have identical bytes", () => {
    const base = fixture();
    const shared = "identical package bytes";
    writeFileSync(
      join(base.root, "SkyTwin-macOS-dmg", `SkyTwin-${VERSION}-arm64.dmg`),
      shared,
    );
    writeFileSync(
      join(base.root, "SkyTwin-Linux-AppImage", `SkyTwin-${VERSION}.AppImage`),
      shared,
    );
    writeFileSync(
      join(base.root, "SkyTwin-Linux-update-manifest", "latest-linux.yml"),
      updateManifest(`SkyTwin-${VERSION}.AppImage`, shared),
    );
    const manifest = generateReleaseManifest({
      ...base,
      repository: "owner/repo",
      commit: "a".repeat(40),
      ref: "refs/tags/v0.7.0-beta",
      releaseTag: "v0.7.0-beta",
      appVersion: VERSION,
      runId: "42",
      created: "2026-09-14T18:00:00Z",
    });
    const bundleRoot = mkdtempSync(
      join(tmpdir(), "skytwin-attestation-bundle-"),
    );
    temporary.push(bundleRoot);
    const bundle = join(bundleRoot, "bundle.jsonl");
    writeFileSync(
      bundle,
      `${JSON.stringify({ bundle: "verified fixture" })}\n`,
    );
    const value = {
      ...base,
      manifest,
      manifestPath: join(base.output, "release-artifact-manifest.json"),
      verificationDirectory: join(base.output, "artifact-verification"),
      bundle,
    };
    const result = materializeAttestationBundles({
      manifest: value.manifestPath,
      bundle: value.bundle,
      output: value.verificationDirectory,
    });
    expect(result).toEqual({ subjects: 9, bundles: 8 });
  });

  it("rejects empty, malformed, array-valued, and symlink bundles", () => {
    for (const contents of ["", "not json\n", "[]\n"]) {
      const value = prepared();
      writeFileSync(value.bundle, contents);
      expect(() =>
        materializeAttestationBundles({
          manifest: value.manifestPath,
          bundle: value.bundle,
          output: value.verificationDirectory,
        }),
      ).toThrow("attestation bundle");
    }
    const linked = prepared();
    const real = join(linked.bundleRoot, "real.jsonl");
    renameSync(linked.bundle, real);
    symlinkSync(real, linked.bundle);
    expect(() =>
      materializeAttestationBundles({
        manifest: linked.manifestPath,
        bundle: linked.bundle,
        output: linked.verificationDirectory,
      }),
    ).toThrow("not a regular file");
  });

  it("refuses any pre-existing target without replacing it", () => {
    const value = prepared();
    writeFileSync(
      join(value.verificationDirectory, "VERIFY.md"),
      "operator file",
    );
    expect(() =>
      materializeAttestationBundles({
        manifest: value.manifestPath,
        bundle: value.bundle,
        output: value.verificationDirectory,
      }),
    ).toThrow("refusing to overwrite");
    expect(
      readFileSync(join(value.verificationDirectory, "VERIFY.md"), "utf8"),
    ).toBe("operator file");

    const bundleTarget = prepared();
    const target = join(
      bundleTarget.verificationDirectory,
      `${bundleTarget.manifest.assets[0].sha256}.attestation.jsonl`,
    );
    writeFileSync(target, "operator file");
    expect(() =>
      materializeAttestationBundles({
        manifest: bundleTarget.manifestPath,
        bundle: bundleTarget.bundle,
        output: bundleTarget.verificationDirectory,
      }),
    ).toThrow("refusing to overwrite");
    expect(readFileSync(target, "utf8")).toBe("operator file");
  });

  it("detects a bundle pathname swap after opening", () => {
    const value = prepared();
    expect(() =>
      materializeAttestationBundles({
        manifest: value.manifestPath,
        bundle: value.bundle,
        output: value.verificationDirectory,
        testHooks: {
          bundle: {
            afterOpen(path) {
              renameSync(path, `${path}.original`);
              writeFileSync(path, `${JSON.stringify({ attacker: true })}\n`);
            },
          },
        },
      }),
    ).toThrow("changed while reading");
  });

  it("rejects a symlink output directory", () => {
    const value = prepared();
    const actual = join(value.directory, "alternate-output");
    mkdirSync(actual);
    rmSync(value.verificationDirectory, { recursive: true });
    symlinkSync(actual, value.verificationDirectory);
    expect(() =>
      materializeAttestationBundles({
        manifest: value.manifestPath,
        bundle: value.bundle,
        output: value.verificationDirectory,
      }),
    ).toThrow("real directory");
  });

  it("rejects a real but non-canonical output directory", () => {
    const value = prepared();
    const alternate = join(value.directory, "alternate-output");
    mkdirSync(alternate);
    expect(() =>
      materializeAttestationBundles({
        manifest: value.manifestPath,
        bundle: value.bundle,
        output: alternate,
      }),
    ).toThrow("canonical artifact-verification directory");
  });
});
