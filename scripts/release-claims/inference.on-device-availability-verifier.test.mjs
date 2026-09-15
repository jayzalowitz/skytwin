import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAllowlistedVerificationCommand,
  verifyMachineEvidenceApplicability,
} from "./check-release-claims.mjs";
import {
  downloadPinnedFile,
  extractPackagedApiArchive,
  inspectPackagedProbe,
  inspectPinnedRuntimeBinary,
  parseArtifactBindings,
  parseCanonicalArgs,
  parseProbeResult,
  PINNED_LLAMA_RUNTIME,
  observePinnedRuntimeRelease,
  preflightPackagedApiArchive,
  runBoundedCommand,
  runBoundedProcess,
  validateArchiveInventory,
  validateExtractedTree,
  verifySandboxNetworkDenial,
} from "./verifiers/inference.on-device-availability.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix = "on-device-verifier-test-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeTarOctal(header, offset, width, value) {
  const encoded = `${value.toString(8).padStart(width - 1, "0")}\0`;
  header.write(encoded, offset, width, "ascii");
}

function tarHeader({
  name,
  data = Buffer.alloc(0),
  size,
  type = "0",
  link = "",
}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size ?? data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeTarGz(path, members) {
  const chunks = [];
  for (const member of members) {
    const data = Buffer.from(member.data ?? "");
    chunks.push(tarHeader({ ...member, data }), data);
    const remainder = data.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(path, gzipSync(Buffer.concat(chunks)));
}

function validPackagedMembers() {
  return [
    { name: "api", type: "5" },
    { name: "api/dist", type: "5" },
    { name: "api/dist/bin", type: "5" },
    {
      name: "api/dist/bin/verify-on-device-inference.js",
      data: "probe",
    },
    { name: "worker", type: "5" },
    { name: "worker/index.js", data: "worker" },
    { name: "web", type: "5" },
    { name: "web/index.js", data: "web" },
  ];
}

function probeResult(nonce = "a".repeat(64)) {
  return {
    schemaVersion: 1,
    generatedBy: "packaged-on-device-inference-probe",
    result: "pass",
    provider: "embedded",
    modelName: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    reasoningMode: "on_device",
    executionLocation: "on_device",
    networkScope: "none",
    confidentiality: "device_local",
    pricingKind: "zero",
    responseBytes: 12,
    responseSha256: "b".repeat(64),
    nonceSha256: digest(nonce),
  };
}

function report() {
  return {
    platform: "macos",
    runnerPlatform: "darwin-arm64",
    packagedApplication: {
      name: "SkyTwin",
      sizeBytes: 1_000,
      sha256: "1".repeat(64),
      device: 10,
      inode: 20,
      identityResult: "pass",
      derivationMethod: "zip-ditto",
      derivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
    },
    packagedProbe: {
      path: "api/dist/bin/verify-on-device-inference.js",
      sizeBytes: 500,
      sha256: "2".repeat(64),
      identityResult: "pass",
    },
    runtime: {
      repository: "ggml-org/llama.cpp",
      tag: "b10985",
      commit: "7609846557c50f9d984719a9e1e8c5f3d02f807b",
      releaseId: 389_209_275,
      assetId: 565_855_246,
      archiveName: "llama-b10985-bin-macos-arm64.tar.gz",
      source:
        "https://github.com/ggml-org/llama.cpp/releases/download/b10985/llama-b10985-bin-macos-arm64.tar.gz",
      archiveExactBytes: 11_150_340,
      archiveSha256:
        "af0c49bbc35add2cdfcdfd9b6fd1fa6d30a9087d4950561fbd6ebda37bd4fe2d",
      binaryName: "llama-completion",
      binaryExactBytes: 33_472,
      binarySha256:
        "3d3d8fd9265fe429b44b49244deb70d6712c93e31d9085b0cb660428fa4f07ab",
      build: 10_985,
      versionCommit: "760984655",
      versionResult: "pass",
      identityResult: "pass",
      releaseMetadataResult: "pass",
      tagCommitResult: "pass",
    },
    model: {
      id: "qwen2.5-1.5b-instruct-q4-k-m",
      name: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      repository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
      revision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
      exactBytes: 1_117_320_736,
      sha256:
        "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
      digestResult: "pass",
      identityResult: "pass",
    },
    confinement: {
      method: "macos-sandbox-exec-deny-network",
      profile: "deny network*",
      selfTestResult: "pass",
      externalNetworkDenied: true,
      loopbackNetworkDenied: true,
      childEnvironment: "closed-allowlist",
    },
    inference: { ...probeResult(), latencyMs: 1_234 },
    hardwareObservation: {
      osRelease: "25.6.0",
      architecture: "arm64",
      totalMemoryBytes: 14 * 1024 ** 3,
    },
  };
}

describe("on-device verifier canonical inputs", () => {
  it("accepts only the canonical macOS invocation and focused test command", () => {
    const output =
      ".release-evidence/reports/inference.on-device-availability.json";
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

    const command =
      "pnpm exec vitest run scripts/release-claims/inference.on-device-availability-verifier.test.mjs";
    expect(isAllowlistedVerificationCommand(command)).toBe(true);
    expect(
      isAllowlistedVerificationCommand(`${command} --passWithNoTests`),
    ).toBe(false);
    expect(isAllowlistedVerificationCommand(`${command}; echo bypass`)).toBe(
      false,
    );
  });

  it("requires the exact unique macOS release-artifact bindings", () => {
    expect(
      parseArtifactBindings(
        "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=13",
        /^\d+$/u,
        "ids",
      ).get("SkyTwin-macOS-zip"),
    ).toBe("13");
    for (const value of [
      "SkyTwin-macOS-zip=13",
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=13,SkyTwin-macOS-zip=14",
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=bad",
      "SkyTwin-macOS-dmg=12,other=13",
      "SkyTwin-macOS-dmg=12,SkyTwin-macOS-zip=13=14",
    ])
      expect(() => parseArtifactBindings(value, /^\d+$/u, "ids")).toThrow();
  });

  it("pins a release asset whose binary identity is independently fixed", () => {
    expect(PINNED_LLAMA_RUNTIME).toMatchObject({
      repository: "ggml-org/llama.cpp",
      tag: "b10985",
      commit: "7609846557c50f9d984719a9e1e8c5f3d02f807b",
      build: 10_985,
      exactBytes: 11_150_340,
      binaryExactBytes: 33_472,
    });
    expect(PINNED_LLAMA_RUNTIME.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(PINNED_LLAMA_RUNTIME.binarySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds runtime release and tag metadata to the pinned asset and commit", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes("/releases/tags/"))
        return new Response(
          JSON.stringify({
            id: PINNED_LLAMA_RUNTIME.releaseId,
            tag_name: PINNED_LLAMA_RUNTIME.tag,
            target_commitish: PINNED_LLAMA_RUNTIME.commit,
            assets: [
              {
                id: PINNED_LLAMA_RUNTIME.assetId,
                name: PINNED_LLAMA_RUNTIME.archiveName,
                size: PINNED_LLAMA_RUNTIME.exactBytes,
                digest: `sha256:${PINNED_LLAMA_RUNTIME.sha256}`,
                browser_download_url: PINNED_LLAMA_RUNTIME.source,
              },
            ],
          }),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          ref: `refs/tags/${PINNED_LLAMA_RUNTIME.tag}`,
          object: { type: "commit", sha: PINNED_LLAMA_RUNTIME.commit },
        }),
        { status: 200 },
      );
    };
    await expect(
      observePinnedRuntimeRelease("token", fetchImpl),
    ).resolves.toEqual({
      releaseMetadataResult: "pass",
      tagCommitResult: "pass",
    });
    expect(calls).toHaveLength(2);

    await expect(
      observePinnedRuntimeRelease("token", async (url) => {
        const response = await fetchImpl(url);
        if (String(url).includes("/releases/tags/")) {
          const value = await response.json();
          value.assets[0].digest = `sha256:${"0".repeat(64)}`;
          return new Response(JSON.stringify(value), { status: 200 });
        }
        return response;
      }),
    ).rejects.toThrow(/metadata/);
  });
});

describe("packaged probe and archive boundaries", () => {
  it("rejects traversal, control characters, duplicate members, and extra roots", () => {
    expect(
      validateArchiveInventory("api/\napi/dist/\napi/dist/index.js\n", "api"),
    ).toBeInstanceOf(Set);
    for (const inventory of [
      "../escape\n",
      "/absolute\n",
      "api/good\napi/good\n",
      "worker/index.js\n",
      "api/control\u0001name\n",
    ])
      expect(() => validateArchiveInventory(inventory, "api")).toThrow();
  });

  it("rejects extracted symlinks that leave the private root", () => {
    const root = makeRoot();
    writeFileSync(join(root, "inside"), "ok");
    expect(() => validateExtractedTree(root)).not.toThrow();
    symlinkSync("/etc/hosts", join(root, "outside"));
    expect(() => validateExtractedTree(root)).toThrow(/escapes/);
  });

  it("preflights and extracts only a bounded regular packaged API tree", () => {
    const root = makeRoot();
    const archive = join(root, "apps.tar.gz");
    const target = join(root, "extracted");
    mkdirSync(target);
    writeTarGz(archive, validPackagedMembers());

    expect(preflightPackagedApiArchive(archive)).toEqual({
      memberCount: 8,
      regularFileCount: 3,
      directoryCount: 5,
      expandedBytes: 14,
      rootCount: 3,
    });
    expect(extractPackagedApiArchive(archive, target)).toMatchObject({
      sizeBytes: 5,
      sha256: digest("probe"),
    });
    expect(readdirSync(target)).toEqual(["api"]);
  });

  it.each([
    ["symbolic link", [{ name: "api/link", type: "2", link: "dist/bin" }]],
    [
      "hard link",
      [
        {
          name: "api/hard-link",
          type: "1",
          link: "api/dist/bin/verify-on-device-inference.js",
        },
      ],
    ],
    ["special file", [{ name: "api/fifo", type: "6" }]],
    [
      "per-file expansion",
      [{ name: "api/oversize.bin", size: 257 * 1024 * 1024 }],
    ],
    [
      "total expansion",
      [{ name: "api/aggregate.bin", size: 200 * 1024 * 1024 }],
    ],
    ["duplicate path", [{ name: "worker/index.js", data: "again" }]],
    ["traversal path", [{ name: "api/../escape", data: "escape" }]],
    ["unexpected root", [{ name: "other/file", data: "other" }]],
    [
      "case-colliding path",
      [
        { name: "web/Case.js", data: "one" },
        { name: "web/case.js", data: "two" },
      ],
    ],
    [
      "compression ratio",
      [{ name: "web/zeros.bin", data: Buffer.alloc(1024 * 1024) }],
    ],
  ])("rejects a malicious %s before extraction", (_description, mutation) => {
    const root = makeRoot();
    const archive = join(root, "apps.tar.gz");
    const target = join(root, "extracted");
    mkdirSync(target);
    writeTarGz(archive, [...validPackagedMembers(), ...mutation]);

    expect(() => extractPackagedApiArchive(archive, target)).toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it.each([
    [
      "regular ancestor followed by its child",
      [
        ...validPackagedMembers(),
        { name: "web/regular-parent", data: "parent" },
        { name: "web/regular-parent/child.js", data: "child" },
      ],
    ],
    [
      "child followed by its regular ancestor",
      [
        ...validPackagedMembers(),
        { name: "web/late-parent/child.js", data: "child" },
        { name: "web/late-parent", data: "parent" },
      ],
    ],
    [
      "regular application root with descendants",
      validPackagedMembers().map((member) =>
        member.name === "api"
          ? { name: "api", data: "not a directory" }
          : member,
      ),
    ],
    [
      "casefolded implicit parent conflict",
      [
        ...validPackagedMembers(),
        { name: "web/Parent/one.js", data: "one" },
        { name: "web/parent/two.js", data: "two" },
      ],
    ],
    [
      "regular file with a directory trailing slash",
      [
        ...validPackagedMembers(),
        { name: "web/not-a-directory/", data: "file" },
      ],
    ],
  ])("rejects a topology-confused %s before extraction", (_description, members) => {
    const root = makeRoot();
    const archive = join(root, "apps.tar.gz");
    const target = join(root, "extracted");
    mkdirSync(target);
    writeTarGz(archive, members);

    expect(() => extractPackagedApiArchive(archive, target)).toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it("rejects an in-root symlink substituted at the canonical probe path", () => {
    const root = makeRoot();
    const probe = join(root, "api/dist/bin/verify-on-device-inference.js");
    mkdirSync(join(root, "api/dist/bin"), { recursive: true });
    writeFileSync(join(root, "real-probe.js"), "probe");
    symlinkSync("../../../real-probe.js", probe);

    expect(() => inspectPackagedProbe(root)).toThrow(/symlink component/);
  });

  it("rejects an in-root symlink substituted at the pinned runtime path", () => {
    const root = makeRoot();
    writeFileSync(join(root, "real-runtime"), "runtime");
    symlinkSync("real-runtime", join(root, PINNED_LLAMA_RUNTIME.binaryName));

    expect(() => inspectPinnedRuntimeBinary(root)).toThrow(/symlink component/);
  });

  it("accepts one exact content-length and digest-bound download", async () => {
    const root = makeRoot();
    const bytes = Buffer.from("pinned bytes");
    const seen = [];
    const result = await downloadPinnedFile(
      {
        name: "fixture.bin",
        source: "https://source.example/fixture.bin",
        sourceHost: "source.example",
        allowedRedirectHosts: ["cdn.example"],
        exactBytes: bytes.length,
        sha256: digest(bytes),
        maxRedirects: 1,
      },
      root,
      async (url) => {
        seen.push(String(url));
        if (seen.length === 1)
          return new Response(null, {
            status: 302,
            headers: { Location: "https://cdn.example/blob?ephemeral=secret" },
          });
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Length": String(bytes.length) },
        });
      },
    );
    expect(result).toMatchObject({
      name: "fixture.bin",
      sizeBytes: bytes.length,
      sha256: digest(bytes),
    });
    expect(seen).toHaveLength(2);
  });

  it("fails closed on redirect, length, digest, and pre-existing-file mutations", async () => {
    const spec = {
      name: "fixture.bin",
      source: "https://source.example/fixture.bin",
      sourceHost: "source.example",
      allowedRedirectHosts: ["cdn.example"],
      exactBytes: 4,
      sha256: digest("good"),
      maxRedirects: 1,
    };
    await expect(
      downloadPinnedFile(
        spec,
        makeRoot(),
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example/blob" },
          }),
      ),
    ).rejects.toThrow(/host boundary/);
    await expect(
      downloadPinnedFile(
        spec,
        makeRoot(),
        async () =>
          new Response("good", {
            status: 200,
            headers: { "Content-Length": "5" },
          }),
      ),
    ).rejects.toThrow(/Content-Length/);
    await expect(
      downloadPinnedFile(
        spec,
        makeRoot(),
        async () =>
          new Response("evil", {
            status: 200,
            headers: { "Content-Length": "4" },
          }),
      ),
    ).rejects.toThrow(/digest/);
    const occupied = makeRoot();
    writeFileSync(join(occupied, spec.name), "mine");
    await expect(
      downloadPinnedFile(
        spec,
        occupied,
        async () =>
          new Response("good", {
            status: 200,
            headers: { "Content-Length": "4" },
          }),
      ),
    ).rejects.toThrow();
  });

  it("accepts only an exact content-free packaged inference result", () => {
    const nonce = "a".repeat(64);
    const value = probeResult(nonce);
    expect(
      parseProbeResult(`${JSON.stringify(value)}\n`, {
        modelName: value.modelName,
        nonce,
      }),
    ).toEqual(value);
    for (const mutate of [
      (copy) => {
        copy.provider = "openai";
      },
      (copy) => {
        copy.networkScope = "loopback";
      },
      (copy) => {
        copy.responseBytes = 0;
      },
      (copy) => {
        copy.nonceSha256 = "c".repeat(64);
      },
      (copy) => {
        copy.content = "leak";
      },
    ]) {
      const copy = structuredClone(value);
      mutate(copy);
      expect(() =>
        parseProbeResult(`${JSON.stringify(copy)}\n`, {
          modelName: value.modelName,
          nonce,
        }),
      ).toThrow();
    }
  });
});

describe("bounded native execution", () => {
  it("fails a timed-out command instead of hanging", () => {
    const timedOut = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
    });
    expect(() =>
      runBoundedCommand("/probe", [], {
        timeoutMs: 123,
        runner: (_command, _args, options) => ({
          error: options.timeout === 123 ? timedOut : undefined,
          signal: "SIGKILL",
          status: null,
          stdout: "",
          stderr: "",
        }),
      }),
    ).toThrow(/ETIMEDOUT/);
  });

  it("kills an owned process group at its deadline", async () => {
    const started = Date.now();
    await expect(
      runBoundedProcess(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: tmpdir(),
          env: { PATH: "/usr/bin:/bin" },
          timeoutMs: 50,
          maxOutputBytes: 64 * 1024,
        },
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("places the loopback and external probes in a sandbox-inheriting child", async () => {
    let leaderExpression = "";
    await expect(
      verifySandboxNetworkDenial(process.execPath, {
        run: async (command, args) => {
          expect(command).toBe("/usr/bin/sandbox-exec");
          leaderExpression = args[4];
          return { stdout: "", stderr: "" };
        },
      }),
    ).resolves.toBe(true);
    expect(leaderExpression).toContain("spawnSync(process.execPath");
    expect(leaderExpression).toContain("127.0.0.1");
    expect(leaderExpression).toContain("1.1.1.1");
    expect(leaderExpression).toContain("child-network-denied");
  });

  it.runIf(process.platform === "darwin")(
    "proves the macOS sandboxed child rejects loopback and external connections",
    async () => {
      await expect(verifySandboxNetworkDenial(realpathNode())).resolves.toBe(
        true,
      );
    },
  );
});

function realpathNode() {
  return process.execPath;
}

describe("on-device report applicability", () => {
  it("requires the complete structured observation", () => {
    expect(
      verifyMachineEvidenceApplicability(
        "inference.on-device-availability",
        report(),
        [],
      ),
    ).toEqual([]);
  });

  it("rejects every security-significant observation mutation", () => {
    const mutations = [
      (value) => {
        value.runnerPlatform = "darwin-x64";
      },
      (value) => {
        value.packagedApplication.derivationMethod = "direct";
      },
      (value) => {
        value.packagedProbe.path = "source/probe.js";
      },
      (value) => {
        value.runtime.commit = "0".repeat(40);
      },
      (value) => {
        value.runtime.archiveSha256 = "0".repeat(64);
      },
      (value) => {
        value.runtime.binarySha256 = "0".repeat(64);
      },
      (value) => {
        value.model.revision = "0".repeat(40);
      },
      (value) => {
        value.model.sha256 = "0".repeat(64);
      },
      (value) => {
        value.confinement.externalNetworkDenied = false;
      },
      (value) => {
        value.confinement.loopbackNetworkDenied = false;
      },
      (value) => {
        value.inference.provider = "ollama";
      },
      (value) => {
        value.inference.networkScope = "loopback";
      },
      (value) => {
        value.inference.responseBytes = 0;
      },
      (value) => {
        value.inference.latencyMs = 180_001;
      },
      (value) => {
        value.hardwareObservation.architecture = "x64";
      },
      (value) => {
        value.inference.unexpected = true;
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(report());
      mutate(value);
      expect(
        verifyMachineEvidenceApplicability(
          "inference.on-device-availability",
          value,
          [],
        ),
      ).toHaveLength(1);
    }
  });
});
