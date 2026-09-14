import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
import {
  assertSourceCheckout,
  buildReport,
  canonicalInstructions,
  inspectCanonicalSubjects,
  inspectStableRegularFile,
  normalizeReleaseVersion,
  parseCanonicalArgs,
  resolveCurrentRunArtifacts,
  verifyGitHubArtifactAttestation,
  verifyMaterials,
  verifyUpdateManifests,
} from "./verifiers/release.artifact-verification.mjs";
import { CANONICAL_RELEASE_ASSETS } from "./release-constants.mjs";
import {
  verifyArtifactVerificationMaterials,
  verifyMachineEvidenceApplicability,
} from "./check-release-claims.mjs";

const temporary = [];
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const identity = {
  repository: "owner/repository",
  sourceCommit,
  releaseTag: "v0.7.0-beta",
  ref: "refs/tags/v0.7.0-beta",
  runId: 42,
  token: "a-secure-test-token-with-length",
  repositoryVersion: "0.7.0.0",
  appVersion: "0.7.0",
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(
    join(tmpdir(), "skytwin-release-artifact-verifier-"),
  );
  temporary.push(root);
  return root;
}

function hash(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function subjectFiles() {
  return new Map([
    ["SkyTwin-macOS-dmg", ["SkyTwin-0.7.0-arm64.dmg", "mac dmg"]],
    ["SkyTwin-macOS-zip", ["SkyTwin-0.7.0-arm64-mac.zip", "mac zip"]],
    [
      "SkyTwin-Windows-installer",
      ["SkyTwin-Setup-0.7.0.exe", "windows installer"],
    ],
    ["SkyTwin-Linux-AppImage", ["SkyTwin-0.7.0.AppImage", "linux appimage"]],
    ["SkyTwin-Linux-deb", ["skytwin-desktop_0.7.0_amd64.deb", "linux deb"]],
    ["SkyTwin-Linux-rpm", ["skytwin-desktop-0.7.0.x86_64.rpm", "linux rpm"]],
  ]);
}

function updateYaml(targets, primary) {
  const rows = targets.map(([name, bytes]) => {
    const sha512 = hash("sha512", bytes, "base64");
    return `  - url: ${name}\n    sha512: ${sha512}\n    size: ${Buffer.byteLength(bytes)}`;
  });
  return `version: 0.7.0\nfiles:\n${rows.join("\n")}\npath: ${primary[0]}\nsha512: ${hash("sha512", primary[1], "base64")}\nreleaseDate: '2026-09-14T12:00:00Z'\n`;
}

function populateSubjects(root) {
  const binaries = subjectFiles();
  const updates = new Map([
    [
      "SkyTwin-macOS-update-manifest",
      [
        "latest-mac.yml",
        updateYaml(
          [
            binaries.get("SkyTwin-macOS-zip"),
            binaries.get("SkyTwin-macOS-dmg"),
          ],
          binaries.get("SkyTwin-macOS-zip"),
        ),
      ],
    ],
    [
      "SkyTwin-Windows-update-manifest",
      [
        "latest.yml",
        updateYaml(
          [binaries.get("SkyTwin-Windows-installer")],
          binaries.get("SkyTwin-Windows-installer"),
        ),
      ],
    ],
    [
      "SkyTwin-Linux-update-manifest",
      [
        "latest-linux.yml",
        updateYaml(
          [
            binaries.get("SkyTwin-Linux-AppImage"),
            binaries.get("SkyTwin-Linux-deb"),
            binaries.get("SkyTwin-Linux-rpm"),
          ],
          binaries.get("SkyTwin-Linux-AppImage"),
        ),
      ],
    ],
  ]);
  for (const [artifactName] of CANONICAL_RELEASE_ASSETS) {
    const directory = join(root, "artifacts", artifactName);
    mkdirSync(directory, { recursive: true });
    const [name, bytes] =
      binaries.get(artifactName) ?? updates.get(artifactName);
    writeFileSync(join(directory, name), bytes);
  }
}

function makeSpdx(subjects) {
  const files = [...subjects.values()].map((subject, index) => ({
    SPDXID: `SPDXRef-File-${index + 1}`,
    fileName: subject.name,
    checksums: [
      { algorithm: "SHA1", checksumValue: subject.sha1 },
      { algorithm: "SHA256", checksumValue: subject.sha256 },
      {
        algorithm: "SHA512",
        checksumValue: Buffer.from(subject.sha512, "base64").toString("hex"),
      },
    ],
  }));
  const verificationCode = hash(
    "sha1",
    [...subjects.values()]
      .map((subject) => subject.sha1)
      .sort()
      .join(""),
  );
  const packageId = "SPDXRef-Package-SkyTwin-Desktop-Release";
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `SkyTwin desktop ${identity.releaseTag}`,
    documentNamespace: `https://github.com/${identity.repository}/releases/tag/${encodeURIComponent(identity.releaseTag)}/spdx/${identity.sourceCommit}/${identity.runId}/${encodeURIComponent("2026-09-14T12:00:00Z")}`,
    creationInfo: {
      created: "2026-09-14T12:00:00Z",
      creators: [
        "Organization: SkyTwin",
        "Tool: SkyTwin release artifact material generator",
      ],
    },
    documentDescribes: [packageId],
    packages: [
      {
        SPDXID: packageId,
        name: "SkyTwin desktop release artifacts",
        versionInfo: identity.appVersion,
        downloadLocation: `https://github.com/${identity.repository}/releases/tag/${encodeURIComponent(identity.releaseTag)}`,
        filesAnalyzed: true,
        packageVerificationCode: {
          packageVerificationCodeValue: verificationCode,
        },
        externalRefs: [
          {
            referenceCategory: "OTHER",
            referenceType: "vcs",
            referenceLocator: `git+https://github.com/${identity.repository}.git@${identity.sourceCommit}`,
          },
        ],
        sourceInfo: `Built from Git commit ${identity.sourceCommit} at ${identity.ref}.`,
        comment: `Release artifact set for ${identity.releaseTag}; generated by GitHub Actions run ${identity.runId}.`,
      },
    ],
    files,
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: packageId,
      },
      ...files.map((file) => ({
        spdxElementId: packageId,
        relationshipType: "CONTAINS",
        relatedSpdxElement: file.SPDXID,
      })),
    ],
  };
}

