import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAllowlistedVerificationCommand,
  verifyMachineEvidenceApplicability,
} from "./check-release-claims.mjs";
import {
  assertDescendsFrom,
  inspectUserDataStore,
  lsofReportsNoListeners,
  makeStorageLaunch,
  parseArtifactBindings,
  parseCanonicalArgs,
  parseLsofListenerInventory,
  parseLsofListeners,
  parseMarkerQueryOutput,
  parsePsRecord,
  runBoundedCommand,
  targetIsUnused,
  validateCockroachCommand,
  waitForReleasedPorts,
} from "./verifiers/storage.desktop-crdb.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function storageReport() {
  return {
    platform: "macos",
    runnerPlatform: "darwin-arm64",
    executedBinary: {
      name: "SkyTwin",
      sizeBytes: 1_000,
      sha256: "a".repeat(64),
      device: 10,
      inode: 20,
      identityResult: "pass",
      derivationMethod: "zip-ditto",
      derivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
    },
    databaseBinary: {
      name: "cockroach",
      sizeBytes: 2_000,
      sha256: "b".repeat(64),
      identityResult: "pass",
      derivationPath:
        "SkyTwin.app/Contents/Resources/cockroach/darwin-arm64/cockroach",
    },
    storageObservation: {
      userDataRelativePath: "electron",
      storeRelativePath: "electron/crdb-data",
      sqlListener: { host: "127.0.0.1", port: 26257 },
      httpListener: { host: "127.0.0.1", port: 26258 },
      processOwnership: "descendant",
      launchCount: 2,
      markerWriteResult: "pass",
      markerReadAfterRestartResult: "pass",
      markerSha256: "c".repeat(64),
      sameStoreIdentity: true,
      storeNonEmpty: true,
      unexpectedStoreCount: 0,
      gracefulShutdownCount: 2,
      listenersReleased: true,
    },
  };
}

describe("storage desktop verifier inputs", () => {
  it("accepts only the canonical macOS invocation", () => {
    const output = ".release-evidence/reports/storage.desktop-crdb.json";
    expect(
      parseCanonicalArgs(["--platform", "macos", "--output", output]),
    ).toEqual({
      platform: "macos",
      output,
    });
    for (const argv of [
      ["--platform", "linux", "--output", output],
      ["--output", output, "--platform", "macos"],
      ["--platform", "macos", "--output", "../escape.json"],
      ["--platform", "macos", "--output", output, "--extra"],
    ])
      expect(() => parseCanonicalArgs(argv)).toThrow(/exactly/);
  });

  it("allowlists only the exact focused ledger test command", () => {
    const command =
      "pnpm exec vitest run scripts/release-claims/storage.desktop-crdb-verifier.test.mjs";
    expect(isAllowlistedVerificationCommand(command)).toBe(true);
    expect(
      isAllowlistedVerificationCommand(`${command} --passWithNoTests`),
    ).toBe(false);
    expect(isAllowlistedVerificationCommand(`${command}; echo bypass`)).toBe(
      false,
    );
  });

  it("requires the exact unique macOS artifact binding set", () => {
    const ids = parseArtifactBindings(
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=13",
      /^\d+$/u,
      "ids",
    );
    expect(ids.get("SkyTwin-macOS-zip")).toBe("13");
    for (const value of [
      "SkyTwin-macOS-zip=13",
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=13,SkyTwin-macOS-zip=14",
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=bad",
      "SkyTwin-macOS-dmg=12,other=13",
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=13=14",
    ])
      expect(() => parseArtifactBindings(value, /^\d+$/u, "ids")).toThrow();
  });

  it("launches with an isolated allowlisted environment", () => {
    const launch = makeStorageLaunch(
      "/artifact/SkyTwin",
      "/isolated/profile",
      "nonce",
    );
    expect(launch.args).toEqual(["--user-data-dir=/isolated/profile/electron"]);
    expect(launch.options.cwd).toBe("/isolated/profile");
    expect(launch.options.env).toMatchObject({
      HOME: "/isolated/profile",
      NODE_ENV: "production",
      SKYTWIN_DEV_AUTH_BYPASS: "false",
      SKYTWIN_RELEASE_EVIDENCE_NONCE: "nonce",
    });
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(launch.options.env[name]).toBeUndefined();
    }
  });
});

