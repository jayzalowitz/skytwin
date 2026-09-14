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
import { isValidSpdx23Document } from "../release-claims/check-release-claims.mjs";
import { generateReleaseManifest } from "./generate-release-manifest.mjs";
import { verifyReleaseManifest } from "./verify-release-manifest.mjs";

const temporary = [];
const VERSION = "0.7.0";
const IDENTITY = Object.freeze({
  repository: "owner/repo",
  commit: "a".repeat(40),
  ref: "refs/tags/v0.7.0-beta",
  releaseTag: "v0.7.0-beta",
  appVersion: VERSION,
  runId: "42",
  created: "2026-09-14T18:00:00Z",
});

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function sha512(value) {
  return createHash("sha512").update(value).digest("base64");
}

function updateManifest(entries) {
  const primary = entries[0];
  return `version: ${VERSION}\nfiles:\n${entries
    .map(
      ({ name, bytes }) =>
        `  - url: ${name}\n    sha512: ${sha512(bytes)}\n    size: ${Buffer.byteLength(bytes)}\n`,
    )
    .join("")}path: ${primary.name}\nsha512: ${sha512(primary.bytes)}\n`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "skytwin-release-materials-"));
  temporary.push(directory);
  const root = join(directory, "artifacts");
  const output = join(directory, "output");
  const subjects = new Map([
    ["SkyTwin-macOS-dmg", [[`SkyTwin-${VERSION}-arm64.dmg`, "mac dmg"]]],
    ["SkyTwin-macOS-zip", [[`SkyTwin-${VERSION}-arm64-mac.zip`, "mac zip"]]],
    [
      "SkyTwin-Windows-installer",
      [[`SkyTwin-Setup-${VERSION}.exe`, "windows exe"]],
    ],
    ["SkyTwin-Linux-AppImage", [[`SkyTwin-${VERSION}.AppImage`, "appimage"]]],
    ["SkyTwin-Linux-deb", [[`skytwin-desktop_${VERSION}_amd64.deb`, "deb"]]],
    ["SkyTwin-Linux-rpm", [[`skytwin-desktop-${VERSION}.x86_64.rpm`, "rpm"]]],
  ]);
  subjects.set("SkyTwin-macOS-update-manifest", [
    [
      "latest-mac.yml",
      updateManifest([
        { name: `SkyTwin-${VERSION}-arm64-mac.zip`, bytes: "mac zip" },
        { name: `SkyTwin-${VERSION}-arm64.dmg`, bytes: "mac dmg" },
      ]),
    ],
  ]);
  subjects.set("SkyTwin-Windows-update-manifest", [
    [
      "latest.yml",
      updateManifest([
        { name: `SkyTwin-Setup-${VERSION}.exe`, bytes: "windows exe" },
      ]),
    ],
  ]);
  subjects.set("SkyTwin-Linux-update-manifest", [
    [
      "latest-linux.yml",
      updateManifest([
        { name: `SkyTwin-${VERSION}.AppImage`, bytes: "appimage" },
        { name: `skytwin-desktop_${VERSION}_amd64.deb`, bytes: "deb" },
        { name: `skytwin-desktop-${VERSION}.x86_64.rpm`, bytes: "rpm" },
      ]),
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

function generate(value, overrides = {}) {
  return generateReleaseManifest({ ...value, ...IDENTITY, ...overrides });
}

describe("release artifact material generator", () => {
  it("offers a cohesive CLI with explicit beta identity and timestamp inputs", () => {
    const value = fixture();
    execFileSync(process.execPath, [
      fileURLToPath(
        new URL("./generate-release-manifest.mjs", import.meta.url),
      ),
      "--root",
      value.root,
      "--output",
      value.output,
      "--repository",
      IDENTITY.repository,
      "--commit",
      IDENTITY.commit,
      "--ref",
      IDENTITY.ref,
      "--releaseTag",
      IDENTITY.releaseTag,
      "--appVersion",
      IDENTITY.appVersion,
      "--runId",
      IDENTITY.runId,
      "--created",
      IDENTITY.created,
    ]);
    expect(
      verifyReleaseManifest({
        root: value.output,
        manifest: join(value.output, "release-artifact-manifest.json"),
      }).subjects,
    ).toBe(9);
  });

  it("accepts the beta tag, stages the exact set, and emits checker-valid deterministic SPDX", () => {
    const value = fixture();
    const manifest = generate(value);
    expect(manifest.assets).toHaveLength(9);
    expect(manifest.releaseTag).toBe("v0.7.0-beta");
    expect(
      verifyReleaseManifest({
        root: value.output,
        manifest: join(value.output, "release-artifact-manifest.json"),
        ...IDENTITY,
      }),
    ).toEqual({
      valid: true,
      repository: "owner/repo",
      sourceCommit: "a".repeat(40),
      subjects: 9,
    });
    const sbom = JSON.parse(
      readFileSync(
        join(value.output, "artifact-verification", "release.spdx.json"),
        "utf8",
      ),
    );
    expect(isValidSpdx23Document(sbom)).toBe(true);
    expect(sbom.files).toHaveLength(9);
    expect(sbom.packages[0].sourceInfo).toContain(IDENTITY.commit);
    expect(sbom.packages[0].externalRefs[0].referenceLocator).toContain(
      IDENTITY.commit,
    );
    expect(sbom.creationInfo.created).toBe(IDENTITY.created);
    expect(sbom.documentNamespace).toBe(
      `https://github.com/${IDENTITY.repository}/releases/tag/${encodeURIComponent(IDENTITY.releaseTag)}/spdx/${IDENTITY.commit}/${IDENTITY.runId}/${encodeURIComponent(IDENTITY.created)}`,
    );

    const second = fixture();
    generate(second);
    for (const name of [
      "release-artifact-manifest.json",
      "artifact-verification/SHA256SUMS",
      "artifact-verification/release.spdx.json",
    ])
      expect(readFileSync(join(second.output, name))).toEqual(
        readFileSync(join(value.output, name)),
      );
  });

  it("rejects more than one direct subject in any canonical artifact directory", () => {
    const value = fixture();
    writeFileSync(
      join(value.root, "SkyTwin-macOS-dmg", `SkyTwin-${VERSION}-x64.dmg`),
      "mac x64 dmg",
    );
    expect(() => generate(value)).toThrow("exactly one release subject");
  });

  it("rejects missing, unexpected, empty, and non-directory artifact entries", () => {
    const missing = fixture();
    rmSync(join(missing.root, "SkyTwin-Linux-rpm"), { recursive: true });
    expect(() => generate(missing)).toThrow("exactly the nine canonical");

    const extra = fixture();
    mkdirSync(join(extra.root, "unexpected"));
    expect(() => generate(extra)).toThrow("exactly the nine canonical");

    const empty = fixture();
    rmSync(
      join(
        empty.root,
        "SkyTwin-Linux-rpm",
        `skytwin-desktop-${VERSION}.x86_64.rpm`,
      ),
    );
    expect(() => generate(empty)).toThrow("contains no release subjects");

    const file = fixture();
    rmSync(join(file.root, "SkyTwin-Linux-rpm"), { recursive: true });
    writeFileSync(join(file.root, "SkyTwin-Linux-rpm"), "not a directory");
    expect(() => generate(file)).toThrow("not a real artifact directory");

    const zeroByte = fixture();
    writeFileSync(
      join(
        zeroByte.root,
        "SkyTwin-Linux-rpm",
        `skytwin-desktop-${VERSION}.x86_64.rpm`,
      ),
      "",
    );
    expect(() => generate(zeroByte)).toThrow("empty release subject");
  });

  it("rejects renamed or stale-version subjects and duplicate published filenames", () => {
    const renamed = fixture();
    const old = join(
      renamed.root,
      "SkyTwin-Linux-AppImage",
      `SkyTwin-${VERSION}.AppImage`,
    );
    renameSync(old, `${old}.exe`);
    expect(() => generate(renamed)).toThrow("unexpected filename");

    const stale = fixture();
    const stalePath = join(
      stale.root,
      "SkyTwin-Windows-installer",
      `SkyTwin-Setup-${VERSION}.exe`,
    );
    renameSync(
      stalePath,
      join(stale.root, "SkyTwin-Windows-installer", "SkyTwin-Setup-0.6.0.exe"),
    );
    expect(() => generate(stale)).toThrow("unexpected filename");

    const duplicate = fixture();
    rmSync(
      join(duplicate.root, "SkyTwin-macOS-update-manifest", "latest-mac.yml"),
    );
    writeFileSync(
      join(duplicate.root, "SkyTwin-macOS-update-manifest", "latest-mac.yml"),
      "bad",
    );
    writeFileSync(
      join(duplicate.root, "SkyTwin-macOS-update-manifest", "other.yml"),
      "bad",
    );
    expect(() => generate(duplicate)).toThrow("exactly one release subject");
  });

  it("rejects file and artifact-directory symlinks", () => {
    const fileLink = fixture();
    const linked = join(
      fileLink.root,
      "SkyTwin-Linux-rpm",
      `skytwin-desktop-${VERSION}.x86_64.rpm`,
    );
    rmSync(linked);
    symlinkSync(
      join(
        fileLink.root,
        "SkyTwin-Linux-deb",
        `skytwin-desktop_${VERSION}_amd64.deb`,
      ),
      linked,
    );
    expect(() => generate(fileLink)).toThrow("not a direct regular file");

    const directoryLink = fixture();
    const target = join(directoryLink.directory, "outside");
    mkdirSync(target);
    writeFileSync(join(target, `SkyTwin-${VERSION}.AppImage`), "outside");
    rmSync(join(directoryLink.root, "SkyTwin-Linux-AppImage"), {
      recursive: true,
    });
    symlinkSync(target, join(directoryLink.root, "SkyTwin-Linux-AppImage"));
    expect(() => generate(directoryLink)).toThrow(
      "not a real artifact directory",
    );
  });

  it("rejects malformed, duplicated, non-local, unexpected, and stale updater mappings", () => {
    const duplicate = fixture();
    const path = join(
      duplicate.root,
      "SkyTwin-Linux-update-manifest",
      "latest-linux.yml",
    );
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "path:",
        `  - url: SkyTwin-${VERSION}.AppImage\n    sha512: ${sha512("appimage")}\npath:`,
      ),
    );
    expect(() => generate(duplicate)).toThrow("exactly 3 updater subjects");

    const wrongKind = fixture();
    const wrongKindPath = join(
      wrongKind.root,
      "SkyTwin-Linux-update-manifest",
      "latest-linux.yml",
    );
    writeFileSync(
      wrongKindPath,
      updateManifest([
        {
          name: `SkyTwin-${VERSION}.AppImage`,
          bytes: "appimage",
        },
        {
          name: `skytwin-desktop_${VERSION}_amd64.deb`,
          bytes: "deb",
        },
        {
          name: `SkyTwin-${VERSION}-arm64.dmg`,
          bytes: "mac dmg",
        },
      ]),
    );
    expect(() => generate(wrongKind)).toThrow("unexpected subject");

    const traversal = fixture();
    const traversalPath = join(
      traversal.root,
      "SkyTwin-Linux-update-manifest",
      "latest-linux.yml",
    );
    writeFileSync(
      traversalPath,
      readFileSync(traversalPath, "utf8").replaceAll(
        `SkyTwin-${VERSION}.AppImage`,
        `../SkyTwin-${VERSION}.AppImage`,
      ),
    );
    expect(() => generate(traversal)).toThrow("non-local subject");

    const stale = fixture();
    const stalePath = join(
      stale.root,
      "SkyTwin-Linux-update-manifest",
      "latest-linux.yml",
    );
    writeFileSync(
      stalePath,
      readFileSync(stalePath, "utf8").replace(
        sha512("appimage"),
        `${"A".repeat(86)}==`,
      ),
    );
    expect(() => generate(stale)).toThrow("stale identity");

    const malformed = fixture();
    const malformedPath = join(
      malformed.root,
      "SkyTwin-Linux-update-manifest",
      "latest-linux.yml",
    );
    writeFileSync(
      malformedPath,
      `${readFileSync(malformedPath, "utf8")}files:\n`,
    );
    expect(() => generate(malformed)).toThrow("exactly one files list");
  });

  it("detects a pathname swap after opening instead of staging mismatched bytes", () => {
    const value = fixture();
    const source = join(
      value.root,
      "SkyTwin-Linux-AppImage",
      `SkyTwin-${VERSION}.AppImage`,
    );
    expect(() =>
      generate(value, {
        testHooks: {
          "SkyTwin-Linux-AppImage": {
            afterOpen(path) {
              renameSync(path, `${path}.original`);
              writeFileSync(source, "replacement");
            },
          },
        },
      }),
    ).toThrow("changed while reading");
  });

  it("refuses output overwrite or overlap with source artifacts", () => {
    const value = fixture();
    generate(value);
    expect(() => generate(value)).toThrow();
    const overlap = fixture();
    expect(() =>
      generate(overlap, { output: join(overlap.root, "nested") }),
    ).toThrow("must not overlap");
  });

  it("detects staged-byte, checksum, SPDX, and identity tampering", () => {
    const bytes = fixture();
    generate(bytes);
    writeFileSync(
      join(bytes.output, "assets", `SkyTwin-${VERSION}.AppImage`),
      "tampered",
    );
    expect(() =>
      verifyReleaseManifest({
        root: bytes.output,
        manifest: join(bytes.output, "release-artifact-manifest.json"),
      }),
    ).toThrow("does not match manifest");

    const sums = fixture();
    generate(sums);
    writeFileSync(
      join(sums.output, "artifact-verification", "SHA256SUMS"),
      "bad\n",
    );
    expect(() =>
      verifyReleaseManifest({
        root: sums.output,
        manifest: join(sums.output, "release-artifact-manifest.json"),
      }),
    ).toThrow("SHA256SUMS");

    const spdx = fixture();
    generate(spdx);
    writeFileSync(
      join(spdx.output, "artifact-verification", "release.spdx.json"),
      "{}\n",
    );
    expect(() =>
      verifyReleaseManifest({
        root: spdx.output,
        manifest: join(spdx.output, "release-artifact-manifest.json"),
      }),
    ).toThrow("release.spdx.json");

    const identity = fixture();
    generate(identity);
    expect(() =>
      verifyReleaseManifest({
        root: identity.output,
        manifest: join(identity.output, "release-artifact-manifest.json"),
        repository: "other/repo",
      }),
    ).toThrow("repository does not match");
  });
});
