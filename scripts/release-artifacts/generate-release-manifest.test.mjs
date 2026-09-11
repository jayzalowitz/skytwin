import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReleaseManifest } from "./generate-release-manifest.mjs";
import { generateReleaseSbomIndex } from "./generate-release-sbom-index.mjs";
import { verifyReleaseManifest } from "./verify-release-manifest.mjs";

const temporary = [];

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "skytwin-release-manifest-"));
  temporary.push(directory);
  const root = join(directory, "artifacts");
  const output = join(directory, "verified");
  const contract = join(directory, "contract.json");
  mkdirSync(join(root, "mac-installer"), { recursive: true });
  mkdirSync(join(root, "win-installer"), { recursive: true });
  mkdirSync(join(root, "win-update"), { recursive: true });
  writeFileSync(join(root, "mac-installer", "SkyTwin-1.2.3.dmg"), "mac bytes");
  writeFileSync(
    join(root, "win-installer", "SkyTwin-Setup-1.2.3.exe"),
    "win bytes",
  );
  const winIdentity = createHash("sha512").update("win bytes").digest("base64");
  writeFileSync(
    join(root, "win-update", "latest.yml"),
    `version: 1.2.3\nfiles:\n  - url: SkyTwin-Setup-1.2.3.exe\n    sha512: ${winIdentity}\n    size: 9\npath: SkyTwin-Setup-1.2.3.exe\nsha512: ${winIdentity}\n`,
  );
  writeFileSync(
    contract,
    JSON.stringify({
      schemaVersion: 1,
      releaseSurface: "desktop",
      artifacts: [
        {
          artifactName: "mac-installer",
          platform: "macos",
          kind: "installer",
          filenamePattern: "^SkyTwin-[0-9.]+\\.dmg$",
        },
        {
          artifactName: "win-installer",
          platform: "windows",
          kind: "installer",
          filenamePattern: "^SkyTwin-Setup-[0-9.]+\\.exe$",
        },
        {
          artifactName: "win-update",
          platform: "windows",
          kind: "update-manifest",
          filenamePattern: "^latest\\.yml$",
        },
      ],
    }),
  );
  return { directory, root, output, contract };
}

function generate(value, overrides = {}) {
  return generateReleaseManifest({
    ...value,
    repository: "owner/repo",
    commit: "a".repeat(40),
    ref: "refs/tags/v1.2.0.3",
    releaseTag: "v1.2.0.3",
    appVersion: "1.2.3",
    runId: "42",
    ...overrides,
  });
}