describe("storage runtime observations", () => {
  it("bounds native probes, kills timed-out children, and fails closed", () => {
    let invocation;
    const timedOut = Object.assign(new Error("probe timed out"), {
      code: "ETIMEDOUT",
    });
    expect(() =>
      runBoundedCommand("/probe", ["--check"], {
        timeoutMs: 123,
        runner: (command, args, options) => {
          invocation = { command, args, options };
          return {
            error: timedOut,
            signal: "SIGKILL",
            status: null,
            stderr: "",
            stdout: "",
          };
        },
      }),
    ).toThrow(/ETIMEDOUT/);
    expect(invocation).toMatchObject({
      command: "/probe",
      args: ["--check"],
      options: { killSignal: "SIGKILL", timeout: 123 },
    });

    const startedAt = Date.now();
    expect(() =>
      runBoundedCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        { timeoutMs: 50 },
      ),
    ).toThrow(/ETIMEDOUT/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds lsof inventory probes and preserves no-listener exit semantics", () => {
    let timeout;
    expect(
      lsofReportsNoListeners(26257, {
        timeoutMs: 321,
        runner: (_command, _args, options) => {
          timeout = options.timeout;
          return {
            error: undefined,
            signal: null,
            status: 1,
            stderr: "",
            stdout: "",
          };
        },
      }),
    ).toBe(true);
    expect(timeout).toBe(321);
    expect(() =>
      lsofReportsNoListeners(26257, {
        runner: () => ({
          error: undefined,
          signal: null,
          status: 1,
          stderr: "hung or failed",
          stdout: "",
        }),
      }),
    ).toThrow(/failed closed/);
  });

  it("requires refused connect, exclusive bind, and an empty lsof inventory", async () => {
    const bindSucceeds = async () => true;
    const noLsofListeners = async () => true;
    expect(
      await targetIsUnused(26257, {
        connectRefused: async () => false,
        bindSucceeds,
        noLsofListeners,
      }),
    ).toBe(false);
    expect(
      await targetIsUnused(26257, {
        connectRefused: async () => true,
        bindSucceeds,
        noLsofListeners,
      }),
    ).toBe(true);
    expect(
      await targetIsUnused(26257, {
        connectRefused: async () => true,
        bindSucceeds,
        noLsofListeners: async () => false,
      }),
    ).toBe(false);
    await expect(
      targetIsUnused(26257, {
        connectRefused: async () => {
          throw new Error("unexpected socket error");
        },
        bindSucceeds,
        noLsofListeners,
      }),
    ).rejects.toThrow("unexpected socket error");
  });

  it("rejects a real connectable loopback listener", async () => {
    const server = createServer();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
    });
    try {
      const address = server.address();
      expect(address && typeof address === "object").toBe(true);
      expect(
        await targetIsUnused(address.port, {
          noLsofListeners: async () => true,
        }),
      ).toBe(false);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it("retains wildcard, IPv4, and IPv6 listener inventory for fail-closed checks", () => {
    expect(
      parseLsofListenerInventory(
        "p10\ncdocker\nn*:26257\np11\ncnode\nn127.0.0.1:26257\nn[::1]:26257\n",
      ),
    ).toEqual([
      { pid: 10, command: "docker", names: ["*:26257"] },
      {
        pid: 11,
        command: "node",
        names: ["127.0.0.1:26257", "[::1]:26257"],
      },
    ]);
  });

  it("requires two consecutive clean listener-release samples", async () => {
    const observations = [true, false, true, true];
    let tick = 0;
    let probes = 0;
    await expect(
      waitForReleasedPorts({
        ports: [26257],
        deadline: 10,
        now: () => tick++,
        probe: async () => observations[probes++],
        delay: async () => {},
      }),
    ).resolves.toBe(true);
    expect(probes).toBe(4);

    tick = 0;
    await expect(
      waitForReleasedPorts({
        ports: [26257],
        deadline: 3,
        now: () => tick++,
        probe: async () => false,
        delay: async () => {},
      }),
    ).resolves.toBe(false);
  });

  it("parses one exact literal-loopback listener", () => {
    expect(
      parseLsofListeners("p123\nccockroach\nn127.0.0.1:26257\n", 26257),
    ).toEqual({
      pid: 123,
      command: "cockroach",
      names: ["127.0.0.1:26257"],
    });
    for (const output of [
      "p123\nccockroach\nn*:26257\n",
      "p123\nccockroach\nn[::1]:26257\n",
      "p123\nccockroach\nn127.0.0.1:26257\np124\nccockroach\nn127.0.0.1:26257\n",
      "p123\ncsocat\nn127.0.0.1:26257\n",
      "",
    ])
      expect(() => parseLsofListeners(output, 26257)).toThrow();
  });

  it("requires descendant ownership and rejects cycles or foreign roots", () => {
    const parents = new Map([
      [30, 20],
      [20, 10],
      [10, 1],
    ]);
    expect(assertDescendsFrom(30, 10, (pid) => parents.get(pid))).toBe(true);
    expect(() => assertDescendsFrom(30, 11, (pid) => parents.get(pid))).toThrow(
      /not a descendant/,
    );
    const cycle = new Map([
      [30, 20],
      [20, 30],
    ]);
    expect(() => assertDescendsFrom(30, 10, (pid) => cycle.get(pid))).toThrow(
      /cycle/,
    );
  });

  it("parses process records and requires exact contained CockroachDB arguments", () => {
    expect(parsePsRecord("  42 /path/cockroach start-single-node\n")).toEqual({
      parentPid: 42,
      command: "/path/cockroach start-single-node",
    });
    const expected = {
      executablePath: "/app/cockroach",
      storePath: "/private/profile/electron/crdb-data",
      runtimePath: "/private/profile/electron/crdb-runtime",
    };
    const valid = [
      "/app/cockroach start-single-node",
      "--insecure",
      "--listen-addr=127.0.0.1:26257",
      "--http-addr=127.0.0.1:26258",
      `--store=${expected.storePath}`,
      `--pid-file=${expected.runtimePath}/launch.pid`,
      `--listening-url-file=${expected.runtimePath}/launch.url`,
    ].join(" ");
    expect(validateCockroachCommand(valid, expected)).toBe(true);
    for (const mutation of [
      valid.replace("127.0.0.1:26257", "0.0.0.0:26257"),
      valid.replace(expected.storePath, "/tmp/other"),
      valid.replace(`${expected.runtimePath}/launch.pid`, "/tmp/launch.pid"),
      valid.replace("--http-addr=127.0.0.1:26258", "--http-addr=[::]:26258"),
      valid.replace("/app/cockroach", "/tmp/cockroach"),
    ])
      expect(() => validateCockroachCommand(mutation, expected)).toThrow();
  });

  it("accepts exactly one non-empty real store under user-data", () => {
    const root = mkdtempSync(join(tmpdir(), "storage-verifier-test-"));
    roots.push(root);
    const store = join(root, "electron", "crdb-data");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "CURRENT"), "manifest");
    expect(inspectUserDataStore(root)).toMatchObject({
      path: realpathSync(store),
      nonEmpty: true,
      unexpectedStoreCount: 0,
    });
    mkdirSync(join(root, "other", "crdb-data"), { recursive: true });
    expect(() => inspectUserDataStore(root)).toThrow(/2 CockroachDB stores/);
  });

  it("rejects a symlinked or empty store", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "storage-verifier-empty-"));
    roots.push(emptyRoot);
    mkdirSync(join(emptyRoot, "electron", "crdb-data"), { recursive: true });
    expect(() => inspectUserDataStore(emptyRoot)).toThrow(/no persisted files/);

    const linkRoot = mkdtempSync(join(tmpdir(), "storage-verifier-link-"));
    roots.push(linkRoot);
    const target = join(linkRoot, "target");
    mkdirSync(join(linkRoot, "electron"), { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "CURRENT"), "manifest");
    symlinkSync(target, join(linkRoot, "electron", "crdb-data"));
    expect(() => inspectUserDataStore(linkRoot)).toThrow(/real directory/);
  });

  it("accepts only the exact persisted marker response", () => {
    expect(parseMarkerQueryOutput("marker_value\nabc123\n", "abc123")).toBe(
      true,
    );
    for (const output of [
      "abc123\n",
      "marker_value\nother\n",
      "marker_value\nabc123\nextra\n",
    ]) {
      expect(() => parseMarkerQueryOutput(output, "abc123")).toThrow(
        /exact expected value/,
      );
    }
  });
});

