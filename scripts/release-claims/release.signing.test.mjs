import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport,
  inspectPlatformSubjects,
  inspectStableRegularFile,
  parseCanonicalArgs,
  parseMacCodeSignature,
  parseMacGatekeeper,
  parseWindowsSignature,
  readRunIdentity,
  readTrustPolicy,
  resolveCurrentRunArtifacts,
  runCanonicalVerifier,
  verifyLinuxSubjects,
  verifyMacSubjects,
  verifyWindowsSubjects,
} from "./verifiers/release.signing.mjs";
import { verifyMachineEvidenceApplicability } from "./check-release-claims.mjs";

const temporary = [];
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const signerSha256 = "a".repeat(64);
const timestampSha256 = "b".repeat(64);
const teamId = "TEAM123456";
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

function populateSubjects(root, platform) {
  for (const [artifactName, filename, bytes] of subjectFixtures[platform]) {
    const directory = join(root, "artifacts", artifactName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, filename), bytes);
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
  runtime = true,
} = {}) {
  return [
    `Identifier=${identifier}`,
    `Authority=${signer}`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    `TeamIdentifier=${actualTeamId}`,
    runtime
      ? "CodeDirectory flags=0x10000(runtime)"
      : "CodeDirectory flags=0x0(none)",
  ].join("\n");
}

function createMacApp(root) {
  const executable = join(root, "SkyTwin.app", "Contents", "MacOS");
  mkdirSync(executable, { recursive: true });
  writeFileSync(join(executable, "SkyTwin"), "mach-o");
}

function macExecutor(overrides = {}) {
  return vi.fn((file, args) => {
    if (file === "/usr/bin/hdiutil" && args[0] === "attach") {
      createMacApp(args[args.indexOf("-mountpoint") + 1]);
      return { exitCode: 0, signal: null, stdout: "attached", stderr: "" };
    }
    if (file === "/usr/bin/ditto") {
      createMacApp(args.at(-1));
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    }
    if (file === "/usr/bin/codesign" && args[0] === "--display") {
      const path = args.at(-1);
      const isDmg = path.endsWith(".dmg");
      const value =
        overrides.signature?.(path) ??
        macSignature({
          identifier: isDmg ? "com.skytwin.desktop.dmg" : undefined,
        });
      overrides.afterSignature?.(path);
      return { exitCode: 0, signal: null, stdout: "", stderr: value };
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
    ...overrides,
  });
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
      }),
      expect.objectContaining({
        signatureResult: "pass",
        notarizationResult: "pass",
        signerTeamId: teamId,
      }),
    ]);
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
    expect(
      execute.mock.calls.every(([file]) =>
        [
          "/usr/bin/codesign",
          "/usr/sbin/spctl",
          "/usr/bin/xcrun",
          "/usr/bin/hdiutil",
          "/usr/bin/ditto",
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
          env: {},
        },
      ),
    ).toThrow("Gatekeeper assessment failed");
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
              if (changed) return;
              changed = true;
              writeFileSync(
                join(appPath, "Contents", "MacOS", "SkyTwin"),
                "replaced after signature inspection",
              );
            },
          }),
          env: {},
        },
      ),
    ).toThrow("packaged executable changed during native verification");
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
    const execute = vi.fn(() => ({
      exitCode: 0,
      signal: null,
      stdout: windowsSignature(),
      stderr: "",
    }));
    const result = verifyWindowsSubjects(
      subjects,
      { signerSha256 },
      {
        execute,
        env: {
          SystemRoot: "C:\\Windows",
          PATH: "C:\\Windows\\System32",
          DATABASE_URL: "secret",
        },
      },
    );
    expect(result.get("SkyTwin-Windows-installer")).toMatchObject({
      signatureResult: "pass",
      authenticodeStatus: "Valid",
      signerCertificateSha256: signerSha256,
      signerCertificatePinned: true,
      timestampCertificatePresent: true,
      timestampSignerCertificateSha256: timestampSha256,
      timestampCertificateValidation:
        "presence-and-fingerprint-recorded-not-independently-validated",
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
    expect(execute.mock.calls[0][2].env.SKYTWIN_SIGNATURE_SUBJECT).toBe(
      subjects.get("SkyTwin-Windows-installer").path,
    );
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
        {
          signatureResult: "pass",
          notarizationResult: "pass",
          verificationMethod: "native-test",
          signer: "Developer ID Application: SkyTwin Test (TEAM123456)",
          signerTeamId: teamId,
          signedIdentifier: "com.skytwin.desktop",
        },
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
  });

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
      "SkyTwin-macOS-dmg subject changed while signing evidence was collected",
    );
    expect(existsSync(join(root, output))).toBe(false);
  });
});
