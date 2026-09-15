import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport,
  inspectPlatformSubjects,
  inspectStableRegularFile,
  macZipExtractionVolumeSize,
  parseCanonicalArgs,
  parseMacCodeSignature,
  parseMacGatekeeper,
  parseMacZipListing,
  parseSevenZipListing,
  parseWindowsSignature,
  readRunIdentity,
  readTrustPolicy,
  resolveCurrentRunArtifacts,
  runCanonicalVerifier,
  verifyLinuxSubjects,
  verifyMacSubjects,
  verifyUploadedReport,
  verifyWindowsSubjects,
} from "./verifiers/release.signing.mjs";
import { inspectCanonicalSubjects as inspectArtifactVerificationSubjects } from "./verifiers/release.artifact-verification.mjs";
import { verifyMachineEvidenceApplicability } from "./check-release-claims.mjs";

const temporary = [];
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const signerSha256 = "a".repeat(64);
const timestampSha256 = "b".repeat(64);
const teamId = "TEAM123456";
const cdHash = "c".repeat(40);
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
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "skytwin-signing-verifier-"));
  temporary.push(root);
  return root;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const subjectFixtures = Object.freeze({
  macos: Object.freeze([
    ["SkyTwin-macOS-dmg", "SkyTwin-0.7.0-arm64.dmg", "signed dmg bytes"],
    ["SkyTwin-macOS-zip", "SkyTwin-0.7.0-arm64-mac.zip", "signed zip bytes"],
  ]),
  windows: Object.freeze([
    [
      "SkyTwin-Windows-installer",
      "SkyTwin-Setup-0.7.0.exe",
      "signed installer bytes",
    ],
  ]),
  linux: Object.freeze([
    ["SkyTwin-Linux-AppImage", "SkyTwin-0.7.0.AppImage", "appimage"],
    ["SkyTwin-Linux-deb", "skytwin-desktop_0.7.0_amd64.deb", "deb"],
    ["SkyTwin-Linux-rpm", "skytwin-desktop-0.7.0.x86_64.rpm", "rpm"],
  ]),
});

function populateSubjects(root, platform, filenameOverrides = {}) {
  for (const [artifactName, filename, bytes] of subjectFixtures[platform]) {
    const directory = join(root, "artifacts", artifactName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, filenameOverrides[artifactName] ?? filename),
      bytes,
    );
  }
}