describe("storage report applicability", () => {
  it("requires the complete structured storage observation", () => {
    expect(
      verifyMachineEvidenceApplicability(
        "storage.desktop-crdb",
        storageReport(),
        [],
      ),
    ).toEqual([]);
  });

  it("rejects every security-significant storage observation mutation", () => {
    const mutations = [
      (report) => {
        report.runnerPlatform = "darwin-x64";
      },
      (report) => {
        report.executedBinary.derivationMethod = "direct";
      },
      (report) => {
        report.databaseBinary.derivationPath = "/tmp/cockroach";
      },
      (report) => {
        report.storageObservation.userDataRelativePath = "outside";
      },
      (report) => {
        report.storageObservation.storeRelativePath = "../crdb-data";
      },
      (report) => {
        report.storageObservation.sqlListener.host = "0.0.0.0";
      },
      (report) => {
        report.storageObservation.httpListener.port = 8080;
      },
      (report) => {
        report.storageObservation.processOwnership = "preexisting";
      },
      (report) => {
        report.storageObservation.launchCount = 1;
      },
      (report) => {
        report.storageObservation.markerWriteResult = "skip";
      },
      (report) => {
        report.storageObservation.markerReadAfterRestartResult = "skip";
      },
      (report) => {
        report.storageObservation.markerSha256 = "short";
      },
      (report) => {
        report.storageObservation.sameStoreIdentity = false;
      },
      (report) => {
        report.storageObservation.storeNonEmpty = false;
      },
      (report) => {
        report.storageObservation.unexpectedStoreCount = 1;
      },
      (report) => {
        report.storageObservation.gracefulShutdownCount = 1;
      },
      (report) => {
        report.storageObservation.listenersReleased = false;
      },
      (report) => {
        report.storageObservation.unexpected = true;
      },
    ];
    for (const mutate of mutations) {
      const report = structuredClone(storageReport());
      mutate(report);
      expect(
        verifyMachineEvidenceApplicability("storage.desktop-crdb", report, []),
      ).toHaveLength(1);
    }
  });
});
