import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAllowlistedVerificationCommand,
  verifyMachineEvidenceApplicability,
} from "./check-release-claims.mjs";
import {
  SANDBOX_PROFILE,
  boundedSpawn,
  buildReport,
  captureOwnedSocketSample,
  makeClosedEnvironment,
  makeSandboxedLaunch,
  ownedProcessTree,
  parseCanonicalArgs,
  parseLsofSockets,
  parseProcessTable,
  readRunIdentity,
  resolveReleaseArtifact,
  resolveRunProvenance,
  runCanonicalVerifier,
  runContinuousSampler,
  selfTestSandbox,
  validateOwnedReadiness,
  validateSandboxSelfTestResult,
  validateSocketInventory,
  waitForTwoCleanSamples,
} from "./verifiers/network.explicit-boundaries.mjs";
import { targetIsUnused } from "./verifiers/storage.desktop-crdb.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function identity(overrides = {}) {
  return {
    sourceCommit: "a".repeat(40),
    repository: "owner/repo",
    releaseTag: "v1.2.3.4",
    ref: "refs/tags/v1.2.3.4",
    runId: 41,
    runAttempt: 2,
    token: "t".repeat(40),
    ...overrides,
  };
}

function provenance(overrides = {}) {
  return {
    runAttemptStartedAt: "2026-09-15T01:00:00Z",
    desktopProducerJobId: 100,
    desktopProducerJobName: "Desktop — macOS (DMG + ZIP)",
    desktopProducerJobRunAttempt: 2,
    desktopProducerJobConclusion: "success",
    desktopProducerJobStartedAt: "2026-09-15T01:01:00Z",
    desktopProducerJobCompletedAt: "2026-09-15T01:05:00Z",
    desktopUploadStartedAt: "2026-09-15T01:03:00Z",
    desktopUploadCompletedAt: "2026-09-15T01:04:00Z",
    verifierJobId: 101,
    verifierJobName:
      "release-machine-evidence / network.explicit-boundaries / macos",
    verifierJobRunAttempt: 2,
    verifierJobStatus: "in_progress",
    artifactWindow: {
      uploadStarted: Date.parse("2026-09-15T01:03:00Z"),
      desktopCompleted: Date.parse("2026-09-15T01:05:00Z"),
    },
    ...overrides,
  };
}