function prepareSource(root) {
  writeFileSync(join(root, "VERSION"), `${identity.repositoryVersion}\n`);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ version: identity.repositoryVersion })}\n`,
  );
  const verifierPath = join(
    root,
    "scripts",
    "release-claims",
    "verifiers",
    "release.signing.mjs",
  );
  mkdirSync(join(verifierPath, ".."), { recursive: true });
  writeFileSync(
    verifierPath,
    readFileSync(new URL("./verifiers/release.signing.mjs", import.meta.url)),
  );
}

function artifactRecord(artifactName, id) {
  return {
    id,
    name: artifactName,
    expired: false,
    digest: `sha256:${sha256(`archive:${artifactName}`)}`,
    workflow_run: { id: identity.runId, head_sha: identity.sourceCommit },
  };
}

function platformArtifacts(platform) {
  return subjectFixtures[platform].map(([artifactName], index) =>
    artifactRecord(artifactName, index + 1),
  );
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiFetch(artifacts, runOverrides = {}) {
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
        ...runOverrides,
      });
    }
    if (url.pathname.endsWith(`/actions/runs/${identity.runId}/artifacts`))
      return jsonResponse({ total_count: artifacts.length, artifacts });
    const id = Number(url.pathname.split("/").at(-1));
    return jsonResponse(artifacts.find((artifact) => artifact.id === id));
  });
}

function apiArtifactMap(platform) {
  const kinds = new Map([
    ["SkyTwin-macOS-dmg", "desktop-installer"],
    ["SkyTwin-macOS-zip", "desktop-archive"],
    ["SkyTwin-Windows-installer", "desktop-installer"],
  ]);
  return new Map(
    platformArtifacts(platform).map((artifact) => [
      artifact.name,
      {
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactSha256: artifact.digest.slice(7),
        kind: kinds.get(artifact.name),
      },
    ]),
  );
}

function macSignature({
  identifier = "com.skytwin.desktop",
  signer = "Developer ID Application: SkyTwin Test (TEAM123456)",
  actualTeamId = teamId,
  actualCdHash = cdHash,
  runtime = true,
} = {}) {
  return [
    `Identifier=${identifier}`,
    `Authority=${signer}`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    `TeamIdentifier=${actualTeamId}`,
    `CDHash=${actualCdHash}`,
    runtime
      ? "CodeDirectory flags=0x10000(runtime)"
      : "CodeDirectory flags=0x0(none)",
  ].join("\n");
}

function macReportObservation(artifactName, overrides = {}) {
  return {
    signatureResult: "pass",
    notarizationResult: "pass",
    verificationMethod:
      artifactName === "SkyTwin-macOS-dmg"
        ? "dmg-codesign+gatekeeper+stapler+dmg-contained-app-codesign"
        : "bounded-volume+ditto-contained-app+codesign+gatekeeper+stapler",
    signer: "Developer ID Application: SkyTwin Test (TEAM123456)",
    signerTeamId: teamId,
    signedIdentifier: "com.skytwin.desktop",
    signedContentCdHash: cdHash,
    signedBundleVersion: identity.appVersion,
    signedBundleBuildVersion: identity.appVersion,
    executableArchitecture: "arm64",
    containerSignature:
      artifactName === "SkyTwin-macOS-dmg"
        ? {
            signatureResult: "pass",
            signer: "Developer ID Application: SkyTwin Test (TEAM123456)",
            signerTeamId: teamId,
            signedIdentifier: "com.skytwin.desktop.dmg",
            signedContentCdHash: "b".repeat(40),
          }
        : null,
    ...overrides,
  };
}

function createMacApp(root) {
  const executable = join(root, "SkyTwin.app", "Contents", "MacOS");
  mkdirSync(executable, { recursive: true });
  writeFileSync(join(executable, "SkyTwin"), "mach-o");
}

function macZipListing(records = null) {
  const entries = records ?? [
    { permissions: "drwxr-xr-x", sizeBytes: 0, path: "SkyTwin.app/" },
    {
      permissions: "-rwxr-xr-x",
      sizeBytes: 6,
      path: "SkyTwin.app/Contents/MacOS/SkyTwin",
    },
  ];
  const expanded = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  return [
    "Archive:  SkyTwin.zip",
    `Zip file size: 100 bytes, number of entries: ${entries.length}`,
    ...entries.map(
      ({ permissions, sizeBytes, path }) =>
        `${permissions}  3.0 unx ${String(sizeBytes).padStart(8)} bx        1 stor 26-Sep-14 00:00 ${path}`,
    ),
    `${entries.length} files, ${expanded} bytes uncompressed, 1 bytes compressed:  0.0%`,
  ].join("\n");
}

function macExecutor(overrides = {}) {
  let appIndex = 0;
  return vi.fn((file, args) => {
    if (file === "/usr/bin/hdiutil" && args[0] === "create") {
      return { exitCode: 0, signal: null, stdout: "created", stderr: "" };
    }
    if (file === "/usr/bin/hdiutil" && args[0] === "attach") {
      if (args.includes("-readonly"))
        createMacApp(args[args.indexOf("-mountpoint") + 1]);
      return { exitCode: 0, signal: null, stdout: "attached", stderr: "" };
    }
    if (file === "/usr/bin/ditto") {
      createMacApp(args.at(-1));
      overrides.afterExtract?.(args.at(-1));
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    }
    if (file === "/usr/bin/unzip") {
      return {
        exitCode: 0,
        signal: null,
        stdout: overrides.zipListing ?? macZipListing(),
        stderr: "",
      };
    }
    if (file === "/usr/bin/codesign" && args[0] === "--display") {
      const path = args.at(-1);
      if (path.endsWith(".dmg")) {
        const configured = overrides.containerSignature;
        const value =
          typeof configured === "function"
            ? configured(path)
            : (configured ??
              macSignature({
                identifier: "com.skytwin.desktop.dmg",
                actualCdHash: "b".repeat(40),
                runtime: false,
              }));
        overrides.afterContainerSignature?.(path);
        return { exitCode: 0, signal: null, stdout: "", stderr: value };
      }
      appIndex += 1;
      const value = overrides.signature?.(path, { appIndex }) ?? macSignature();
      overrides.afterSignature?.(path);
      return { exitCode: 0, signal: null, stdout: "", stderr: value };
    }
    if (file === "/usr/bin/lipo") {
      const value =
        typeof overrides.architecture === "function"
          ? overrides.architecture(args.at(-1), { appIndex })
          : (overrides.architecture ?? "arm64");
      return { exitCode: 0, signal: null, stdout: value, stderr: "" };
    }
    if (file === "/usr/bin/plutil") {
      const configured =
        args[1] === "CFBundleVersion"
          ? (overrides.bundleBuildVersion ?? overrides.bundleVersion)
          : (overrides.bundleShortVersion ?? overrides.bundleVersion);
      const value =
        typeof configured === "function"
          ? configured(args.at(-1), { appIndex })
          : (configured ?? identity.appVersion);
      return { exitCode: 0, signal: null, stdout: value, stderr: "" };
    }
    if (file === "/usr/sbin/spctl") {
      return {
        exitCode: overrides.gatekeeperExitCode ?? 0,
        signal: null,
        stdout: "",
        stderr:
          overrides.gatekeeper ??
          "accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: SkyTwin Test (TEAM123456)",
      };
    }
    if (file === "/usr/bin/xcrun") {
      return {
        exitCode: 0,
        signal: null,
        stdout: overrides.stapler ?? "The validate action worked!",
        stderr: "",
      };
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  });
}

function windowsSignature(overrides = {}) {
  return JSON.stringify({
    status: "Valid",
    signatureType: "Authenticode",
    signerSubject: "CN=SkyTwin Publisher",
    signerIssuer: "CN=Public Code Signing CA",
    signerSha256,
    codeSigningEku: true,
    timestampPresent: true,
    timestampSignerSha256: timestampSha256,
    productVersion: identity.appVersion,
    fileVersionMajor: 0,
    fileVersionMinor: 7,
    fileVersionBuild: 0,
    fileVersionPrivate: 0,
    ...overrides,
  });
}

function windowsPe(machine = 0x8664) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "binary");
  bytes.writeUInt16LE(machine, 0x44);
  return bytes;
}

function windowsExecutor(overrides = {}) {
  let quotaAttached = false;
  const diskpartScripts = [];
  const execute = vi.fn((file, args, options) => {
    if (file.endsWith("powershell.exe")) {
      const subjectPath = options.env.SKYTWIN_SIGNATURE_SUBJECT;
      const isInner = subjectPath.endsWith("SkyTwin.exe");
      const signature = isInner
        ? (overrides.innerSignature ?? windowsSignature())
        : (overrides.outerSignature ?? windowsSignature());
      overrides.afterSignature?.(subjectPath, { isInner });
      return { exitCode: 0, signal: null, stdout: signature, stderr: "" };
    }
    if (file.endsWith("\\7-Zip\\7z.exe")) {
      const archivePath = args.find(
        (arg, index) =>
          index > 0 &&
          !arg.startsWith("-") &&
          !arg.startsWith("$PLUGINSDIR") &&
          arg !== "SkyTwin.exe",
      );
      const isNsis = args.includes("-tNSIS");
      if (args[0] === "l") {
        const listing = isNsis
          ? (overrides.nsisListing ??
            `Path = ${archivePath}\nType = Nsis\n\nPath = $PLUGINSDIR/app-64.7z\nSize = 16\n`)
          : (overrides.payloadListing ??
            `Path = ${archivePath}\nType = 7z\n\nPath = SkyTwin.exe\nSize = 128\n`);
        return { exitCode: 0, signal: null, stdout: listing, stderr: "" };
      }
      if (args[0] === "x") {
        if (overrides.extractionFailure)
          return {
            exitCode: 2,
            signal: null,
            stdout: "",
            stderr: "There is not enough space on the disk",
          };
        const outputRoot = args.find((arg) => arg.startsWith("-o")).slice(2);
        if (isNsis) {
          const payload = join(outputRoot, "$PLUGINSDIR", "app-64.7z");
          mkdirSync(join(payload, ".."), { recursive: true });
          writeFileSync(payload, "application data");
        } else {
          const executable = join(outputRoot, "SkyTwin.exe");
          if (overrides.hardLinkInner) {
            const source = join(outputRoot, "..", "linked-SkyTwin.exe");
            writeFileSync(source, windowsPe(overrides.machine));
            linkSync(source, executable);
          } else writeFileSync(executable, windowsPe(overrides.machine));
        }
      }
      return { exitCode: 0, signal: null, stdout: "ok", stderr: "" };
    }
    if (file.endsWith("\\System32\\diskpart.exe")) {
      const script = readFileSync(args[1], "utf8");
      diskpartScripts.push(script);
      const attaching = script.includes("create vdisk");
      if (attaching && overrides.quotaCreationFailure)
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "DiskPart failed",
        };
      quotaAttached = attaching;
      if (script.includes("detach vdisk")) quotaAttached = false;
      overrides.afterDiskpart?.({ attaching, script });
      return {
        exitCode: 0,
        signal: null,
        stdout: "DiskPart successfully completed the operation.",
        stderr: "",
      };
    }
    throw new Error(`unexpected native tool ${file}`);
  });
  execute.inspectFilesystem = (path) =>
    path.endsWith("extraction-volume")
      ? {
          blocks: (17n * 1024n * 1024n * 1024n) / 4096n,
          bavail: (16n * 1024n * 1024n * 1024n) / 4096n,
          bsize: 4096n,
        }
      : {
          blocks: (64n * 1024n * 1024n * 1024n) / 4096n,
          bavail: (64n * 1024n * 1024n * 1024n) / 4096n,
          bsize: 4096n,
        };
  execute.inspectPath = (path) => ({
    dev: path.endsWith("extraction-volume") && quotaAttached ? 2n : 1n,
    isDirectory: () => true,
  });
  execute.diskpartScripts = diskpartScripts;
  return execute;
}

function windowsOptions(execute, overrides = {}) {
  return {
    execute,
    env: { SystemRoot: "C:\\Windows" },
    appVersion: identity.appVersion,
    inspectFilesystem: execute.inspectFilesystem,
    inspectPath: execute.inspectPath,
    ...overrides,
  };
}

describe("release.signing canonical verifier", () => {
  it("is a self-contained hosted verifier with only reviewed built-in dependencies", () => {
    const source = readFileSync(
      "scripts/release-claims/verifiers/release.signing.mjs",
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
    expect(source).toContain(
      "workflow wiring must inject both from protected operator/environment",
    );
    expect(source).toContain(
      "never tagged-workflow literals or artifact-derived values",
    );
  });

  it("admits only exact direct platform subjects and detects mutation races", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    expect(
      inspectPlatformSubjects(root, "macos", identity.appVersion).size,
    ).toBe(2);
    writeFileSync(
      join(root, "artifacts", "SkyTwin-macOS-dmg", "extra.dmg"),
      "extra",
    );
    expect(() =>
      inspectPlatformSubjects(root, "macos", identity.appVersion),
    ).toThrow("exactly one");

    const raceRoot = makeRoot();
    const subject = join(raceRoot, "subject");
    writeFileSync(subject, "before");
    expect(() =>
      inspectStableRegularFile(raceRoot, subject, "race subject", 100, {
        afterOpen: ({ requested }) => writeFileSync(requested, "after"),
      }),
    ).toThrow("changed while hashing");

    const linkedRoot = makeRoot();
    mkdirSync(join(linkedRoot, "real"));
    writeFileSync(join(linkedRoot, "real", "subject"), "bytes");
    symlinkSync(join(linkedRoot, "real", "subject"), join(linkedRoot, "link"));
    expect(() =>
      inspectStableRegularFile(linkedRoot, join(linkedRoot, "link"), "link"),
    ).toThrow("symlink component");
  });

  it("rejects noncanonical architecture filenames at artifact selection", () => {
    const wrongMacRoot = makeRoot();
    populateSubjects(wrongMacRoot, "macos", {
      "SkyTwin-macOS-dmg": "SkyTwin-0.7.0-x64.dmg",
      "SkyTwin-macOS-zip": "SkyTwin-0.7.0-x64-mac.zip",
    });
    expect(() =>
      inspectPlatformSubjects(wrongMacRoot, "macos", identity.appVersion),
    ).toThrow("unexpected filename");

    const mixedMacRoot = makeRoot();
    populateSubjects(mixedMacRoot, "macos", {
      "SkyTwin-macOS-zip": "SkyTwin-0.7.0-x64-mac.zip",
    });
    expect(() =>
      inspectPlatformSubjects(mixedMacRoot, "macos", identity.appVersion),
    ).toThrow("unexpected filename");

    // Linux remains unconditionally blocked until package-format trust and
    // internal architecture verification land. These cases intentionally
    // describe only the filename-level subject selection in this car.
    for (const [artifactName, filename] of [
      ["SkyTwin-Linux-deb", "skytwin-desktop_0.7.0_arm64.deb"],
      ["SkyTwin-Linux-rpm", "skytwin-desktop-0.7.0.aarch64.rpm"],
    ]) {
      const wrongLinuxRoot = makeRoot();
      populateSubjects(wrongLinuxRoot, "linux", { [artifactName]: filename });
      expect(() =>
        inspectPlatformSubjects(wrongLinuxRoot, "linux", identity.appVersion),
      ).toThrow("unexpected filename");
    }
  });

  it("keeps the configured Windows producer name aligned with upload and verifier contracts", () => {
    const desktopPackage = JSON.parse(
      readFileSync("apps/desktop/package.json", "utf8"),
    );
    const artifactTemplate = desktopPackage.build?.nsis?.artifactName;
    expect(artifactTemplate).toEqual(expect.any(String));
    const macroValues = new Map([
      ["productName", desktopPackage.build.productName],
      ["version", identity.appVersion],
      ["ext", "exe"],
    ]);
    const producedName = artifactTemplate.replace(
      /\$\{([^}]+)\}/gu,
      (_match, macro) => {
        const value = macroValues.get(macro);
        expect(value, `unsupported artifactName macro ${macro}`).toEqual(
          expect.any(String),
        );
        return value;
      },
    );
    expect(producedName).not.toContain("${");

    const root = makeRoot();
    for (const [artifactName, filename] of [
      ["SkyTwin-macOS-dmg", "SkyTwin-0.7.0-arm64.dmg"],
      ["SkyTwin-macOS-zip", "SkyTwin-0.7.0-arm64-mac.zip"],
      ["SkyTwin-macOS-update-manifest", "latest-mac.yml"],
      ["SkyTwin-Windows-installer", producedName],
      ["SkyTwin-Windows-update-manifest", "latest.yml"],
      ["SkyTwin-Linux-AppImage", "SkyTwin-0.7.0.AppImage"],
      ["SkyTwin-Linux-deb", "skytwin-desktop_0.7.0_amd64.deb"],
      ["SkyTwin-Linux-rpm", "skytwin-desktop-0.7.0.x86_64.rpm"],
      ["SkyTwin-Linux-update-manifest", "latest-linux.yml"],
    ]) {
      const directory = join(root, "artifacts", artifactName);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, filename), `${artifactName} bytes`);
    }
    expect(
      inspectPlatformSubjects(root, "windows", identity.appVersion).get(
        "SkyTwin-Windows-installer",
      ).name,
    ).toBe(producedName);
    expect(
      inspectArtifactVerificationSubjects(root, identity.appVersion).get(
        "SkyTwin-Windows-installer",
      ).name,
    ).toBe(producedName);

    const workflow = readFileSync(".github/workflows/build.yml", "utf8");
    const windowsJob = workflow.slice(
      workflow.indexOf("\n  desktop-windows:\n"),
      workflow.indexOf("\n  desktop-linux:\n"),
    );
    expect(windowsJob).toContain("path: apps/desktop/dist-electron/*.exe");
  });

  it("binds platform artifact IDs, archive digests, run, repository, commit, and tag ref", async () => {
    const artifacts = platformArtifacts("macos");
    const fetchImpl = apiFetch(artifacts);
    const resolved = await resolveCurrentRunArtifacts(
      identity,
      "macos",
      fetchImpl,
    );
    expect(resolved).toEqual(apiArtifactMap("macos"));
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    await expect(
      resolveCurrentRunArtifacts(
        identity,
        "macos",
        apiFetch([...artifacts, { ...artifacts[0], id: 99 }]),
      ),
    ).rejects.toThrow("found 2");
    await expect(
      resolveCurrentRunArtifacts(
        identity,
        "macos",
        apiFetch(artifacts, { head_sha: "f".repeat(40) }),
      ),
    ).rejects.toThrow("not the canonical tag-push build");

    const many = [
      ...artifacts,
      ...Array.from({ length: 99 }, (_, index) =>
        artifactRecord(`unrelated-${index}`, index + 100),
      ),
    ];
    await expect(
      resolveCurrentRunArtifacts(identity, "macos", apiFetch(many)),
    ).rejects.toThrow("paginated or incomplete");
  });

  it("requires native runner identity and explicit pinned publisher policy", () => {
    expect(
      readRunIdentity("macos", {
        RUNNER_OS: "macOS",
        RUNNER_ARCH: "ARM64",
        GITHUB_SHA: identity.sourceCommit,
        GITHUB_REPOSITORY: identity.repository,
        GITHUB_REF_NAME: identity.releaseTag,
        GITHUB_REF: identity.ref,
        GITHUB_RUN_ID: String(identity.runId),
        GITHUB_TOKEN: identity.token,
      }),
    ).toEqual({
      repository: identity.repository,
      sourceCommit: identity.sourceCommit,
      releaseTag: identity.releaseTag,
      ref: identity.ref,
      runId: identity.runId,
      token: identity.token,
    });
    expect(() =>
      readRunIdentity("macos", {
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
      }),
    ).toThrow("RUNNER_OS");
    expect(() => readTrustPolicy("macos", {})).toThrow("SKYTWIN_MACOS_TEAM_ID");
    expect(() => readTrustPolicy("windows", {})).toThrow(
      "SKYTWIN_WINDOWS_SIGNER_SHA256",
    );
    expect(
      readTrustPolicy("windows", {
        SKYTWIN_WINDOWS_SIGNER_SHA256: signerSha256.toUpperCase(),
      }),
    ).toEqual({ signerSha256 });
  });

  it("accepts only a unique hardened Developer ID chain from the pinned team", () => {
    expect(parseMacCodeSignature(macSignature(), teamId, "app")).toMatchObject({
      identifier: "com.skytwin.desktop",
      teamId,
    });
    expect(() =>
      parseMacCodeSignature(
        macSignature({ actualTeamId: "OTHER12345" }),
        teamId,
        "app",
      ),
    ).toThrow("untrusted");
    expect(() =>
      parseMacCodeSignature(macSignature({ runtime: false }), teamId, "app"),
    ).toThrow("hardened runtime");
    expect(() =>
      parseMacCodeSignature(
        `${macSignature()}\nAuthority=Developer ID Application: Other (TEAM123456)`,
        teamId,
        "app",
      ),
    ).toThrow("ambiguous");
    expect(() =>
      parseMacCodeSignature(
        macSignature().replace(
          "Authority=Developer ID Application: SkyTwin Test (TEAM123456)\nAuthority=Developer ID Certification Authority",
          "Authority=Developer ID Certification Authority\nAuthority=Developer ID Application: SkyTwin Test (TEAM123456)",
        ),
        teamId,
        "app",
      ),
    ).toThrow("authority chain");
    expect(() =>
      parseMacCodeSignature(
        `${macSignature()}\nAuthority=Unexpected Root`,
        teamId,
        "app",
      ),
    ).toThrow("authority chain");
    expect(() =>
      parseMacCodeSignature(
        macSignature({ signer: "Developer ID Application:" }),
        teamId,
        "app",
      ),
    ).toThrow("authority chain");
    expect(() =>
      parseMacCodeSignature(
        macSignature({
          signer: "Developer ID Application: Other Publisher (OTHER12345)",
        }),
        teamId,
        "app",
      ),
    ).toThrow("does not match its TeamIdentifier");
    expect(() =>
      parseMacCodeSignature(
        macSignature({ actualCdHash: "not-a-cdhash" }),
        teamId,
        "app",
      ),
    ).toThrow("invalid CDHash");
    expect(() =>
      parseMacGatekeeper("accepted\nsource=Developer ID", "app"),
    ).toThrow("not accepted as a notarized");
    expect(() =>
      parseMacGatekeeper(
        "/tmp/SkyTwin.app: rejected\nsource=Notarized Developer ID",
        "app",
      ),
    ).toThrow("not accepted as a notarized");
  });

  it("opens the exact DMG and ZIP apps and requires signatures, Gatekeeper trust, and stapled notarization", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const execute = macExecutor();
    const result = verifyMacSubjects(
      subjects,
      { teamId },
      {
        execute,
        appVersion: identity.appVersion,
        env: { PATH: "/usr/bin", GITHUB_TOKEN: "must-not-leak" },
      },
    );
    expect([...result.keys()]).toEqual([
      "SkyTwin-macOS-dmg",
      "SkyTwin-macOS-zip",
    ]);
    expect([...result.values()]).toEqual([
      expect.objectContaining({
        signatureResult: "pass",
        notarizationResult: "pass",
        signerTeamId: teamId,
        signedContentCdHash: cdHash,
        signedBundleVersion: identity.appVersion,
        signedBundleBuildVersion: identity.appVersion,
        executableArchitecture: "arm64",
        containerSignature: expect.objectContaining({
          signatureResult: "pass",
          signerTeamId: teamId,
          signedIdentifier: "com.skytwin.desktop.dmg",
          signedContentCdHash: "b".repeat(40),
        }),
      }),
      expect.objectContaining({
        signatureResult: "pass",
        notarizationResult: "pass",
        signerTeamId: teamId,
        signedContentCdHash: cdHash,
        signedBundleVersion: identity.appVersion,
        signedBundleBuildVersion: identity.appVersion,
        executableArchitecture: "arm64",
        containerSignature: null,
      }),
    ]);
    expect(
      execute.mock.calls.some(
        ([file, args]) =>
          file === "/usr/bin/hdiutil" &&
          args[0] === "create" &&
          args.includes("5642880k") &&
          args.includes("HFS+") &&
          args.includes("UDIF") &&
          args.at(-1).endsWith("zip-quota.dmg"),
      ),
    ).toBe(true);
    const volumeCreateIndex = execute.mock.calls.findIndex(
      ([file, args]) => file === "/usr/bin/hdiutil" && args[0] === "create",
    );
    const volumeAttachIndex = execute.mock.calls.findIndex(
      ([file, args]) =>
        file === "/usr/bin/hdiutil" &&
        args[0] === "attach" &&
        !args.includes("-readonly"),
    );
    const zipExtractIndex = execute.mock.calls.findIndex(
      ([file]) => file === "/usr/bin/ditto",
    );
    expect(volumeCreateIndex).toBeGreaterThan(-1);
    expect(volumeAttachIndex).toBeGreaterThan(volumeCreateIndex);
    expect(zipExtractIndex).toBeGreaterThan(volumeAttachIndex);
    expect(execute.mock.calls[zipExtractIndex][1].at(-1)).toBe(
      execute.mock.calls[volumeAttachIndex][1][
        execute.mock.calls[volumeAttachIndex][1].indexOf("-mountpoint") + 1
      ],
    );
    expect(
      execute.mock.calls.some(
        ([file, args]) => file === "/usr/bin/hdiutil" && args[0] === "attach",
      ),
    ).toBe(true);
    expect(
      execute.mock.calls.some(
        ([file, args]) => file === "/usr/bin/hdiutil" && args[0] === "detach",
      ),
    ).toBe(true);
    expect(
      execute.mock.calls.some(
        ([file, args]) => file === "/usr/bin/ditto" && args.includes("-k"),
      ),
    ).toBe(true);
    const dmgPath = subjects.get("SkyTwin-macOS-dmg").path;
    const stagedDmgPaths = execute.mock.calls
      .filter(
        ([file, args]) =>
          file === "/usr/bin/codesign" &&
          ["--verify", "--display"].includes(args[0]) &&
          args.at(-1).endsWith(".dmg"),
      )
      .map(([, args]) => args.at(-1));
    expect(new Set(stagedDmgPaths).size).toBe(1);
    expect(stagedDmgPaths[0]).not.toBe(dmgPath);
    expect(stagedDmgPaths[0]).toContain("staged-subject");
    expect(
      execute.mock.calls.some(
        ([file, args]) =>
          file === "/usr/bin/codesign" &&
          args[0] === "--verify" &&
          args.includes("--strict") &&
          args.at(-1) === stagedDmgPaths[0],
      ),
    ).toBe(true);
    expect(
      execute.mock.calls.some(
        ([file, args]) =>
          file === "/usr/bin/codesign" &&
          args[0] === "--display" &&
          args.at(-1) === stagedDmgPaths[0],
      ),
    ).toBe(true);
    expect(
      execute.mock.calls.filter(([file]) => file === "/usr/bin/lipo"),
    ).toHaveLength(2);
    expect(
      execute.mock.calls.filter(([file]) => file === "/usr/bin/plutil"),
    ).toHaveLength(4);
    expect(result.get("SkyTwin-macOS-dmg").verificationMethod).toBe(
      "dmg-codesign+gatekeeper+stapler+dmg-contained-app-codesign",
    );
    expect(
      execute.mock.calls.every(([file]) =>
        [
          "/usr/bin/codesign",
          "/usr/sbin/spctl",
          "/usr/bin/xcrun",
          "/usr/bin/hdiutil",
          "/usr/bin/ditto",
          "/usr/bin/unzip",
          "/usr/bin/lipo",
          "/usr/bin/plutil",
        ].includes(file),
      ),
    ).toBe(true);
    expect(
      execute.mock.calls.every(
        ([, , options]) =>
          options.env.PATH === "/usr/bin:/bin:/usr/sbin:/sbin" &&
          !("HOME" in options.env) &&
          !("DEVELOPER_DIR" in options.env) &&
          Object.values(options.env).every(
            (value) => value !== "must-not-leak",
          ),
      ),
    ).toBe(true);

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({ stapler: "ticket absent" }),
          appVersion: identity.appVersion,
          env: {},
        },
      ),
    ).toThrow("stapled notarization");
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({ gatekeeperExitCode: 3 }),
          appVersion: identity.appVersion,
          env: {},
        },
      ),
    ).toThrow("Gatekeeper assessment failed");
  });

  it("pins each contained app signer and requires the same signed app in DMG and ZIP", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            containerSignature: macSignature({
              identifier: "com.skytwin.desktop.dmg",
              signer: "Developer ID Application: Rotated Name (TEAM123456)",
              actualCdHash: "b".repeat(40),
              runtime: false,
            }),
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("DMG signer does not match the contained application signer");

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            signature: (_path, { appIndex }) =>
              appIndex === 1
                ? macSignature({ actualTeamId: "OTHER12345" })
                : macSignature(),
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("SkyTwin-macOS-dmg Apple Team ID is untrusted");

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            signature: (_path, { appIndex }) =>
              macSignature({
                actualCdHash: appIndex === 1 ? cdHash : "d".repeat(40),
              }),
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("different signed application identities");

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            signature: (_path, { appIndex }) =>
              macSignature({
                signer:
                  appIndex === 1
                    ? "Developer ID Application: SkyTwin Test (TEAM123456)"
                    : "Developer ID Application: Rotated Name (TEAM123456)",
              }),
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("different signed application identities");
  });

  it("requires canonical arm64 executables and the release-tag bundle version", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({ architecture: "x86_64" }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("not the canonical arm64 architecture");
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({ bundleVersion: "0.6.99" }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("signed bundle short version does not match the release tag");
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({ bundleBuildVersion: "0.6.99" }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("signed bundle build version does not match the release tag");
  });

  it("preflights macOS ZIP member paths, types, counts, and expanded size", () => {
    expect(parseMacZipListing(macZipListing(), "macOS ZIP")).toHaveLength(2);
    expect(() =>
      parseMacZipListing(
        macZipListing([
          { permissions: "drwxr-xr-x", sizeBytes: 0, path: "SkyTwin.app/" },
          {
            permissions: "-rw-r--r--",
            sizeBytes: 1,
            path: "../outside",
          },
        ]),
        "macOS ZIP",
      ),
    ).toThrow("unsafe path component");
    expect(() =>
      parseMacZipListing(
        macZipListing([
          { permissions: "drwxr-xr-x", sizeBytes: 0, path: "SkyTwin.app/" },
          {
            permissions: "lrwxr-xr-x",
            sizeBytes: 4097,
            path: "SkyTwin.app/Contents/link",
          },
        ]),
        "macOS ZIP",
      ),
    ).toThrow("invalid symbolic-link member");
    const zipBomb = macZipListing().replace(
      "2 files, 6 bytes uncompressed,",
      "2 files, 4294967297 bytes uncompressed,",
    );
    expect(() => parseMacZipListing(zipBomb, "macOS ZIP")).toThrow(
      "expanded size is outside",
    );
  });

  it("sizes the ZIP extraction volume for content, allocation slack, and filesystem metadata", () => {
    const expandedBytes = 4 * 1024 * 1024 * 1024;
    const memberCount = 100_000;
    const size = macZipExtractionVolumeSize(expandedBytes, memberCount);
    const imageBytes = Number(size.slice(0, -1)) * 1024;
    expect(size).toBe("5642880k");
    expect(imageBytes).toBe(
      expandedBytes + memberCount * 4096 + 1024 * 1024 * 1024,
    );
    expect(() =>
      macZipExtractionVolumeSize(expandedBytes + 1, memberCount),
    ).toThrow("bytes are outside");
    expect(() =>
      macZipExtractionVolumeSize(expandedBytes, memberCount + 1),
    ).toThrow("member count is outside");
  });

  it("fails closed when actual ZIP expansion exhausts the bounded volume", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const defaultExecute = macExecutor();
    const execute = vi.fn((file, args, options) => {
      if (file === "/usr/bin/ditto")
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "No space left on device",
        };
      return defaultExecute(file, args, options);
    });

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute,
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("macOS ZIP extraction failed");
    const writableAttach = execute.mock.calls.find(
      ([file, args]) =>
        file === "/usr/bin/hdiutil" &&
        args[0] === "attach" &&
        !args.includes("-readonly"),
    );
    expect(writableAttach).toBeDefined();
    expect(
      execute.mock.calls.some(
        ([file, args]) =>
          file === "/usr/bin/hdiutil" &&
          args[0] === "detach" &&
          args[1] ===
            writableAttach[1][writableAttach[1].indexOf("-mountpoint") + 1],
      ),
    ).toBe(true);
  });

  it("refuses ZIP extraction unless the host can retain a safety reserve beyond the volume cap", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const execute = macExecutor();

    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute,
          appVersion: identity.appVersion,
          inspectFilesystem: () => ({ bavail: 1n, bsize: 4096n }),
        },
      ),
    ).toThrow("insufficient reserved free space");
    expect(
      execute.mock.calls.some(
        ([file, args]) => file === "/usr/bin/hdiutil" && args[0] === "create",
      ),
    ).toBe(false);
  });

  it("fails before mounting when the fixed macOS image consumes the post-allocation reserve", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const execute = macExecutor();
    let inspections = 0;
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute,
          appVersion: identity.appVersion,
          inspectFilesystem: () => {
            inspections += 1;
            return inspections === 1
              ? { bavail: 10_000_000n, bsize: 4096n }
              : { bavail: 1n, bsize: 4096n };
          },
        },
      ),
    ).toThrow("insufficient reserved free space");
    expect(
      execute.mock.calls.some(
        ([file, args]) => file === "/usr/bin/hdiutil" && args[0] === "create",
      ),
    ).toBe(true);
    expect(
      execute.mock.calls.some(
        ([file, args]) =>
          file === "/usr/bin/hdiutil" &&
          args[0] === "attach" &&
          !args.includes("-readonly"),
      ),
    ).toBe(false);
  });

  it("uses private staged container bytes across an original-path swap and restore", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const original = subjects.get("SkyTwin-macOS-dmg").path;
    const held = `${original}.held`;
    const defaultExecute = macExecutor();
    let swapped = false;
    const execute = vi.fn((file, args, options) => {
      expect(JSON.stringify(args)).not.toContain(original);
      if (!swapped && file === "/usr/bin/codesign") {
        swapped = true;
        renameSync(original, held);
        writeFileSync(original, "transient attacker replacement");
        const result = defaultExecute(file, args, options);
        rmSync(original);
        renameSync(held, original);
        return result;
      }
      return defaultExecute(file, args, options);
    });
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute,
          appVersion: identity.appVersion,
        },
      ),
    ).not.toThrow();
    expect(swapped).toBe(true);
    expect(readFileSync(original, "utf8")).toBe("signed dmg bytes");
  });

  it("rejects a packaged macOS executable changed during native verification", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    let changed = false;
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            afterSignature: (appPath) => {
              if (changed || !appPath.endsWith(".app")) return;
              changed = true;
              writeFileSync(
                join(appPath, "Contents", "MacOS", "SkyTwin"),
                "replaced after signature inspection",
              );
            },
          }),
          appVersion: identity.appVersion,
          env: {},
        },
      ),
    ).toThrow("packaged executable changed during native verification");
  });

  it("rejects a DMG changed after its native signature inspection", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            afterContainerSignature: (dmgPath) => {
              chmodSync(dmgPath, 0o600);
              writeFileSync(dmgPath, "replaced after signature inspection");
            },
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("subject changed while signing evidence was collected");
  });

  it("rejects a macOS ZIP whose extracted app contains an escaping link", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            afterExtract: (extracted) =>
              symlinkSync(
                "/tmp",
                join(extracted, "SkyTwin.app", "Contents", "escaping-link"),
              ),
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).toThrow("symbolic link outside extraction");
  });

  it("accepts production-shaped contained Electron framework links", () => {
    const root = makeRoot();
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const frameworkRecords = [
      { permissions: "drwxr-xr-x", sizeBytes: 0, path: "SkyTwin.app/" },
      {
        permissions: "-rwxr-xr-x",
        sizeBytes: 6,
        path: "SkyTwin.app/Contents/MacOS/SkyTwin",
      },
      {
        permissions: "lrwxr-xr-x",
        sizeBytes: 1,
        path: "SkyTwin.app/Contents/Frameworks/Electron Framework.framework/Versions/Current",
      },
      {
        permissions: "lrwxr-xr-x",
        sizeBytes: 44,
        path: "SkyTwin.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
      },
      {
        permissions: "lrwxr-xr-x",
        sizeBytes: 26,
        path: "SkyTwin.app/Contents/Frameworks/Electron Framework.framework/Resources",
      },
    ];
    expect(() =>
      verifyMacSubjects(
        subjects,
        { teamId },
        {
          execute: macExecutor({
            zipListing: macZipListing(frameworkRecords),
            afterExtract: (extracted) => {
              const framework = join(
                extracted,
                "SkyTwin.app",
                "Contents",
                "Frameworks",
                "Electron Framework.framework",
              );
              mkdirSync(join(framework, "Versions", "A", "Resources"), {
                recursive: true,
              });
              writeFileSync(
                join(framework, "Versions", "A", "Electron Framework"),
                "framework",
              );
              symlinkSync("A", join(framework, "Versions", "Current"));
              symlinkSync(
                "Versions/Current/Electron Framework",
                join(framework, "Electron Framework"),
              );
              symlinkSync(
                "Versions/Current/Resources",
                join(framework, "Resources"),
              );
            },
          }),
          appVersion: identity.appVersion,
        },
      ),
    ).not.toThrow();
  });

  it("requires valid pinned Authenticode, code-signing EKU, and a timestamp", () => {
    expect(
      parseWindowsSignature(windowsSignature(), signerSha256),
    ).toMatchObject({
      status: "Valid",
      signerSha256,
      timestampPresent: true,
    });
    expect(() =>
      parseWindowsSignature(
        windowsSignature({ status: "NotSigned" }),
        signerSha256,
      ),
    ).toThrow("not Valid");
    expect(() =>
      parseWindowsSignature(windowsSignature(), "c".repeat(64)),
    ).toThrow("untrusted");
    expect(() =>
      parseWindowsSignature(
        windowsSignature({ codeSigningEku: false }),
        signerSha256,
      ),
    ).toThrow("code-signing EKU");
    expect(() =>
      parseWindowsSignature(
        windowsSignature({
          timestampPresent: false,
          timestampSignerSha256: "",
        }),
        signerSha256,
      ),
    ).toThrow("timestamp");
  });

  it("verifies the actual Windows installer with a credential-minimal native command", () => {
    const root = makeRoot();
    prepareSource(root);
    populateSubjects(root, "windows");
    const subjects = inspectPlatformSubjects(
      root,
      "windows",
      identity.appVersion,
    );
    const execute = windowsExecutor();
    const result = verifyWindowsSubjects(
      subjects,
      { signerSha256 },
      windowsOptions(execute, {
        env: {
          SystemRoot: "C:\\Windows",
          PATH: "C:\\Windows\\System32",
          DATABASE_URL: "secret",
        },
      }),
    );
    expect(result.get("SkyTwin-Windows-installer")).toMatchObject({
      signatureResult: "pass",
      authenticodeStatus: "Valid",
      authenticodeSignatureType: "Authenticode",
      signerCertificateSha256: signerSha256,
      signerCertificatePinned: true,
      codeSigningEku: true,
      timestampCertificatePresent: true,
      timestampSignerCertificateSha256: timestampSha256,
      timestampCertificateValidation:
        "presence-and-fingerprint-recorded-not-independently-validated",
      productVersion: identity.appVersion,
      fileVersionMajor: 0,
      fileVersionMinor: 7,
      fileVersionBuild: 0,
      fileVersionPrivate: 0,
      containedExecutable: expect.objectContaining({
        derivationMethod: "nsis-7zip",
        derivationPath: "app-64.7z!/SkyTwin.exe",
        name: "SkyTwin.exe",
        architecture: "AMD64",
        productVersion: identity.appVersion,
        fileVersionMajor: 0,
        fileVersionMinor: 7,
        fileVersionBuild: 0,
        fileVersionPrivate: 0,
        signatureResult: "pass",
        signerCertificateSha256: signerSha256,
      }),
    });
    expect(execute).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
      expect.objectContaining({
        env: expect.not.objectContaining({
          DATABASE_URL: "secret",
          PATH: "C:\\Windows\\System32",
        }),
      }),
    );
    expect(execute.mock.calls[0][2].env.SKYTWIN_SIGNATURE_SUBJECT).not.toBe(
      subjects.get("SkyTwin-Windows-installer").path,
    );
    expect(execute.mock.calls[0][2].env.SKYTWIN_SIGNATURE_SUBJECT).toContain(
      "staged-subject",
    );
    expect(
      execute.mock.calls.some(([file]) =>
        file.endsWith("\\System32\\diskpart.exe"),
      ),
    ).toBe(true);
    expect(execute.diskpartScripts[0]).toContain("type=fixed");
    expect(
      execute.mock.calls
        .filter(([file]) => file.endsWith("\\7-Zip\\7z.exe"))
        .every(([, args]) =>
          args
            .filter((arg) => !arg.startsWith("-"))
            .every(
              (arg) =>
                !arg.endsWith(".exe") ||
                arg === "SkyTwin.exe" ||
                arg.includes("staged-subject"),
            ),
        ),
    ).toBe(true);
    const report = buildReport({
      root,
      platform: "windows",
      identity,
      apiArtifacts: apiArtifactMap("windows"),
      subjects,
      verification: result,
      runtime: { platform: "win32", arch: "x64" },
    });
    expect(report.checks[0].observed.assertion).toContain(
      "Get-AuthenticodeSignature reported Status=Valid",
    );
    expect(report.checks[0].observed.assertion).toContain(
      "matched the operator-supplied pin",
    );
    expect(report.checks[0].observed.assertion).not.toContain(
      "matched the protected pin",
    );
    expect(report.checks[0].observed.measurement).toContain(
      "recorded without an independent timestamp trust assertion",
    );
    expect(JSON.stringify(report)).not.toMatch(/trusted timestamp/iu);

    const missingEku = new Map(result);
    const incomplete = { ...missingEku.get("SkyTwin-Windows-installer") };
    delete incomplete.codeSigningEku;
    missingEku.set("SkyTwin-Windows-installer", incomplete);
    expect(() =>
      buildReport({
        root,
        platform: "windows",
        identity,
        apiArtifacts: apiArtifactMap("windows"),
        subjects,
        verification: missingEku,
        runtime: { platform: "win32", arch: "x64" },
      }),
    ).toThrow("unexpected or missing fields");

    const wrongMethod = new Map(result);
    wrongMethod.set("SkyTwin-Windows-installer", {
      ...wrongMethod.get("SkyTwin-Windows-installer"),
      verificationMethod: "fingerprint-only",
    });
    expect(() =>
      buildReport({
        root,
        platform: "windows",
        identity,
        apiArtifacts: apiArtifactMap("windows"),
        subjects,
        verification: wrongMethod,
        runtime: { platform: "win32", arch: "x64" },
      }),
    ).toThrow("incomplete or inconsistent Windows signing observations");
  });

  it("rejects unsafe Windows archive inventories and invalid contained executable identity", () => {
    expect(() =>
      parseSevenZipListing(
        "Path = archive.exe\n\nPath = ../app-64.7z\nSize = 1\n",
        "archive.exe",
        "NSIS",
      ),
    ).toThrow("unsafe Windows path component");
    expect(() =>
      parseSevenZipListing(
        "Path = archive.exe\n\nPath = app-64.7z\nSize = 1\nHard Link = other\n",
        "archive.exe",
        "NSIS",
      ),
    ).toThrow("link member");
    expect(() =>
      parseSevenZipListing(
        "Path = archive.exe\n\nPath = SkyTwin.exe\nSize = 1\n\nPath = skytwin.EXE\nSize = 1\n",
        "archive.exe",
        "payload",
      ),
    ).toThrow("case-colliding");

    const root = makeRoot();
    populateSubjects(root, "windows");
    const subjects = inspectPlatformSubjects(
      root,
      "windows",
      identity.appVersion,
    );
    const options = (execute) => windowsOptions(execute);
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(
          windowsExecutor({
            outerSignature: windowsSignature({ productVersion: "0.6.0" }),
          }),
        ),
      ),
    ).toThrow("Windows installer ProductVersion");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(
          windowsExecutor({
            outerSignature: windowsSignature({ fileVersionBuild: 99 }),
          }),
        ),
      ),
    ).toThrow("Windows installer FileVersionInfo");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(
          windowsExecutor({
            innerSignature: windowsSignature({ signerSubject: "CN=Other" }),
          }),
        ),
      ),
    ).toThrow("does not match the installer signer");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(
          windowsExecutor({
            innerSignature: windowsSignature({ productVersion: "0.6.0" }),
          }),
        ),
      ),
    ).toThrow("ProductVersion");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(windowsExecutor({ machine: 0x014c })),
      ),
    ).toThrow("not AMD64 PE");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(windowsExecutor({ hardLinkInner: true })),
      ),
    ).toThrow("hard link");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        options(
          windowsExecutor({
            afterSignature: (path, { isInner }) => {
              if (isInner) writeFileSync(path, windowsPe(0x014c));
            },
          }),
        ),
      ),
    ).toThrow("changed during signature verification");
  });

  it("uses the private staged Windows installer across an original-path swap and restore", () => {
    const root = makeRoot();
    populateSubjects(root, "windows");
    const subjects = inspectPlatformSubjects(
      root,
      "windows",
      identity.appVersion,
    );
    const original = subjects.get("SkyTwin-Windows-installer").path;
    const held = `${original}.held`;
    let swapped = false;
    const execute = windowsExecutor({
      afterSignature: (path, { isInner }) => {
        expect(path).not.toBe(original);
        if (isInner || swapped) return;
        swapped = true;
        renameSync(original, held);
        writeFileSync(original, "transient attacker replacement");
        rmSync(original);
        renameSync(held, original);
      },
    });
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        windowsOptions(execute),
      ),
    ).not.toThrow();
    expect(swapped).toBe(true);
    expect(readFileSync(original, "utf8")).toBe("signed installer bytes");
  });

  it("contains dishonest Windows expansion on a fixed VHDX and detaches after failure", () => {
    const root = makeRoot();
    populateSubjects(root, "windows");
    const subjects = inspectPlatformSubjects(
      root,
      "windows",
      identity.appVersion,
    );
    const execute = windowsExecutor({
      nsisListing:
        "Path = installer.exe\nType = Nsis\n\nPath = $PLUGINSDIR/app-64.7z\nSize = 1\n",
      extractionFailure: true,
    });
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        windowsOptions(execute),
      ),
    ).toThrow("Windows NSIS payload extraction failed");
    const scripts = execute.diskpartScripts;
    expect(scripts[0]).toContain("maximum=17799 type=fixed");
    expect(scripts[0]).toContain("assign mount=");
    expect(scripts.at(-1)).toContain("detach vdisk");
    expect(
      execute.mock.calls
        .filter(([file]) => file.endsWith("\\7-Zip\\7z.exe"))
        .every(([, args]) =>
          args
            .filter((arg) => arg.startsWith("-o"))
            .every((arg) => arg.includes("extraction-volume")),
        ),
    ).toBe(true);
  });

  it("rejects ambiguous or non-canonical Windows native-tool roots", () => {
    const root = makeRoot();
    populateSubjects(root, "windows");
    const subjects = inspectPlatformSubjects(
      root,
      "windows",
      identity.appVersion,
    );
    const execute = vi.fn();
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        { execute, env: { SystemRoot: "relative\\Windows" } },
      ),
    ).toThrow("canonical local SystemRoot");
    expect(() =>
      verifyWindowsSubjects(
        subjects,
        { signerSha256 },
        {
          execute,
          env: { SystemRoot: "C:\\Windows", WINDIR: "D:\\Windows" },
        },
      ),
    ).toThrow("SystemRoot and WINDIR disagree");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses Linux because no package-format trust policy is defined", () => {
    expect(() => readTrustPolicy("linux", {})).toThrow(
      "AppImage, deb, and rpm require explicit verification methods and pinned trust roots",
    );
    expect(() => verifyLinuxSubjects()).toThrow(
      "checksum/provenance evidence cannot substitute",
    );
  });

  it("builds deterministic applicability-valid reports covering every exact platform subject", () => {
    const root = makeRoot();
    prepareSource(root);
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const verification = new Map(
      [...subjects.keys()].map((artifactName) => [
        artifactName,
        macReportObservation(artifactName),
      ]),
    );
    const input = {
      root,
      platform: "macos",
      identity,
      apiArtifacts: apiArtifactMap("macos"),
      subjects,
      verification,
      runtime: { platform: "darwin", arch: "arm64" },
    };
    const report = buildReport(input);
    expect(buildReport(input)).toEqual(report);
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId: "release.signing",
      result: "pass",
      sourceCommit,
      releaseTag: identity.releaseTag,
      ref: identity.ref,
      runId: identity.runId,
      platform: "macos",
      runnerPlatform: "darwin-arm64",
      releaseArtifactName: "SkyTwin-macOS-dmg",
    });
    expect(report.coveredSubjects).toHaveLength(2);
    const releaseAssets = [...apiArtifactMap("macos").values()].map(
      (artifact) => {
        const subject = subjects.get(artifact.artifactName);
        return {
          ...artifact,
          subjects: [
            {
              name: subject.name,
              path: subject.relativePath,
              sha256: subject.sha256,
              sizeBytes: subject.sizeBytes,
            },
          ],
        };
      },
    );
    expect(
      verifyMachineEvidenceApplicability(
        "release.signing",
        report,
        releaseAssets,
      ),
    ).toEqual([]);
    const mismatchedContainer = structuredClone(report);
    const dmgObservation = mismatchedContainer.coveredSubjects.find(
      ({ artifactName }) => artifactName === "SkyTwin-macOS-dmg",
    );
    dmgObservation.containerSignature.signer =
      "Developer ID Application: Other Publisher (TEAM123456)";
    expect(
      verifyMachineEvidenceApplicability(
        "release.signing",
        mismatchedContainer,
        releaseAssets,
      ),
    ).not.toEqual([]);
  });

  it("refuses incomplete or inconsistent native observations while building a report", () => {
    const root = makeRoot();
    prepareSource(root);
    populateSubjects(root, "macos");
    const subjects = inspectPlatformSubjects(
      root,
      "macos",
      identity.appVersion,
    );
    const baseVerification = new Map(
      [...subjects.keys()].map((artifactName) => [
        artifactName,
        macReportObservation(artifactName),
      ]),
    );
    const input = {
      root,
      platform: "macos",
      identity,
      apiArtifacts: apiArtifactMap("macos"),
      subjects,
      runtime: { platform: "darwin", arch: "arm64" },
    };

    const missing = new Map(baseVerification);
    const missingDmg = { ...missing.get("SkyTwin-macOS-dmg") };
    delete missingDmg.signedContentCdHash;
    missing.set("SkyTwin-macOS-dmg", missingDmg);
    expect(() => buildReport({ ...input, verification: missing })).toThrow(
      "unexpected or missing fields",
    );

    const wrongMethod = new Map(baseVerification);
    wrongMethod.set("SkyTwin-macOS-dmg", {
      ...wrongMethod.get("SkyTwin-macOS-dmg"),
      verificationMethod: "codesign-only",
    });
    expect(() => buildReport({ ...input, verification: wrongMethod })).toThrow(
      "incomplete or inconsistent macOS signing observations",
    );

    const wrongContainerSigner = new Map(baseVerification);
    wrongContainerSigner.set("SkyTwin-macOS-dmg", {
      ...wrongContainerSigner.get("SkyTwin-macOS-dmg"),
      containerSignature: {
        ...wrongContainerSigner.get("SkyTwin-macOS-dmg").containerSignature,
        signer: "Developer ID Application: Other Publisher (TEAM123456)",
      },
    });
    expect(() =>
      buildReport({ ...input, verification: wrongContainerSigner }),
    ).toThrow("incomplete or inconsistent macOS signing observations");

    const tamperedIdentity = new Map(baseVerification);
    tamperedIdentity.set("SkyTwin-macOS-zip", {
      ...tamperedIdentity.get("SkyTwin-macOS-zip"),
      signedContentCdHash: "d".repeat(40),
    });
    expect(() =>
      buildReport({ ...input, verification: tamperedIdentity }),
    ).toThrow("different signed application identities");
  });

  it("uses exact canonical CLI paths and cannot pass the current unsigned workflow", async () => {
    expect(
      parseCanonicalArgs([
        "--platform",
        "macos",
        "--output",
        ".release-evidence/reports/release.signing.macos.json",
      ]),
    ).toEqual({
      platform: "macos",
      output: ".release-evidence/reports/release.signing.macos.json",
    });
    expect(() =>
      parseCanonicalArgs([
        "--platform",
        "macos",
        "--output",
        "/tmp/forged.json",
      ]),
    ).toThrow("usage");

    const workflow = readFileSync(".github/workflows/build.yml", "utf8");
    const desktopPackage = JSON.parse(
      readFileSync("apps/desktop/package.json", "utf8"),
    );
    expect(desktopPackage.build.dmg.sign).toBe(true);
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'");
    expect(workflow).not.toContain("SKYTWIN_MACOS_TEAM_ID:");
    expect(workflow).not.toContain("SKYTWIN_WINDOWS_SIGNER_SHA256:");

    const root = makeRoot();
    prepareSource(root);
    populateSubjects(root, "macos");
    const executeNative = vi.fn();
    await expect(
      runCanonicalVerifier(
        [
          "--platform",
          "macos",
          "--output",
          ".release-evidence/reports/release.signing.macos.json",
        ],
        {
          root,
          runtime: { platform: "darwin", arch: "arm64" },
          env: {
            RUNNER_OS: "macOS",
            RUNNER_ARCH: "ARM64",
            GITHUB_SHA: identity.sourceCommit,
            GITHUB_REPOSITORY: identity.repository,
            GITHUB_REF_NAME: identity.releaseTag,
            GITHUB_REF: identity.ref,
            GITHUB_RUN_ID: String(identity.runId),
            GITHUB_TOKEN: identity.token,
          },
          executeGit: vi.fn((args) =>
            args[0] === "rev-parse" ? `${identity.sourceCommit}\n` : "",
          ),
          fetchImpl: apiFetch(platformArtifacts("macos")),
          executeNative,
        },
      ),
    ).rejects.toThrow("SKYTWIN_MACOS_TEAM_ID");
    expect(executeNative).not.toHaveBeenCalled();
  });

  it("writes a passing report only after the complete native and provenance path succeeds", async () => {
    const root = makeRoot();
    prepareSource(root);
    populateSubjects(root, "macos");
    const output = ".release-evidence/reports/release.signing.macos.json";
    const workflowOutput = join(root, "github-output.txt");
    writeFileSync(workflowOutput, "");
    const report = await runCanonicalVerifier(
      ["--platform", "macos", "--output", output],
      {
        root,
        runtime: { platform: "darwin", arch: "arm64" },
        env: {
          RUNNER_OS: "macOS",
          RUNNER_ARCH: "ARM64",
          GITHUB_SHA: identity.sourceCommit,
          GITHUB_REPOSITORY: identity.repository,
          GITHUB_REF_NAME: identity.releaseTag,
          GITHUB_REF: identity.ref,
          GITHUB_RUN_ID: String(identity.runId),
          GITHUB_TOKEN: identity.token,
          SKYTWIN_MACOS_TEAM_ID: teamId,
          GITHUB_ACTIONS: "true",
          GITHUB_OUTPUT: workflowOutput,
        },
        executeGit: vi.fn((args) =>
          args[0] === "rev-parse" ? `${identity.sourceCommit}\n` : "",
        ),
        fetchImpl: apiFetch(platformArtifacts("macos")),
        executeNative: macExecutor(),
      },
    );
    expect(JSON.parse(readFileSync(join(root, output), "utf8"))).toEqual(
      report,
    );
    expect(report.result).toBe("pass");
    expect(report.coveredSubjects).toHaveLength(2);
    const reportSha256 = sha256(readFileSync(join(root, output)));
    expect(readFileSync(workflowOutput, "utf8")).toBe(
      `report_sha256=${reportSha256}\n`,
    );
    const confirmationDirectory = join(
      root,
      ".release-evidence",
      "upload-confirmation",
    );
    mkdirSync(confirmationDirectory, { recursive: true });
    const confirmationPath = join(
      confirmationDirectory,
      "release.signing.macos.json",
    );
    writeFileSync(confirmationPath, readFileSync(join(root, output)));
    expect(
      verifyUploadedReport(
        [
          "--platform",
          "macos",
          "--report",
          ".release-evidence/upload-confirmation/release.signing.macos.json",
        ],
        {
          root,
          env: {
            SKYTWIN_EXPECTED_REPORT_SHA256: reportSha256,
            SKYTWIN_UPLOADED_ARTIFACT_ID: "321",
            SKYTWIN_UPLOADED_ARTIFACT_SHA256: "d".repeat(64),
          },
        },
      ),
    ).toEqual({
      artifactId: 321,
      artifactSha256: "d".repeat(64),
      reportSha256,
    });
    writeFileSync(confirmationPath, "swapped during upload");
    expect(() =>
      verifyUploadedReport(
        [
          "--platform",
          "macos",
          "--report",
          ".release-evidence/upload-confirmation/release.signing.macos.json",
        ],
        {
          root,
          env: {
            SKYTWIN_EXPECTED_REPORT_SHA256: reportSha256,
            SKYTWIN_UPLOADED_ARTIFACT_ID: "321",
            SKYTWIN_UPLOADED_ARTIFACT_SHA256: "d".repeat(64),
          },
        },
      ),
    ).toThrow("does not match verifier output");
  });

  it.each(["evidence-root", "reports"])(
    "refuses a pre-existing %s symlink without touching its outside target",
    async (symlinkLocation) => {
      const root = makeRoot();
      const outside = makeRoot();
      prepareSource(root);
      populateSubjects(root, "macos");
      const evidenceRoot = join(root, ".release-evidence");
      if (symlinkLocation === "evidence-root") {
        symlinkSync(outside, evidenceRoot, "dir");
      } else {
        mkdirSync(evidenceRoot);
        symlinkSync(outside, join(evidenceRoot, "reports"), "dir");
      }

      await expect(
        runCanonicalVerifier(
          [
            "--platform",
            "macos",
            "--output",
            ".release-evidence/reports/release.signing.macos.json",
          ],
          {
            root,
            runtime: { platform: "darwin", arch: "arm64" },
            env: {
              RUNNER_OS: "macOS",
              RUNNER_ARCH: "ARM64",
              GITHUB_SHA: identity.sourceCommit,
              GITHUB_REPOSITORY: identity.repository,
              GITHUB_REF_NAME: identity.releaseTag,
              GITHUB_REF: identity.ref,
              GITHUB_RUN_ID: String(identity.runId),
              GITHUB_TOKEN: identity.token,
              SKYTWIN_MACOS_TEAM_ID: teamId,
            },
            executeGit: vi.fn((args) =>
              args[0] === "rev-parse" ? `${identity.sourceCommit}\n` : "",
            ),
            fetchImpl: apiFetch(platformArtifacts("macos")),
            executeNative: macExecutor(),
          },
        ),
      ).rejects.toThrow("must be a direct real directory inside checkout");
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it("does not write evidence when a release subject changes during native verification", async () => {
    const root = makeRoot();
    prepareSource(root);
    populateSubjects(root, "macos");
    const output = ".release-evidence/reports/release.signing.macos.json";
    const dmg = join(
      root,
      "artifacts",
      "SkyTwin-macOS-dmg",
      "SkyTwin-0.7.0-arm64.dmg",
    );
    let changed = false;
    await expect(
      runCanonicalVerifier(["--platform", "macos", "--output", output], {
        root,
        runtime: { platform: "darwin", arch: "arm64" },
        env: {
          RUNNER_OS: "macOS",
          RUNNER_ARCH: "ARM64",
          GITHUB_SHA: identity.sourceCommit,
          GITHUB_REPOSITORY: identity.repository,
          GITHUB_REF_NAME: identity.releaseTag,
          GITHUB_REF: identity.ref,
          GITHUB_RUN_ID: String(identity.runId),
          GITHUB_TOKEN: identity.token,
          SKYTWIN_MACOS_TEAM_ID: teamId,
        },
        executeGit: vi.fn((args) =>
          args[0] === "rev-parse" ? `${identity.sourceCommit}\n` : "",
        ),
        fetchImpl: apiFetch(platformArtifacts("macos")),
        executeNative: macExecutor({
          afterSignature: () => {
            if (changed) return;
            changed = true;
            writeFileSync(dmg, "changed while evidence was collected");
          },
        }),
      }),
    ).rejects.toThrow(
      "SkyTwin-macOS-dmg changed while signing evidence was collected",
    );
    expect(existsSync(join(root, output))).toBe(false);
  });
});
