import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  assertSafeArchiveMember,
  makePackagedLaunch,
  oneExecutable,
  parseCanonicalArgs,
  parseDiscoveryDescriptor,
  probeSampleLoop,
  selectDownloadedSubject,
  stopProcessTree,
} from "./verifiers/sample.packaged-account-free.mjs";

const roots = [];

function provenanceDescriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedBy: "release-artifact-discovery",
    claimId: "sample.packaged-account-free",
    sourceCommit: "a".repeat(40),
    releaseTag: "v0.7.0-beta",
    runId: 123,
    repository: "owner/repo",
    ref: "refs/tags/v0.7.0-beta",
    releaseArtifactKind: "desktop-installer",
    releaseArtifactId: 456,
    releaseArtifactName: "SkyTwin-Linux-AppImage",
    releaseArtifactSha256: "b".repeat(64),
    subjectName: "SkyTwin.AppImage",
    subjectPath: "artifacts/SkyTwin-Linux-AppImage/SkyTwin.AppImage",
    subjectSha256: "c".repeat(64),
    subjectSizeBytes: 1024,
    subjectDevice: 10,
    subjectInode: 20,
    evidencePlatform: "linux",
    runnerPlatform: "linux-x64",
    ...overrides,
  };
}

function descriptorBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function proposal(id, status = id === "untrusted-document" ? "contained" : "pending") {
  return {
    id,
    status,
    simulationOnly: true,
    externalEffects: false,
    policy: {
      allowed: status !== "contained",
      requiresApproval: status !== "contained",
    },
    provenance: id === "untrusted-document" ? "untrusted_external" : "user_sent_originated",
    allowedCommands: status === "contained" ? [] : ["approve", "reject"],
  };
}