describe("generateReleaseManifest", () => {
  it("stages only the exact contract set and writes deterministic checksums", () => {
    const value = fixture();
    const manifest = generate(value);
    expect(manifest.assets.map((asset) => asset.filename)).toEqual(
      ["SkyTwin-1.2.3.dmg", "SkyTwin-Setup-1.2.3.exe", "latest.yml"].sort(
        (left, right) => left.localeCompare(right),
      ),
    );
    expect(
      manifest.assets.find((asset) => asset.filename.endsWith(".dmg")).sha256,
    ).toBe(createHash("sha256").update("mac bytes").digest("hex"));
    expect(
      readFileSync(join(value.output, "assets", "SkyTwin-1.2.3.dmg"), "utf8"),
    ).toBe("mac bytes");
    expect(readFileSync(join(value.output, "SHA256SUMS"), "utf8")).toBe(
      manifest.assets
        .map((asset) => `${asset.sha256}  ${asset.filename}`)
        .join("\n") + "\n",
    );
    expect(
      verifyReleaseManifest({
        root: value.output,
        manifest: join(value.output, "release-manifest.json"),
      }),
    ).toEqual({
      valid: true,
      repository: "owner/repo",
      sourceCommit: "a".repeat(40),
      assets: 3,
    });
  });

  it("rejects stale packaged and update-manifest identities", () => {
    expect(() =>
      generate(fixture(), {
        ref: "refs/tags/v1.2.0.4",
        releaseTag: "v1.2.0.4",
      }),
    ).toThrow("appVersion does not match releaseTag");

    const packaged = fixture();
    rmSync(join(packaged.root, "mac-installer", "SkyTwin-1.2.3.dmg"));
    writeFileSync(
      join(packaged.root, "mac-installer", "SkyTwin-0.3.0.dmg"),
      "stale mac bytes",
    );
    expect(() => generate(packaged)).toThrow(
      "does not identify app version 1.2.3",
    );

    const updateManifest = fixture();
    writeFileSync(
      join(updateManifest.root, "win-update", "latest.yml"),
      "version: 0.3.0\nfiles:\n  - url: SkyTwin-0.3.0.exe\n    sha512: stale\npath: SkyTwin-0.3.0.exe\nsha512: stale\n",
    );
    expect(() => generate(updateManifest)).toThrow(
      "does not identify app version 1.2.3",
    );

    const staleDigest = fixture();
    const stale = readFileSync(
      join(staleDigest.root, "win-update", "latest.yml"),
      "utf8",
    ).replace(/sha512: [A-Za-z0-9+/=]+/g, `sha512: ${"A".repeat(86)}==`);
    writeFileSync(join(staleDigest.root, "win-update", "latest.yml"), stale);
    expect(() => generate(staleDigest)).toThrow("has stale identity");
  });

  it("rejects duplicate and malformed updater mappings", () => {
    const duplicateUrl = fixture();
    const duplicateUrlPath = join(
      duplicateUrl.root,
      "win-update",
      "latest.yml",
    );
    writeFileSync(
      duplicateUrlPath,
      readFileSync(duplicateUrlPath, "utf8").replace(
        "    sha512:",
        "    url: attacker.exe\n    sha512:",
      ),
    );
    expect(() => generate(duplicateUrl)).toThrow(
      "unsupported file metadata url",
    );

    const duplicateFiles = fixture();
    const duplicateFilesPath = join(
      duplicateFiles.root,
      "win-update",
      "latest.yml",
    );
    writeFileSync(
      duplicateFilesPath,
      `${readFileSync(duplicateFilesPath, "utf8")}files:\n`,
    );
    expect(() => generate(duplicateFiles)).toThrow(
      "must have exactly one files list",
    );

    const trailing = fixture();
    const trailingPath = join(trailing.root, "win-update", "latest.yml");
    writeFileSync(
      trailingPath,
      `${readFileSync(trailingPath, "utf8")}  - malformed: ignored.exe\n`,
    );
    expect(() => generate(trailing)).toThrow("trailing files metadata");
  });

  it("rejects missing, duplicate, and renamed contract assets", () => {
    const missing = fixture();
    rmSync(join(missing.root, "win-installer"), { recursive: true });
    expect(() => generate(missing)).toThrow();

    const duplicate = fixture();
    writeFileSync(
      join(duplicate.root, "mac-installer", "SkyTwin-1.2.4.dmg"),
      "other",
    );
    expect(() => generate(duplicate)).toThrow("must contain exactly one file");

    const renamed = fixture();
    rmSync(join(renamed.root, "mac-installer", "SkyTwin-1.2.3.dmg"));
    writeFileSync(join(renamed.root, "mac-installer", "evil.sh"), "other");
    expect(() => generate(renamed)).toThrow("unexpected filename");
  });

  it("rejects symlinks and artifact directories escaping the download root", () => {
    const fileLink = fixture();
    rmSync(join(fileLink.root, "mac-installer", "SkyTwin-1.2.3.dmg"));
    symlinkSync(
      join(fileLink.root, "win-installer", "SkyTwin-Setup-1.2.3.exe"),
      join(fileLink.root, "mac-installer", "SkyTwin-1.2.3.dmg"),
    );
    expect(() => generate(fileLink)).toThrow("not a regular file");

    const directoryLink = fixture();
    const outside = join(directoryLink.directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "SkyTwin-1.2.3.dmg"), "outside");
    rmSync(join(directoryLink.root, "mac-installer"), { recursive: true });
    symlinkSync(outside, join(directoryLink.root, "mac-installer"));
    expect(() => generate(directoryLink)).toThrow("escapes artifact root");
  });

  it("refuses to overwrite a prior verified output", () => {
    const value = fixture();
    generate(value);
    expect(() => generate(value)).toThrow();
  });

  it("rejects tampering, extra files, checksum drift, and identity mismatch", () => {
    const tampered = fixture();
    generate(tampered);
    writeFileSync(
      join(tampered.output, "assets", "SkyTwin-1.2.3.dmg"),
      "tampered",
    );
    expect(() =>
      verifyReleaseManifest({
        root: tampered.output,
        manifest: join(tampered.output, "release-manifest.json"),
      }),
    ).toThrow("does not match manifest");

    const extra = fixture();
    generate(extra);
    writeFileSync(join(extra.output, "assets", "extra.txt"), "extra");
    expect(() =>
      verifyReleaseManifest({
        root: extra.output,
        manifest: join(extra.output, "release-manifest.json"),
      }),
    ).toThrow("asset set does not match");

    const sums = fixture();
    generate(sums);
    writeFileSync(join(sums.output, "SHA256SUMS"), "bad\n");
    expect(() =>
      verifyReleaseManifest({
        root: sums.output,
        manifest: join(sums.output, "release-manifest.json"),
      }),
    ).toThrow("SHA256SUMS");

    const identity = fixture();
    generate(identity);
    expect(() =>
      verifyReleaseManifest({
        root: identity.output,
        manifest: join(identity.output, "release-manifest.json"),
        repository: "other/repo",
      }),
    ).toThrow("repository does not match");
  });

  it("binds every artifact digest to a validated platform dependency SBOM", () => {
    const value = fixture();
    const manifest = generate(value);
    const sbomRoot = join(value.directory, "sboms");
    mkdirSync(sbomRoot);
    for (const platform of ["macos", "windows", "linux"]) {
      writeFileSync(
        join(sbomRoot, `${platform}.cdx.json`),
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          serialNumber: `urn:uuid:00000000-0000-4000-8000-00000000000${platform === "macos" ? "1" : platform === "windows" ? "2" : "3"}`,
          version: 1,
          metadata: {
            component: { type: "application", name: `SkyTwin ${platform}` },
          },
          components: [{ type: "library", name: "dependency", version: "1" }],
        }),
      );
    }
    const output = join(value.output, "release-sbom.cdx.json");
    const index = generateReleaseSbomIndex({
      manifest: join(value.output, "release-manifest.json"),
      sbomRoot,
      output,
    });
    expect(index.components).toHaveLength(manifest.assets.length);
    expect(index.components[0].hashes).toEqual([
      { alg: "SHA-256", content: manifest.assets[0].sha256 },
    ]);
    expect(index.components[0].externalReferences[0].type).toBe("bom");
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(index);
    expect(
      readFileSync(join(value.output, "sboms", "macos.cdx.json"), "utf8"),
    ).toBe(readFileSync(join(sbomRoot, "macos.cdx.json"), "utf8"));
  });

  it("rejects a missing, malformed, or empty platform SBOM", () => {
    const value = fixture();
    generate(value);
    const sbomRoot = join(value.directory, "sboms");
    mkdirSync(sbomRoot);
    for (const platform of ["macos", "windows"]) {
      writeFileSync(
        join(sbomRoot, `${platform}.cdx.json`),
        JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          serialNumber: `urn:uuid:00000000-0000-4000-8000-00000000000${platform === "macos" ? "1" : "2"}`,
          version: 1,
          metadata: {},
          components: [{ type: "library", name: "dependency" }],
        }),
      );
    }
    expect(() =>
      generateReleaseSbomIndex({
        manifest: join(value.output, "release-manifest.json"),
        sbomRoot,
        output: join(value.output, "release-sbom.cdx.json"),
      }),
    ).toThrow();
    writeFileSync(
      join(sbomRoot, "linux.cdx.json"),
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000003",
        version: 1,
        metadata: {},
        components: [],
      }),
    );
    expect(() =>
      generateReleaseSbomIndex({
        manifest: join(value.output, "release-manifest.json"),
        sbomRoot,
        output: join(value.output, "release-sbom.cdx.json"),
      }),
    ).toThrow("not a supported");
  });
});