function report() {
  return buildReport({
    identity: identity(),
    provenance: provenance(),
    artifact: {
      id: 22,
      digest: "b".repeat(64),
      createdAt: "2026-09-15T01:03:30Z",
      attemptBindingResult: "workflow-output-and-producer-window-pass",
    },
    subject: { name: "SkyTwin.zip", sha256: "c".repeat(64) },
    executable: {
      name: "SkyTwin",
      sizeBytes: 1000,
      sha256: "d".repeat(64),
      device: 10,
      inode: 20,
    },
    verifier: { sha256: "e".repeat(64) },
    sandbox: {
      profileSha256: "f".repeat(64),
      parentLoopbackResult: "pass",
      parentExternalError: "EPERM",
      childLoopbackResult: "pass",
      childExternalError: "EPERM",
      inheritanceResult: "pass",
    },
    observation: {
      sandboxedLaunchResult: "pass",
      ownedNonceResult: "pass",
      apiReadinessResult: "pass",
      dashboardReadinessResult: "pass",
      accountFreeRead: {
        result: "pass",
        method: "GET",
        pathClass: "sample-decisions",
        responseBytesBound: 262144,
      },
      sampleCount: 5,
      maxOwnedProcessCount: 6,
      maxOwnedSocketCount: 8,
      observedLoopbackPorts: [26257, 26258, 3100, 3200],
      addressPolicy: "literal-ipv4-loopback-only",
      foreignManagedSocketCount: 0,
      wildcardSocketCount: 0,
      externalSocketCount: 0,
      udpOrMulticastSocketCount: 0,
      gracefulShutdownResult: "pass",
      forcedShutdown: false,
      postShutdownConsecutiveCleanSamples: 2,
    },
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function runFixture() {
  const id = identity();
  const desktop = {
    id: 100,
    name: "Desktop — macOS (DMG + ZIP)",
    run_id: id.runId,
    run_attempt: id.runAttempt,
    head_sha: id.sourceCommit,
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-15T01:01:00Z",
    completed_at: "2026-09-15T01:05:00Z",
    steps: [
      {
        name: "Package macOS desktop app",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-15T01:01:30Z",
        completed_at: "2026-09-15T01:02:30Z",
      },
      {
        name: "Upload macOS ZIP",
        status: "completed",
        conclusion: "success",
        started_at: "2026-09-15T01:03:00Z",
        completed_at: "2026-09-15T01:04:00Z",
      },
    ],
  };
  const verifier = {
    id: 101,
    name: "release-machine-evidence / network.explicit-boundaries / macos",
    run_id: id.runId,
    run_attempt: id.runAttempt,
    head_sha: id.sourceCommit,
    status: "in_progress",
    conclusion: null,
    steps: [
      {
        name: "Run canonical machine verifier",
        status: "in_progress",
        conclusion: null,
      },
    ],
  };
  const run = {
    id: id.runId,
    run_attempt: id.runAttempt,
    repository: { full_name: id.repository },
    head_sha: id.sourceCommit,
    head_branch: id.releaseTag,
    event: "push",
    path: ".github/workflows/build.yml",
    run_started_at: "2026-09-15T01:00:00Z",
  };
  return { id, desktop, verifier, run };
}

describe("network verifier canonical inputs and provenance", () => {
  it("accepts only the canonical invocation and focused ledger command", () => {
    const output = ".release-evidence/reports/network.explicit-boundaries.json";
    expect(
      parseCanonicalArgs(["--platform", "macos", "--output", output]),
    ).toEqual({
      platform: "macos",
      output,
    });
    expect(() =>
      parseCanonicalArgs(["--platform", "linux", "--output", output]),
    ).toThrow(/exactly/);
    expect(() =>
      parseCanonicalArgs(["--platform", "macos", "--output", "../escape"]),
    ).toThrow(/exactly/);
    const command =
      "pnpm exec vitest run scripts/release-claims/network.explicit-boundaries-verifier.test.mjs";
    expect(isAllowlistedVerificationCommand(command)).toBe(true);
    expect(
      isAllowlistedVerificationCommand(`${command} --passWithNoTests`),
    ).toBe(false);
    expect(isAllowlistedVerificationCommand(`${command}; echo bypass`)).toBe(
      false,
    );
  });

  it("requires exact tag/run/attempt/head and native runner identity", () => {
    const env = {
      RUNNER_OS: "macOS",
      RUNNER_ARCH: "ARM64",
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REF_NAME: "v1.2.3.4",
      GITHUB_REF: "refs/tags/v1.2.3.4",
      GITHUB_RUN_ID: "41",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_TOKEN: "t".repeat(40),
    };
    expect(readRunIdentity(env, { platform: "darwin", arch: "arm64" })).toEqual(
      identity(),
    );
    for (const mutate of [
      (value) => {
        value.GITHUB_REF = "refs/tags/v9";
      },
      (value) => {
        value.GITHUB_RUN_ATTEMPT = "0";
      },
      (value) => {
        value.GITHUB_EVENT_NAME = "workflow_dispatch";
      },
      (value) => {
        value.GITHUB_SHA = "short";
      },
    ]) {
      const changed = { ...env };
      mutate(changed);
      expect(() =>
        readRunIdentity(changed, { platform: "darwin", arch: "arm64" }),
      ).toThrow();
    }
  });

  it("binds the exact current attempt, successful producer, and active verifier", async () => {
    const fixture = runFixture();
    const fetchImpl = async (url) => {
      if (url.endsWith("/jobs?per_page=100&page=1"))
        return jsonResponse({
          total_count: 2,
          jobs: [fixture.desktop, fixture.verifier],
        });
      return jsonResponse(fixture.run);
    };
    await expect(
      resolveRunProvenance(fixture.id, fetchImpl),
    ).resolves.toMatchObject({
      runAttemptStartedAt: "2026-09-15T01:00:00Z",
      desktopProducerJobId: 100,
      verifierJobId: 101,
    });
    for (const mutate of [
      (value) => {
        value.run.head_sha = "b".repeat(40);
      },
      (value) => {
        value.desktop.run_attempt = 1;
      },
      (value) => {
        value.desktop.conclusion = "failure";
      },
      (value) => {
        value.verifier.status = "completed";
      },
      (value) => {
        value.verifier.head_sha = "b".repeat(40);
      },
      (value) => {
        value.desktop.steps[1].conclusion = "skipped";
      },
    ]) {
      const changed = structuredClone(fixture);
      mutate(changed);
      const rejectingFetch = async (url) => {
        if (url.endsWith("/jobs?per_page=100&page=1"))
          return jsonResponse({
            total_count: 2,
            jobs: [changed.desktop, changed.verifier],
          });
        return jsonResponse(changed.run);
      };
      await expect(
        resolveRunProvenance(changed.id, rejectingFetch),
      ).rejects.toThrow();
    }
  });

  it("rejects artifact ID, digest, attempt window, run, and head substitution", async () => {
    const id = identity();
    const prov = provenance();
    const artifact = {
      id: 22,
      name: "SkyTwin-macOS-zip",
      expired: false,
      digest: `sha256:${"b".repeat(64)}`,
      created_at: "2026-09-15T01:03:30Z",
      workflow_run: { id: id.runId, head_sha: id.sourceCommit },
    };
    const fetchImpl = async (url) =>
      jsonResponse(
        url.endsWith("/artifacts/22")
          ? artifact
          : { total_count: 1, artifacts: [artifact] },
      );
    await expect(
      resolveReleaseArtifact(id, 22, "b".repeat(64), prov, fetchImpl),
    ).resolves.toMatchObject({ id: 22 });
    for (const [expectedId, digest, mutate] of [
      [23, "b".repeat(64), () => {}],
      [22, "c".repeat(64), () => {}],
      [
        22,
        "b".repeat(64),
        (value) => {
          value.workflow_run.head_sha = "c".repeat(40);
        },
      ],
      [
        22,
        "b".repeat(64),
        (value) => {
          value.created_at = "2026-09-15T01:06:00Z";
        },
      ],
    ]) {
      const changed = structuredClone(artifact);
      mutate(changed);
      const rejectingFetch = async (url) =>
        jsonResponse(
          url.endsWith(`/artifacts/${expectedId}`)
            ? changed
            : { total_count: 1, artifacts: [changed] },
        );
      await expect(
        resolveReleaseArtifact(id, expectedId, digest, prov, rejectingFetch),
      ).rejects.toThrow();
    }
  });
});

describe("macOS sandbox and closed environment", () => {
  it("uses the literal deny-by-default loopback-only sandbox profile", () => {
    expect(SANDBOX_PROFILE).toBe(
      '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))',
    );
    const launch = makeSandboxedLaunch(
      "/artifact/SkyTwin",
      "/private/profile",
      "nonce",
    );
    expect(launch.command).toBe("/usr/bin/sandbox-exec");
    expect(launch.args).toEqual([
      "-p",
      SANDBOX_PROFILE,
      "/artifact/SkyTwin",
      "--user-data-dir=/private/profile/electron",
    ]);
  });

  it("allows only an exact closed child environment and strips inherited credentials", () => {
    const env = makeClosedEnvironment("/private/profile", "nonce");
    expect(Object.keys(env).sort()).toEqual(
      [
        "APPDATA",
        "HOME",
        "LOCALAPPDATA",
        "NODE_ENV",
        "NO_PROXY",
        "PATH",
        "SKYTWIN_DEV_AUTH_BYPASS",
        "SKYTWIN_RELEASE_EVIDENCE_NONCE",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "no_proxy",
      ].sort(),
    );
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "OLLAMA_BASE_URL",
      "IRONCLAW_URL",
      "OPENCLAW_URL",
      "FEDERATION_URL",
      "SENTRY_DSN",
      "CRASH_REPORT_URL",
      "UPDATE_URL",
    ])
      expect(env[name]).toBeUndefined();
    expect(env.SKYTWIN_DEV_AUTH_BYPASS).toBe("false");
  });

  it("rejects false loopback, external allowance, and missing child inheritance", () => {
    const valid = {
      schemaVersion: 1,
      parentLoopback: "pass",
      parentExternalError: "EPERM",
      childLoopback: "pass",
      childExternalError: "EPERM",
    };
    expect(validateSandboxSelfTestResult(valid)).toBe(true);
    for (const mutate of [
      (value) => {
        value.parentLoopback = "ECONNREFUSED";
      },
      (value) => {
        value.parentExternalError = "CONNECTED";
      },
      (value) => {
        value.childLoopback = "EPERM";
      },
      (value) => {
        value.childExternalError = "CONNECTED";
      },
      (value) => {
        value.unexpected = true;
      },
    ]) {
      const changed = structuredClone(valid);
      mutate(changed);
      expect(() => validateSandboxSelfTestResult(changed)).toThrow();
    }
  });

  it.runIf(process.platform === "darwin")(
    "proves real parent and spawned-child sandbox inheritance",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "network-sandbox-test-"));
      roots.push(root);
      await expect(selfTestSandbox(root)).resolves.toMatchObject({
        parentLoopbackResult: "pass",
        parentExternalError: "EPERM",
        childLoopbackResult: "pass",
        childExternalError: "EPERM",
        inheritanceResult: "pass",
      });
    },
  );

  it("bounds native output and timeout and kills the command", async () => {
    await expect(
      boundedSpawn(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(10000))"],
        { maxBytes: 100 },
      ),
    ).rejects.toThrow(/output exceeded/);
    const started = Date.now();
    await expect(
      boundedSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("owned process-tree socket inventory", () => {
  const ps = [
    "  10 1 Mon Sep 14 07:29:39 2026 /usr/bin/sandbox-exec -p profile SkyTwin",
    "  11 10 Mon Sep 14 07:29:40 2026 /artifact/SkyTwin",
    "  12 11 Mon Sep 14 07:29:41 2026 /artifact/cockroach",
    "  99 1 Mon Sep 14 07:29:42 2026 /usr/bin/foreign",
  ].join("\n");

  it("parses strict process inventories and derives only descendants", () => {
    const records = parseProcessTable(ps);
    expect([...ownedProcessTree(records, 10)]).toEqual([10, 11, 12]);
    expect(() => parseProcessTable(`${ps}\nmalformed`)).toThrow(/malformed/);
    expect(() => ownedProcessTree(records, 98)).toThrow(/exited/);
    const cycle = parseProcessTable(
      [
        "  10 11 Mon Sep 14 07:29:39 2026 root",
        "  11 10 Mon Sep 14 07:29:40 2026 child",
      ].join("\n"),
    );
    expect(() => ownedProcessTree(cycle, 10)).toThrow(/cycle/);
  });

  it("accepts only complete literal-loopback TCP records", () => {
    const output = [
      "p11",
      "cSkyTwin",
      "f10",
      "PTCP",
      "n127.0.0.1:3100",
      "TST=LISTEN",
      "TQR=0",
      "TQS=0",
      "f11",
      "PTCP",
      "n127.0.0.1:50000->127.0.0.1:3100",
      "TST=ESTABLISHED",
      "TQR=0",
      "TQS=0",
    ].join("\n");
    expect(parseLsofSockets(output)).toEqual([
      {
        pid: 11,
        command: "SkyTwin",
        fd: "10",
        protocol: "TCP",
        name: "127.0.0.1:3100",
        state: "LISTEN",
      },
      {
        pid: 11,
        command: "SkyTwin",
        fd: "11",
        protocol: "TCP",
        name: "127.0.0.1:50000->127.0.0.1:3100",
        state: "ESTABLISHED",
      },
    ]);
    for (const malformed of [
      "p11\ncSkyTwin\nf10\nPTCP",
      "p11\ncSkyTwin\nf10\nPRAW\nn127.0.0.1:3100",
      "p11\ncSkyTwin\nf10\nPTCP\nn127.0.0.1:3100\nXbad",
      "cSkyTwin\nf10\nPTCP\nn127.0.0.1:3100",
      `${output}\np11\ncSkyTwin\nf10\nPTCP\nn127.0.0.1:3100\nn127.0.0.1:3200`,
    ])
      expect(() => parseLsofSockets(malformed)).toThrow();
  });

  it("rejects wildcard, IPv6, external, multicast/UDP, and foreign managed sockets", () => {
    const before = parseProcessTable(ps);
    const owned = ownedProcessTree(before, 10);
    const after = parseProcessTable(ps);
    const base = {
      pid: 11,
      command: "SkyTwin",
      fd: "10",
      protocol: "TCP",
      name: "127.0.0.1:3100",
      state: "LISTEN",
    };
    expect(
      validateSocketInventory(
        [
          base,
          {
            ...base,
            fd: "11",
            name: "127.0.0.1:54321->127.0.0.1:3100",
          },
          {
            ...base,
            pid: 99,
            command: "foreign",
            name: "192.0.2.2:54321->192.0.2.3:3100",
          },
        ],
        owned,
        before,
        after,
      ),
    ).toEqual({ ownedSocketCount: 2, loopbackPorts: [3100] });
    for (const mutation of [
      { name: "*:3100" },
      { name: "[::1]:3100" },
      { name: "192.0.2.1:443" },
      { name: "224.0.0.251:5353", protocol: "UDP" },
      { name: "127.0.0.1:5353", protocol: "UDP" },
      { pid: 99, command: "foreign", name: "127.0.0.1:3100" },
    ])
      expect(() =>
        validateSocketInventory(
          [{ ...base, ...mutation }],
          owned,
          before,
          after,
        ),
      ).toThrow();
  });

  it("rejects descendant exit, PID reuse, and stale socket samples", () => {
    const before = parseProcessTable(ps);
    const owned = ownedProcessTree(before, 10);
    const socket = {
      pid: 11,
      command: "SkyTwin",
      fd: "10",
      protocol: "TCP",
      name: "127.0.0.1:3100",
      state: "LISTEN",
    };
    const exited = parseProcessTable(
      ps
        .split("\n")
        .filter((line) => !line.startsWith("  11 "))
        .join("\n"),
    );
    expect(() =>
      validateSocketInventory([socket], owned, before, exited),
    ).toThrow(/exited or was reused/);
    const reused = parseProcessTable(
      ps.replace(
        "Mon Sep 14 07:29:40 2026 /artifact/SkyTwin",
        "Tue Sep 15 07:29:40 2026 /artifact/SkyTwin",
      ),
    );
    expect(() =>
      validateSocketInventory([socket], owned, before, reused),
    ).toThrow(/reused/);
    const changed = parseProcessTable(
      ps.replace("/artifact/SkyTwin\n", "/tmp/substitute\n"),
    );
    expect(() =>
      validateSocketInventory([socket], owned, before, changed),
    ).toThrow(/reused/);
  });

  it("captures only a stable owned sample and rejects native inventory failure", () => {
    const records = parseProcessTable(ps);
    const output =
      "p11\ncSkyTwin\nf10\nPTCP\nn127.0.0.1:3100\nTST=LISTEN\nTQR=0\nTQS=0\n";
    expect(
      captureOwnedSocketSample(10, {
        processInventory: () => records,
        socketRunner: () => ({ status: 0, stdout: output, stderr: "" }),
      }),
    ).toEqual({ processCount: 3, ownedSocketCount: 1, loopbackPorts: [3100] });
    expect(() =>
      captureOwnedSocketSample(10, {
        processInventory: () => records,
        socketRunner: () => ({
          status: 1,
          stdout: "",
          stderr: "permission denied",
        }),
      }),
    ).toThrow(/failed closed/);
  });

  it("samples throughout work and fails closed on any intermediate observation", async () => {
    let count = 0;
    const capture = () => ({
      processCount: 2,
      ownedSocketCount: 4,
      loopbackPorts: [26257, 26258, 3100, 3200],
      n: count++,
    });
    await expect(
      runContinuousSampler(
        10,
        async () => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
          return "done";
        },
        {
          capture,
          delay: async () =>
            new Promise((resolveDelay) => setTimeout(resolveDelay, 0)),
        },
      ),
    ).resolves.toMatchObject({ result: "done" });
    let attempt = 0;
    await expect(
      runContinuousSampler(
        10,
        async () => {
          while (attempt < 2)
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
        },
        {
          capture: () => {
            attempt += 1;
            if (attempt === 2) throw new Error("external socket");
            return { processCount: 2, ownedSocketCount: 0, loopbackPorts: [] };
          },
          delay: async () =>
            new Promise((resolveDelay) => setTimeout(resolveDelay, 0)),
        },
      ),
    ).rejects.toThrow(/external socket/);
  });

  it("requires two consecutive clean post-shutdown samples", async () => {
    const observations = [true, false, true, true];
    let index = 0;
    let tick = 0;
    await expect(
      waitForTwoCleanSamples({
        deadline: 10,
        now: () => tick++,
        delay: async () => {},
        probe: async () => observations[index++],
      }),
    ).resolves.toEqual({ clean: true, sampleCount: 4 });
    tick = 0;
    let race = 0;
    await expect(
      waitForTwoCleanSamples({
        deadline: 2,
        now: () => tick++,
        delay: async () => {},
        probe: async () => [true, false][race++],
      }),
    ).resolves.toEqual({ clean: false, sampleCount: 2 });
  });

  it("rejects nonce substitution and unavailable sample readiness", () => {
    expect(
      validateOwnedReadiness(
        { instanceNonce: "nonce", available: true },
        "nonce",
      ),
    ).toBe(true);
    expect(() =>
      validateOwnedReadiness(
        { instanceNonce: "other", available: true },
        "nonce",
      ),
    ).toThrow(/nonce/);
    expect(() =>
      validateOwnedReadiness(
        { instanceNonce: "nonce", available: false },
        "nonce",
      ),
    ).toThrow(/unavailable/);
  });

  it("detects a real foreign listener without stopping it", async () => {
    const server = createServer();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    try {
      const address = server.address();
      expect(address && typeof address === "object").toBe(true);
      expect(await targetIsUnused(address.port)).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

describe("network report publication applicability", () => {
  it("accepts the complete content- and credential-free observation", () => {
    expect(
      verifyMachineEvidenceApplicability(
        "network.explicit-boundaries",
        report(),
        [],
      ),
    ).toEqual([]);
  });

  it("rejects every security-significant field mutation", () => {
    const mutations = [
      (value) => {
        value.runnerPlatform = "darwin-x64";
      },
      (value) => {
        value.runAttempt = 1;
      },
      (value) => {
        value.runAttemptStartedAt = "bad";
      },
      (value) => {
        value.releaseArtifactAttemptBindingResult = "unbound";
      },
      (value) => {
        value.releaseArtifactCreatedAt = "2026-09-15T02:00:00Z";
      },
      (value) => {
        value.desktopProducerJobId = 0;
      },
      (value) => {
        value.desktopProducerJobName = "other";
      },
      (value) => {
        value.desktopProducerJobRunAttempt = 1;
      },
      (value) => {
        value.desktopProducerJobConclusion = "failure";
      },
      (value) => {
        value.desktopUploadStartedAt = "2026-09-15T01:06:00Z";
      },
      (value) => {
        value.verifierJobId = 0;
      },
      (value) => {
        value.verifierJobName = "other";
      },
      (value) => {
        value.verifierJobRunAttempt = 1;
      },
      (value) => {
        value.verifierJobStatus = "completed";
      },
      (value) => {
        value.executedBinary.sha256 = "short";
      },
      (value) => {
        value.executedBinary.derivationMethod = "direct";
      },
      (value) => {
        value.sandboxObservation.profileSha256 = "short";
      },
      (value) => {
        value.sandboxObservation.parentLoopbackResult = "fail";
      },
      (value) => {
        value.sandboxObservation.parentExternalError = "CONNECTED";
      },
      (value) => {
        value.sandboxObservation.childLoopbackResult = "fail";
      },
      (value) => {
        value.sandboxObservation.childExternalError = "CONNECTED";
      },
      (value) => {
        value.sandboxObservation.inheritanceResult = "skip";
      },
      (value) => {
        value.networkObservation.sandboxedLaunchResult = "skip";
      },
      (value) => {
        value.networkObservation.ownedNonceResult = "fail";
      },
      (value) => {
        value.networkObservation.apiReadinessResult = "fail";
      },
      (value) => {
        value.networkObservation.dashboardReadinessResult = "fail";
      },
      (value) => {
        value.networkObservation.accountFreeRead.method = "POST";
      },
      (value) => {
        value.networkObservation.sampleCount = 3;
      },
      (value) => {
        value.networkObservation.maxOwnedProcessCount = 1;
      },
      (value) => {
        value.networkObservation.maxOwnedSocketCount = 3;
      },
      (value) => {
        value.networkObservation.observedLoopbackPorts = [3100];
      },
      (value) => {
        value.networkObservation.addressPolicy = "any-local";
      },
      (value) => {
        value.networkObservation.foreignManagedSocketCount = 1;
      },
      (value) => {
        value.networkObservation.wildcardSocketCount = 1;
      },
      (value) => {
        value.networkObservation.externalSocketCount = 1;
      },
      (value) => {
        value.networkObservation.udpOrMulticastSocketCount = 1;
      },
      (value) => {
        value.networkObservation.gracefulShutdownResult = "fail";
      },
      (value) => {
        value.networkObservation.forcedShutdown = true;
      },
      (value) => {
        value.networkObservation.postShutdownConsecutiveCleanSamples = 1;
      },
      (value) => {
        value.evidencePrivacy.contentCaptured = true;
      },
      (value) => {
        value.evidencePrivacy.credentialsCaptured = true;
      },
      (value) => {
        value.evidencePrivacy.userPathsCaptured = true;
      },
      (value) => {
        value.evidencePrivacy.endpointHostnamesCaptured = true;
      },
      (value) => {
        value.networkObservation.unexpected = true;
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(report());
      mutate(changed);
      expect(
        verifyMachineEvidenceApplicability(
          "network.explicit-boundaries",
          changed,
          [],
        ),
      ).toHaveLength(1);
    }
  });

  it("emits no report when canonical validation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "network-no-report-"));
    roots.push(root);
    mkdirSync(join(root, ".release-evidence", "reports"), { recursive: true });
    await expect(
      runCanonicalVerifier(["--platform", "linux"], { root }),
    ).rejects.toThrow();
    expect(
      existsSync(
        join(
          root,
          ".release-evidence",
          "reports",
          "network.explicit-boundaries.json",
        ),
      ),
    ).toBe(false);
  });
});