function state(record = { revision: 0, statuses: {}, corrected: false }) {
  return {
    mode: "simulation",
    sessionIsolated: true,
    revision: record.revision,
    proposals: [
      proposal("calendar-focus", record.statuses["calendar-focus"]),
      proposal("newsletter-triage", record.statuses["newsletter-triage"]),
      proposal("focus-time-preference", record.statuses["focus-time-preference"]),
      proposal("untrusted-document", "contained"),
    ],
    learning: record.corrected
      ? [{ key: "preferred_focus_window", value: "afternoon", source: "corrected" }]
      : [],
    nextPrediction: {
      changedByLearning: record.corrected,
      proposedAction: record.corrected ? "Suggest 2:00–3:30 PM" : "Suggest 9:00–10:30 AM",
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function successfulHandler() {
  let counter = 0;
  const active = new Set();
  const records = new Map();
  return async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const authorization = req.headers.authorization;
    const headerToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const url = new URL(req.url, "http://127.0.0.1");
    const queryToken = url.searchParams.get("token");
    const token = headerToken ?? queryToken;
    if (url.pathname === "/api/v1/demo/info") {
        return res.end(JSON.stringify({ available: true, userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", instanceNonce: "test-nonce" }));
    }
    if (url.pathname === "/api/v1/demo/session" && req.method === "POST") {
      if (headerToken) active.delete(headerToken);
      const next = `skytwin-demo-v1.sample-token-that-is-long-enough-${++counter}`;
      active.add(next);
      records.set(next, { revision: 0, statuses: {}, corrected: false });
      res.statusCode = 201;
      return res.end(JSON.stringify({
        token: next,
        userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      }));
    }
    if (url.pathname === "/api/decisions/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" && req.method === "GET") {
      if (!active.has(token)) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      return res.end(JSON.stringify({ decisions: [{ id: "00000000-0000-4000-8000-000000000010" }], total: 1 }));
    }
    if (url.pathname === "/api/decisions/00000000-0000-4000-8000-000000000010/explanation") {
      return res.end(JSON.stringify({ explanation: {
        id: "00000000-0000-4000-8000-000000000020",
        decisionId: "00000000-0000-4000-8000-000000000010",
        whatHappened: "Fictional signal observed",
        confidenceReasoning: "Fixture confidence",
        actionRationale: "Preference matched",
        correctionGuidance: "Correct the sample",
      } }));
    }
    if (url.pathname === "/api/v1/demo/simulation") {
      if (!active.has(token)) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: "invalid sample session" }));
      }
      if (req.method === "DELETE") {
        active.delete(token);
        records.delete(token);
        res.statusCode = 204;
        return res.end();
      }
      return res.end(JSON.stringify(state(records.get(token))));
    }
    if (url.pathname === "/api/v1/demo/simulation/commands") {
      if (!active.has(token)) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: "invalid sample session" }));
      }
      const command = await readBody(req);
      const record = records.get(token);
      if (command.type === "reset") {
        records.set(token, { revision: 0, statuses: {}, corrected: false });
      } else {
        record.revision += 1;
        record.statuses[command.proposalId] = `simulated_${command.type === "approve" ? "approved" : command.type === "reject" ? "rejected" : "corrected"}`;
        if (command.type === "correct") record.corrected = true;
      }
      return res.end(JSON.stringify(state(records.get(token))));
    }
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: "sample mode is read-only" }));
  };
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("packaged sample HTTP probe", () => {
  it("passes only after populated reads, commands, isolation, denials, reset, and disposal", async () => {
    await withServer(successfulHandler(), async (url) => {
      const checks = await probeSampleLoop(url, "test-nonce");
      expect(checks.map((check) => check.checkId)).toEqual(CHECK_IDS);
      expect(checks[0].measurement).toContain("approve/reject/correct");
    });
  });

  it("fails closed when the responder lacks the process nonce", async () => {
    const handler = successfulHandler();
    await withServer(async (req, res) => {
      if (req.url === "/api/v1/demo/info") {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        return res.end(JSON.stringify({ available: true, userId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", instanceNonce: "other" }));
      }
      return handler(req, res);
    }, async (url) => {
      await expect(probeSampleLoop(url, "test-nonce")).rejects.toThrow(/not owned/);
    });
  });

  it("rejects non-loopback endpoints before a request", async () => {
    await expect(probeSampleLoop("https://example.com/", "test-nonce")).rejects.toThrow(/loopback/);
  });
});

describe("canonical verifier inputs", () => {
  it("accepts only the separated discovery and credential-free verification CLIs", () => {
    expect(parseCanonicalArgs(["--discover", "--platform", "linux", "--descriptor", ".release-evidence/provenance/sample.packaged-account-free.linux.json"])).toEqual({
      phase: "discover",
      platform: "linux",
      descriptor: ".release-evidence/provenance/sample.packaged-account-free.linux.json",
    });
    expect(parseCanonicalArgs(["--verify", "--platform", "linux", "--descriptor", ".release-evidence/provenance/sample.packaged-account-free.linux.json", "--output", ".release-evidence/reports/sample.packaged-account-free.linux.json"])).toEqual({
      phase: "verify",
      platform: "linux",
      descriptor: ".release-evidence/provenance/sample.packaged-account-free.linux.json",
      output: ".release-evidence/reports/sample.packaged-account-free.linux.json",
    });
    expect(() => parseCanonicalArgs(["--platform", "linux", "--commit", "0".repeat(40)])).toThrow(/canonical|only/);
    expect(() => parseCanonicalArgs(["--platform", "linux", "--platform", "macos"])).toThrow(/canonical|duplicate/);
  });

  it.each(["../escape", "..\\escape", "/absolute", "\\\\server\\share", "C:\\absolute", "safe/../escape", "safe\\..\\escape", "safe//file"])("rejects unsafe archive member %s", (name) => {
    expect(() => assertSafeArchiveMember(name)).toThrow();
  });

  it("accepts a normalized archive member", () => {
    expect(() => assertSafeArchiveMember("SkyTwin.app/Contents/MacOS/SkyTwin")).not.toThrow();
    expect(() => assertSafeArchiveMember("$PLUGINSDIR\\app-64.7z")).not.toThrow();
  });

  it("launches from the isolated profile without inheriting CI authority", () => {
    const launch = makePackagedLaunch("/artifact/SkyTwin", "/isolated/profile", "nonce");
    expect(launch.options.cwd).toBe("/isolated/profile");
    expect(launch.options.env.NODE_ENV).toBe("production");
    expect(launch.options.env.SKYTWIN_DEV_AUTH_BYPASS).toBe("false");
    expect(launch.options.env.GITHUB_TOKEN).toBeUndefined();
    expect(launch.options.env.DATABASE_URL).toBeUndefined();
  });

  it("binds every provenance descriptor byte across the workflow boundary", () => {
    const original = descriptorBytes(provenanceDescriptor());
    const expectedDigest = digest(original);
    expect(parseDiscoveryDescriptor(original, expectedDigest, { runId: 123, subjectInode: 20 }).runId).toBe(123);
    for (const mutation of [
      { releaseArtifactId: 999 },
      { releaseArtifactSha256: "d".repeat(64) },
      { subjectInode: 21 },
      { runId: 124 },
    ]) {
      expect(() => parseDiscoveryDescriptor(descriptorBytes(provenanceDescriptor(mutation)), expectedDigest)).toThrow(/digest changed/);
    }
  });

  it("rejects descriptor context mismatches and unknown fields even with a matching digest", () => {
    const wrongRun = descriptorBytes(provenanceDescriptor({ runId: 124 }));
    expect(() => parseDiscoveryDescriptor(wrongRun, digest(wrongRun), { runId: 123 })).toThrow(/runId/);
    const extra = descriptorBytes({ ...provenanceDescriptor(), unexpected: true });
    expect(() => parseDiscoveryDescriptor(extra, digest(extra))).toThrow(/keys were/);
  });

  it("requests tree-aware Windows shutdown before accepting a clean stop", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 42, exitCode: null, signalCode: null, kill: () => false });
    const requests = [];
    const result = await stopProcessTree(child, {
      platform: "win32",
      requestWindowsTreeStop(force) {
        requests.push(force);
        child.exitCode = 0;
      },
      timeoutMs: 10,
    });
    expect(requests).toEqual([false]);
    expect(result).toEqual({ requested: true, forced: false });
  });

  it("forces a lingering POSIX process group even after the direct child exits", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 43, exitCode: null, signalCode: null, kill: () => false });
    const signals = [];
    const result = await stopProcessTree(child, {
      platform: "linux",
      killGroup(signal) {
        signals.push(signal);
        if (signal === "SIGTERM") child.exitCode = 0;
      },
      groupExists: () => true,
      timeoutMs: 1,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toEqual({ requested: true, forced: true });
  });

  it("requires exactly one direct regular downloaded subject", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-verifier-test-"));
    roots.push(root);
    const directory = join(root, "artifacts", "SkyTwin-Linux-AppImage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SkyTwin.AppImage"), "payload");
    const config = { artifactName: "SkyTwin-Linux-AppImage", subjectSuffix: ".AppImage" };
    expect(selectDownloadedSubject(root, config).name).toBe("SkyTwin.AppImage");
    writeFileSync(join(directory, "decoy.AppImage"), "decoy");
    expect(() => selectDownloadedSubject(root, config)).toThrow(/exactly one/);
  });

  it("accepts a canonical executable reached through a symlinked temporary-directory alias", () => {
    const holder = mkdtempSync(join(tmpdir(), "sample-verifier-alias-"));
    roots.push(holder);
    const realRoot = join(holder, "real");
    const aliasRoot = join(holder, "alias");
    mkdirSync(join(realRoot, "SkyTwin.app", "Contents", "MacOS"), { recursive: true });
    const executable = join(realRoot, "SkyTwin.app", "Contents", "MacOS", "SkyTwin");
    writeFileSync(executable, "binary");
    symlinkSync(realRoot, aliasRoot);
    expect(oneExecutable(aliasRoot, "SkyTwin.app/Contents/MacOS/SkyTwin")).toBe(realpathSync(executable));
  });

  it("rejects a symlinked downloaded subject", () => {
    const root = mkdtempSync(join(tmpdir(), "sample-verifier-symlink-"));
    roots.push(root);
    const directory = join(root, "artifacts", "SkyTwin-Linux-AppImage");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, "real.AppImage"), "payload");
    symlinkSync(join(root, "real.AppImage"), join(directory, "SkyTwin.AppImage"));
    const config = { artifactName: "SkyTwin-Linux-AppImage", subjectSuffix: ".AppImage" };
    expect(() => selectDownloadedSubject(root, config)).toThrow(/direct regular file/);
  });
});