function populateMaterials(root, subjects) {
  const directory = join(root, ".release-evidence", "artifact-verification");
  mkdirSync(directory, { recursive: true });
  const sums =
    [...subjects.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((subject) => `${subject.sha256}  ${subject.name}`)
      .join("\n") + "\n";
  writeFileSync(join(directory, "SHA256SUMS"), sums);
  writeFileSync(
    join(directory, "release.spdx.json"),
    `${JSON.stringify(makeSpdx(subjects), null, 2)}\n`,
  );
  writeFileSync(
    join(directory, "VERIFY.md"),
    canonicalInstructions(subjects, identity),
  );
  for (const digest of new Set(
    [...subjects.values()].map((subject) => subject.sha256),
  )) {
    writeFileSync(
      join(directory, `${digest}.attestation.jsonl`),
      `{"subject":"${digest}"}\n`,
    );
  }
}

function apiArtifact(name, id) {
  const digest = hash("sha256", `artifact archive ${name}`);
  return {
    id,
    name,
    expired: false,
    digest: `sha256:${digest}`,
    workflow_run: { id: identity.runId, head_sha: identity.sourceCommit },
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiFetch(artifacts) {
  return vi.fn(async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith(`/actions/runs/${identity.runId}`)) {
      return jsonResponse({
        id: identity.runId,
        repository: { full_name: identity.repository },
        head_sha: identity.sourceCommit,
        head_branch: identity.releaseTag,
        event: "push",
        path: ".github/workflows/build.yml",
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${identity.runId}/artifacts`)) {
      return jsonResponse({ total_count: artifacts.length, artifacts });
    }
    const id = Number(url.pathname.split("/").at(-1));
    return jsonResponse(artifacts.find((artifact) => artifact.id === id));
  });
}

describe("release.artifact-verification canonical verifier", () => {
  it("keeps the hosted tag verifier self-contained", () => {
    const source = readFileSync(
      "scripts/release-claims/verifiers/release.artifact-verification.mjs",
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.every(
        (specifier) =>
          specifier.startsWith("node:") ||
          specifier === "../release-constants.mjs",
      ),
    ).toBe(true);
  });

  it("normalizes the target beta tag and rejects ambiguous versions", () => {
    expect(normalizeReleaseVersion("v0.7.0-beta")).toEqual({
      repositoryVersion: "0.7.0.0",
      appVersion: "0.7.0",
    });
    expect(normalizeReleaseVersion("v1.2.3-beta.4")).toEqual({
      repositoryVersion: "1.2.3.4",
      appVersion: "1.2.304",
    });
    expect(normalizeReleaseVersion("v1.2.3.4")).toEqual({
      repositoryVersion: "1.2.3.4",
      appVersion: "1.2.304",
    });
    expect(() => normalizeReleaseVersion("v0.7.0-beta.0")).toThrow("canonical");
    expect(() => normalizeReleaseVersion("v0.7.0")).toThrow("canonical");
  });

  it("requires exact direct subjects and validates updater targets against staged bytes", () => {
    const root = makeRoot();
    populateSubjects(root);
    const subjects = inspectCanonicalSubjects(root, identity.appVersion);
    expect(subjects.size).toBe(9);
    expect(() =>
      verifyUpdateManifests(subjects, identity.appVersion),
    ).not.toThrow();

    const linuxManifest = subjects.get("SkyTwin-Linux-update-manifest").path;
    writeFileSync(
      linuxManifest,
      readFileSync(linuxManifest, "utf8").replace(
        /sha512: [A-Za-z0-9+/=]+/u,
        `sha512: ${"A".repeat(86)}==`,
      ),
    );
    const tampered = inspectCanonicalSubjects(root, identity.appVersion);
    expect(() => verifyUpdateManifests(tampered, identity.appVersion)).toThrow(
      "stale SHA-512",
    );

    populateSubjects(root);
    const withExtraTarget = inspectCanonicalSubjects(root, identity.appVersion);
    const macManifest = withExtraTarget.get(
      "SkyTwin-macOS-update-manifest",
    ).path;
    writeFileSync(
      macManifest,
      updateYaml(
        [
          subjectFiles().get("SkyTwin-macOS-zip"),
          subjectFiles().get("SkyTwin-macOS-dmg"),
          subjectFiles().get("SkyTwin-Linux-AppImage"),
        ],
        subjectFiles().get("SkyTwin-macOS-zip"),
      ),
    );
    const extraTargetSubjects = inspectCanonicalSubjects(
      root,
      identity.appVersion,
    );
    expect(() =>
      verifyUpdateManifests(extraTargetSubjects, identity.appVersion),
    ).toThrow("exactly 2 canonical update targets");

    populateSubjects(root);
    const duplicateVersionSubjects = inspectCanonicalSubjects(
      root,
      identity.appVersion,
    );
    const windowsManifest = duplicateVersionSubjects.get(
      "SkyTwin-Windows-update-manifest",
    ).path;
    writeFileSync(
      windowsManifest,
      `${readFileSync(windowsManifest, "utf8")}version: ${identity.appVersion}\n`,
    );
    expect(() =>
      verifyUpdateManifests(duplicateVersionSubjects, identity.appVersion),
    ).toThrow("duplicate version");
  });

  it("rejects symlinks, extra subjects, and files outside the size bound", () => {
    const root = makeRoot();
    populateSubjects(root);
    const directory = join(root, "artifacts", "SkyTwin-Linux-deb");
    const subject = join(directory, "skytwin-desktop_0.7.0_amd64.deb");
    writeFileSync(join(directory, "extra.deb"), "extra");
    expect(() => inspectCanonicalSubjects(root, identity.appVersion)).toThrow(
      "exactly one",
    );
    rmSync(join(directory, "extra.deb"));
    rmSync(subject);
    symlinkSync(
      join(
        root,
        "artifacts",
        "SkyTwin-Linux-AppImage",
        "SkyTwin-0.7.0.AppImage",
      ),
      subject,
    );
    expect(() => inspectCanonicalSubjects(root, identity.appVersion)).toThrow(
      "non-symlink",
    );

    const standalone = join(root, "large");
    writeFileSync(standalone, "12");
    expect(() =>
      inspectStableRegularFile(root, standalone, "bounded test", 1),
    ).toThrow("size is outside");

    writeFileSync(standalone, "before");
    expect(() =>
      inspectStableRegularFile(root, standalone, "TOCTOU test", 100, {
        afterOpen: ({ requested }) => writeFileSync(requested, "replaced"),
      }),
    ).toThrow("changed while hashing");

    const linkedRoot = makeRoot();
    populateSubjects(linkedRoot);
    renameSync(
      join(linkedRoot, "artifacts"),
      join(linkedRoot, "real-artifacts"),
    );
    symlinkSync(
      join(linkedRoot, "real-artifacts"),
      join(linkedRoot, "artifacts"),
    );
    expect(() =>
      inspectCanonicalSubjects(linkedRoot, identity.appVersion),
    ).toThrow("symlink component");

    const oversizedManifestRoot = makeRoot();
    populateSubjects(oversizedManifestRoot);
    writeFileSync(
      join(
        oversizedManifestRoot,
        "artifacts",
        "SkyTwin-Linux-update-manifest",
        "latest-linux.yml",
      ),
      Buffer.alloc(4 * 1024 * 1024 + 1, 65),
    );
    expect(() =>
      inspectCanonicalSubjects(oversizedManifestRoot, identity.appVersion),
    ).toThrow("size is outside");
  });

  it("binds the exact canonical API artifacts to the current tag-push run", async () => {
    const artifacts = CANONICAL_RELEASE_ASSETS.map(([name], index) =>
      apiArtifact(name, index + 1),
    );
    const fetchImpl = apiFetch(artifacts);
    const resolved = await resolveCurrentRunArtifacts(identity, fetchImpl);
    expect(resolved.size).toBe(9);
    expect(resolved.get("SkyTwin-Linux-AppImage").artifactId).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(11);

    const duplicate = [...artifacts, { ...artifacts[0], id: 99 }];
    await expect(
      resolveCurrentRunArtifacts(identity, apiFetch(duplicate)),
    ).rejects.toThrow("found 2");
    await expect(
      resolveCurrentRunArtifacts(identity, apiFetch(artifacts.slice(1))),
    ).rejects.toThrow("found 0");

    const wrongRunFetch = apiFetch(artifacts);
    wrongRunFetch.mockImplementationOnce(async () =>
      jsonResponse({
        id: identity.runId,
        repository: { full_name: "attacker/repository" },
        head_sha: "f".repeat(40),
        head_branch: identity.releaseTag,
        event: "push",
        path: ".github/workflows/build.yml",
      }),
    );
    await expect(
      resolveCurrentRunArtifacts(identity, wrongRunFetch),
    ).rejects.toThrow("not the canonical tag-push build");

    const paginated = [
      ...artifacts,
      ...Array.from({ length: 92 }, (_, index) =>
        apiArtifact(`other-${index}`, 1000 + index),
      ),
    ];
    await expect(
      resolveCurrentRunArtifacts(identity, apiFetch(paginated)),
    ).rejects.toThrow("paginated or incomplete");
  });

  it("independently validates every material and emits the five-check AppImage-bound report", async () => {
    const root = makeRoot();
    populateSubjects(root);
    const subjects = inspectCanonicalSubjects(root, identity.appVersion);
    populateMaterials(root, subjects);
    const verifyAttestation = vi.fn().mockResolvedValue(undefined);
    const materials = await verifyMaterials({
      root,
      subjects,
      identity,
      verifyAttestation,
    });
    expect(verifyAttestation).toHaveBeenCalledTimes(9);

    // buildReport hashes the reviewed canonical verifier source from the root.
    const verifierRelative =
      "scripts/release-claims/verifiers/release.artifact-verification.mjs";
    mkdirSync(join(root, "scripts", "release-claims", "verifiers"), {
      recursive: true,
    });
    writeFileSync(
      join(root, verifierRelative),
      readFileSync(
        new URL(
          "./verifiers/release.artifact-verification.mjs",
          import.meta.url,
        ),
      ),
    );
    const apiArtifacts = new Map(
      CANONICAL_RELEASE_ASSETS.map(([name, kind], index) => {
        const artifact = apiArtifact(name, index + 1);
        return [
          name,
          {
            artifactId: artifact.id,
            artifactSha256: artifact.digest.slice(7),
            artifactName: name,
            kind,
          },
        ];
      }),
    );
    const report = buildReport({
      root,
      identity,
      apiArtifacts,
      subjects,
      materials,
      runtime: { platform: "linux", arch: "x64" },
    });
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId: "release.artifact-verification",
      platform: "linux",
      runnerPlatform: "linux-x64",
      releaseArtifactName: "SkyTwin-Linux-AppImage",
      subjectName: "SkyTwin-0.7.0.AppImage",
    });
    expect(report.coveredSubjects).toHaveLength(9);
    expect(report.checks.map((check) => check.id)).toEqual([
      "release.asset-set",
      "release.checksums",
      "release.sbom",
      "release.provenance",
      "release.verification-instructions",
    ]);
    const releaseAssets = [...apiArtifacts.values()].map((artifact) => {
      const subject = subjects.get(artifact.artifactName);
      return {
        artifactId: artifact.artifactId,
        artifactName: artifact.artifactName,
        artifactSha256: artifact.artifactSha256,
        kind: artifact.kind,
        subjects: [
          {
            name: subject.name,
            path: subject.relativePath,
            sha256: subject.sha256,
          },
        ],
      };
    });
    const verificationAssets = [
      { ...materials.checksums, kind: "checksums" },
      { ...materials.spdx, kind: "sbom" },
      { ...materials.instructions, kind: "verification-instructions" },
      ...[...materials.bundles.values()].map((bundle) => ({
        ...bundle,
        kind: "provenance-bundle",
      })),
    ].map((material) => ({
      kind: material.kind,
      name: material.name,
      path: `.release-evidence/artifact-verification/${material.name}`,
      sha256: material.sha256,
    }));
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        report,
        releaseAssets,
        verificationAssets,
      ),
    ).toEqual([]);
    expect(
      await verifyArtifactVerificationMaterials(
        {
          root,
          manifest: { releaseAssets, verificationAssets },
          report,
          repository: identity.repository,
          releaseCommit: identity.sourceCommit,
          triggerRef: identity.ref,
          githubToken: identity.token,
        },
        vi.fn().mockResolvedValue(undefined),
      ),
    ).toEqual([]);
  });

  it("rejects extra materials, stale SPDX bytes, and noncanonical instructions", async () => {
    const root = makeRoot();
    populateSubjects(root);
    const subjects = inspectCanonicalSubjects(root, identity.appVersion);
    populateMaterials(root, subjects);
    const directory = join(root, ".release-evidence", "artifact-verification");
    writeFileSync(join(directory, "extra.txt"), "unreviewed");
    await expect(
      verifyMaterials({ root, subjects, identity, verifyAttestation: vi.fn() }),
    ).rejects.toThrow("unexpected");
    rmSync(join(directory, "extra.txt"));

    const sbomPath = join(directory, "release.spdx.json");
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    sbom.files[0].checksums.find(
      (entry) => entry.algorithm === "SHA256",
    ).checksumValue = "f".repeat(64);
    writeFileSync(sbomPath, JSON.stringify(sbom));
    await expect(
      verifyMaterials({ root, subjects, identity, verifyAttestation: vi.fn() }),
    ).rejects.toThrow("does not exactly cover");

    const duplicateChecksumSbom = makeSpdx(subjects);
    duplicateChecksumSbom.files[0].checksums[2] = {
      ...duplicateChecksumSbom.files[0].checksums[0],
    };
    writeFileSync(sbomPath, JSON.stringify(duplicateChecksumSbom));
    await expect(
      verifyMaterials({ root, subjects, identity, verifyAttestation: vi.fn() }),
    ).rejects.toThrow("stale or incomplete checksums");

    writeFileSync(sbomPath, JSON.stringify(makeSpdx(subjects)));
    writeFileSync(join(directory, "VERIFY.md"), "trust me\n");
    await expect(
      verifyMaterials({ root, subjects, identity, verifyAttestation: vi.fn() }),
    ).rejects.toThrow("canonical");
  });

  it("accepts expected untracked inputs but rejects tracked source drift and wrong version binding", () => {
    const root = makeRoot();
    writeFileSync(join(root, "VERSION"), "0.7.0.0\n");
    writeFileSync(join(root, "package.json"), '{"version":"0.7.0.0"}\n');
    const cleanGit = vi.fn((args) =>
      args[0] === "rev-parse" ? `${sourceCommit}\n` : "",
    );
    expect(
      assertSourceCheckout({
        root,
        sourceCommit,
        releaseTag: identity.releaseTag,
        executeGit: cleanGit,
      }),
    ).toEqual({
      repositoryVersion: "0.7.0.0",
      appVersion: "0.7.0",
    });
    expect(cleanGit).toHaveBeenCalledWith(
      ["status", "--porcelain=v1", "--untracked-files=no"],
      root,
    );

    const dirtyGit = vi.fn((args) =>
      args[0] === "rev-parse" ? `${sourceCommit}\n` : " M tracked.js\n",
    );
    expect(() =>
      assertSourceCheckout({
        root,
        sourceCommit,
        releaseTag: identity.releaseTag,
        executeGit: dirtyGit,
      }),
    ).toThrow("unmodified tracked");
    writeFileSync(join(root, "VERSION"), "0.6.102.0\n");
    expect(() =>
      assertSourceCheckout({
        root,
        sourceCommit,
        releaseTag: identity.releaseTag,
        executeGit: cleanGit,
      }),
    ).toThrow("does not match release tag");
  });

  it("accepts only the canonical Linux matrix invocation", () => {
    expect(
      parseCanonicalArgs([
        "--platform",
        "linux",
        "--output",
        ".release-evidence/reports/release.artifact-verification.json",
      ]),
    ).toEqual({
      platform: "linux",
      output: ".release-evidence/reports/release.artifact-verification.json",
    });
    expect(() =>
      parseCanonicalArgs(["--platform", "macos", "--output", "report.json"]),
    ).toThrow("usage");
  });

  it("invokes GitHub's verifier with exact source constraints and a credential-minimal environment", () => {
    const execute = vi.fn().mockReturnValue('[{"verificationResult":{}}]');
    verifyGitHubArtifactAttestation(
      {
        subjectPath: "/tmp/SkyTwin.AppImage",
        bundlePath: "/tmp/provenance.jsonl",
        identity,
      },
      execute,
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        DATABASE_URL: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        HTTPS_PROXY: "http://credential@example.test",
      },
    );
    expect(execute).toHaveBeenCalledWith(
      "gh",
      [
        "attestation",
        "verify",
        "/tmp/SkyTwin.AppImage",
        "--repo",
        identity.repository,
        "--bundle",
        "/tmp/provenance.jsonl",
        "--source-digest",
        identity.sourceCommit,
        "--source-ref",
        identity.ref,
        "--signer-workflow",
        `github.com/${identity.repository}/.github/workflows/build.yml`,
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--format",
        "json",
      ],
      expect.objectContaining({
        env: {
          GH_TOKEN: identity.token,
          PATH: "/usr/bin",
          HOME: "/tmp/home",
          XDG_CONFIG_HOME: "",
          SSL_CERT_FILE: "",
          SSL_CERT_DIR: "",
        },
      }),
    );
  });
});
