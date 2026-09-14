#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  machineProducerJobName,
  machineVerifierCommand,
  machineVerifierPath,
} from "../release-constants.mjs";

export const CLAIM_ID = "sample.packaged-account-free";
export const CHECK_IDS = Object.freeze(["sample.packaged-account-free-loop"]);

const PLATFORM_CONFIG = Object.freeze({
  macos: Object.freeze({
    nodePlatform: "darwin",
    artifactName: "SkyTwin-macOS-zip",
    artifactKind: "desktop-archive",
    subjectSuffix: ".zip",
    derivationMethod: "zip-ditto",
    executableSuffix: "SkyTwin.app/Contents/MacOS/SkyTwin",
    extractedPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
    reportDerivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
  }),
  windows: Object.freeze({
    nodePlatform: "win32",
    artifactName: "SkyTwin-Windows-installer",
    artifactKind: "desktop-installer",
    subjectSuffix: ".exe",
    derivationMethod: "nsis-7zip",
    executableSuffix: "SkyTwin.exe",
    extractedPath: "payload/SkyTwin.exe",
    reportDerivationPath: "app-64.7z!/SkyTwin.exe",
  }),
  linux: Object.freeze({
    nodePlatform: "linux",
    artifactName: "SkyTwin-Linux-AppImage",
    artifactKind: "desktop-installer",
    subjectSuffix: ".AppImage",
    derivationMethod: "appimage-extract",
    executableSuffix: "squashfs-root/skytwin",
    extractedPath: "squashfs-root/skytwin",
    reportDerivationPath: "squashfs-root/skytwin",
  }),
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, description) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${description} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${description} keys were ${actual.join(", ")}`);
}

function validateCommit(commit) {
  assert(/^[0-9a-f]{40}$/.test(commit), "source commit must be a full lowercase Git SHA");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert(head === commit, `source commit ${commit} does not match checked-out HEAD ${head}`);
  execFileSync("git", ["diff", "--quiet", "--ignore-submodules", "HEAD", "--"]);
  execFileSync("git", ["diff", "--cached", "--quiet", "--ignore-submodules", "HEAD", "--"]);
}

function inspectRegularFile(path, description) {
  const requested = resolve(path);
  assert(lstatSync(requested).isFile(), `${description} must be a direct regular file`);
  const absolute = realpathSync(requested);
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    assert(stat.isFile(), `${description} must be a direct regular file`);
    const bytes = readFileSync(descriptor);
    return {
      path: absolute,
      name: basename(absolute),
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}

function validateExecutable(path) {
  const subject = inspectRegularFile(path, "derived packaged executable");
  if (process.platform !== "win32") {
    assert((subject.mode & 0o111) !== 0, "derived packaged subject is not executable");
  }
  return subject;
}

function validateBaseUrl(raw) {
  const url = new URL(raw);
  assert(url.hostname === "127.0.0.1", "sample endpoint must use literal IPv4 loopback");
  assert(url.protocol === "http:", "sample endpoint must use HTTP");
  assert(url.username === "" && url.password === "", "sample endpoint must not contain credentials");
  assert(Number.isSafeInteger(Number(url.port)) && Number(url.port) > 0 && url.pathname === "/" && url.search === "" && url.hash === "", "sample endpoint must be a bare loopback HTTP origin");
  return url;
}

async function requestJson(baseUrl, path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length <= 4 * 1024 * 1024, `${method} ${path.split("?")[0]} exceeded the response-size limit`);
  const text = new TextDecoder().decode(bytes);
  let parsed = null;
  if (text) {
    assert((response.headers.get("content-type") ?? "").toLowerCase().includes("application/json"), `${method} ${path.split("?")[0]} returned a non-JSON content type`);
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path.split("?")[0]} returned invalid JSON`);
    }
  }
  return { status: response.status, body: parsed, cacheControl: response.headers.get("cache-control") };
}

function proposalById(state, id) {
  return state?.proposals?.find((proposal) => proposal?.id === id);
}

async function issueSampleSession(baseUrl, expectedUserId) {
  const before = Date.now();
  const issued = await requestJson(baseUrl, "/api/v1/demo/session", { method: "POST" });
  const after = Date.now();
  assert(issued.status === 201, `sample session returned HTTP ${issued.status}`);
  exactKeys(issued.body, ["token", "userId", "expiresAt"], "sample session");
  assert(typeof issued.body.token === "string" && issued.body.token.length > 20, "sample token is missing");
  assert(issued.body.userId === expectedUserId, "sample session identity changed");
  const expiry = Date.parse(issued.body.expiresAt);
  assert(Number.isFinite(expiry), "sample session expiry is invalid");
  const fourHours = 4 * 60 * 60 * 1000;
  assert(expiry >= before + fourHours - 1_000 && expiry <= after + fourHours + 1_000, "sample session does not have the bounded four-hour lifetime");
  return issued.body.token;
}

async function populatedDecisionAndExplanation(baseUrl, userId, token, deadline) {
  let lastReason = "no decision was returned";
  while (Date.now() < deadline) {
    const decisions = await requestJson(baseUrl, `/api/decisions/${encodeURIComponent(userId)}?limit=50`, { token });
    assert(decisions.status === 200, `sample decisions returned HTTP ${decisions.status}`);
    if (Array.isArray(decisions.body?.decisions) && decisions.body.decisions.length > 0 && decisions.body.total > 0) {
      for (const decision of decisions.body.decisions) {
        if (typeof decision?.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decision.id)) continue;
        const response = await requestJson(baseUrl, `/api/decisions/${encodeURIComponent(decision.id)}/explanation`, { token });
        if (response.status === 404) continue;
        assert(response.status === 200, `sample explanation returned HTTP ${response.status}`);
        const explanation = response.body?.explanation;
        if (
          explanation?.decisionId === decision.id &&
          ["id", "whatHappened", "confidenceReasoning", "actionRationale", "correctionGuidance"].every(
            (field) => typeof explanation[field] === "string" && explanation[field].length > 0,
          )
        ) return decision.id;
        lastReason = "an explanation was incomplete";
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`packaged sample has no populated decision and explanation (${lastReason})`);
}

function assertInitialSimulation(value) {
  assert(value?.mode === "simulation" && value.sessionIsolated === true, "sample simulation shape is invalid");
  assert(value.revision === 0 && Array.isArray(value.learning) && value.learning.length === 0, "new sample session was not pristine");
  const expected = ["calendar-focus", "newsletter-triage", "focus-time-preference", "untrusted-document"];
  assert(JSON.stringify(value.proposals?.map((proposal) => proposal?.id).sort()) === JSON.stringify([...expected].sort()), "sample proposal catalog changed");
  for (const proposal of value.proposals) {
    assert(proposal.simulationOnly === true && proposal.externalEffects === false, `sample proposal ${proposal.id} did not report simulation containment`);
    if (proposal.id === "untrusted-document") {
      assert(proposal.status === "contained" && proposal.provenance === "untrusted_external" && proposal.allowedCommands?.length === 0, "untrusted sample proposal exposed an action path");
    } else {
      assert(proposal.status === "pending" && proposal.policy?.allowed === true && proposal.policy?.requiresApproval === true, `sample proposal ${proposal.id} bypassed approval`);
    }
  }
  return value.proposals.filter((proposal) => proposal.status === "pending").length;
}

export async function probeDashboard(rawBaseUrl, deadline = Date.now() + 60_000) {
  const baseUrl = validateBaseUrl(rawBaseUrl);
  assert(Date.now() < deadline, "packaged sample exceeded the 60-second dashboard deadline");
  const response = await fetch(baseUrl, {
    headers: { Accept: "text/html" },
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
  });
  assert(response.status === 200, `sample dashboard returned HTTP ${response.status}`);
  assert((response.headers.get("content-type") ?? "").toLowerCase().includes("text/html"), "sample dashboard returned a non-HTML content type");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, "sample dashboard response size is outside the release bound");
  const html = new TextDecoder().decode(bytes);
  assert(html.includes('id="page-content"') && html.includes('src="/js/app.js"'), "sample dashboard shell is incomplete");
  assert(Date.now() < deadline, "packaged sample exceeded the 60-second dashboard deadline");
}

export async function probeSampleLoop(rawBaseUrl, expectedNonce, deadline = Date.now() + 60_000) {
  const baseUrl = validateBaseUrl(rawBaseUrl);
  assert(Date.now() < deadline, "packaged sample exceeded the 60-second sample deadline");
  const info = await requestJson(baseUrl, "/api/v1/demo/info");
  assert(info.status === 200 && info.cacheControl === "no-store", "sample info was unavailable or cacheable");
  assert(info.body.available === true && info.body.userId === "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "packaged sample reserved identity is unavailable");
  assert(info.body.instanceNonce === expectedNonce, "sample API is not owned by the launched release subject");
  exactKeys(info.body, ["available", "userId", "instanceNonce"], "sample info");

  const unauthenticated = await requestJson(baseUrl, "/api/v1/demo/simulation");
  assert(unauthenticated.status === 401 && unauthenticated.cacheControl === "no-store", "sample simulation accepted no credential");
  const withoutProductCredential = await requestJson(baseUrl, `/api/decisions/${info.body.userId}`);
  assert(withoutProductCredential.status === 401, "normal product reads accepted no credential");

  const tokenA = await issueSampleSession(baseUrl, info.body.userId);
  const tokenB = await issueSampleSession(baseUrl, info.body.userId);
  assert(tokenA !== tokenB, "two sample sessions reused a credential");
  await populatedDecisionAndExplanation(baseUrl, info.body.userId, tokenA, deadline);

  const initialA = await requestJson(baseUrl, "/api/v1/demo/simulation", { token: tokenA });
  assert(initialA.status === 200 && initialA.cacheControl === "no-store", "sample simulation did not return a private response");
  const pendingCount = assertInitialSimulation(initialA.body);
  const initialB = await requestJson(baseUrl, "/api/v1/demo/simulation", { token: tokenB });
  assert(initialB.status === 200, "second sample session was unavailable");
  assertInitialSimulation(initialB.body);

  const approve = await requestJson(baseUrl, "/api/v1/demo/simulation/commands", {
    method: "POST", token: tokenA, body: { type: "approve", proposalId: "calendar-focus" },
  });
  assert(approve.status === 200 && approve.cacheControl === "no-store", `sample approval returned HTTP ${approve.status}`);
  assert(proposalById(approve.body, "calendar-focus")?.status === "simulated_approved" && proposalById(approve.body, "calendar-focus")?.externalEffects === false, "sample approval did not return a contained terminal marker");

  const reject = await requestJson(baseUrl, "/api/v1/demo/simulation/commands", {
    method: "POST", token: tokenA, body: { type: "reject", proposalId: "newsletter-triage" },
  });
  assert(reject.status === 200 && proposalById(reject.body, "newsletter-triage")?.status === "simulated_rejected" && proposalById(reject.body, "newsletter-triage")?.externalEffects === false, "sample rejection did not return a contained terminal marker");

  const correct = await requestJson(baseUrl, "/api/v1/demo/simulation/commands", {
    method: "POST", token: tokenA,
    body: { type: "correct", proposalId: "focus-time-preference", correctionId: "prefer-afternoons" },
  });
  assert(correct.status === 200 && proposalById(correct.body, "focus-time-preference")?.status === "simulated_corrected", "sample correction did not complete");
  assert(correct.body?.revision === 3 && correct.body?.nextPrediction?.changedByLearning === true && correct.body.nextPrediction.proposedAction?.includes("2:00"), "sample correction did not change the next prediction");
  assert(correct.body.learning?.some((item) => item?.key === "preferred_focus_window" && item?.value === "afternoon" && item?.source === "corrected"), "sample correction was not represented as learning");

  const retained = await requestJson(baseUrl, "/api/v1/demo/simulation", { token: tokenA });
  assert(retained.status === 200 && retained.body?.revision === 3 && retained.body?.nextPrediction?.changedByLearning === true, "sample correction was not retained on an independent read");
  const isolated = await requestJson(baseUrl, "/api/v1/demo/simulation", { token: tokenB });
  assert(isolated.status === 200 && isolated.body?.revision === 0 && isolated.body?.nextPrediction?.changedByLearning === false, "sample state crossed the credential isolation boundary");

  const tamperedToken = `${tokenA.slice(0, -1)}${tokenA.endsWith("a") ? "b" : "a"}`;
  const denials = [
    ["GET", "/api/v1/demo/simulation", tamperedToken],
    ["GET", "/api/decisions/00000000-0000-4000-8000-000000000001", tokenA],
    ["PUT", `/api/users/${info.body.userId}/trust-tier`, tokenA, { trustTier: "high_autonomy" }],
    ["GET", `/api/settings/${info.body.userId}`, tokenA],
    ["GET", "/api/credential-vault/status", tokenA],
    ["GET", `/api/search?userId=${info.body.userId}&q=invoice`, tokenA],
    ["POST", "/api/capabilities/install", tokenA, {}],
    ["POST", "/api/approvals/00000000-0000-4000-8000-000000000002/respond", tokenA, { action: "approve", userId: info.body.userId }],
    ["POST", `/api/v1/twin/ask/${info.body.userId}`, tokenA, { situation: "release evidence probe" }],
  ];
  for (const [method, path, token, body] of denials) {
    const response = await requestJson(baseUrl, path, { method, token, body });
    const expectedStatus = token === tamperedToken ? 401 : 403;
    assert(response.status === expectedStatus, `${method} ${path.split("?")[0]} returned HTTP ${response.status}, expected ${expectedStatus}`);
  }
  const sse = await requestJson(baseUrl, `/api/events/stream/${info.body.userId}?token=${encodeURIComponent(tokenA)}`);
  assert(sse.status === 403, `sample SSE entrance returned HTTP ${sse.status}, expected 403`);

  const reset = await requestJson(baseUrl, "/api/v1/demo/simulation/commands", { method: "POST", token: tokenA, body: { type: "reset" } });
  assert(reset.status === 200, `sample reset returned HTTP ${reset.status}`);
  assertInitialSimulation(reset.body);
  const discarded = await requestJson(baseUrl, "/api/v1/demo/simulation", { method: "DELETE", token: tokenA });
  assert(discarded.status === 204 && discarded.cacheControl === "no-store", `sample disposal returned HTTP ${discarded.status}`);
  const replay = await requestJson(baseUrl, "/api/v1/demo/simulation", { token: tokenA });
  assert(replay.status === 401, "discarded sample credential recreated state");
  const isolatedAfterDiscard = await requestJson(baseUrl, "/api/v1/demo/simulation", { token: tokenB });
  assert(isolatedAfterDiscard.status === 200 && isolatedAfterDiscard.body?.revision === 0, "discarding one sample changed another session");
  const cleanupB = await requestJson(baseUrl, "/api/v1/demo/simulation", { method: "DELETE", token: tokenB });
  assert(cleanupB.status === 204, "second sample session was not disposed");
  assert(Date.now() < deadline, "packaged sample exceeded the 60-second sample deadline");

  return CHECK_IDS.map((checkId) => ({
    checkId,
    assertion: "The exact packaged subject completed the isolated account-free sample HTTP contract.",
    measurement: `dashboard, API, populated decision and explanation reached within 60 seconds; ${pendingCount} approval-gated proposals; approve/reject/correct; two isolated sessions; bounded credential plus tamper, foreign-user, privileged-route, SSE, reset, disposal and replay denials; API-reported simulationOnly=true and externalEffects=false markers`,
  }));
}

async function targetIsUnused(baseUrl) {
  const server = createServer();
  return new Promise((resolveUnused) => {
    server.once("error", () => resolveUnused(false));
    server.listen({ host: baseUrl.hostname, port: Number(baseUrl.port), exclusive: true }, () =>
      server.close(() => resolveUnused(true)),
    );
  });
}

export async function stopProcessTree(child, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const requestWindowsTreeStop = dependencies.requestWindowsTreeStop ?? ((force) => {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    command(taskkill, ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
  });
  const killGroup = dependencies.killGroup ?? ((signal) => process.kill(-child.pid, signal));
  const groupExists = dependencies.groupExists ?? (() => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  });
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { requested: false, forced: false };
  }
  let requested = false;
  if (platform === "win32") {
    try {
      // Windows has no SIGTERM process-group primitive. taskkill /T /F is the
      // deterministic platform tree request; later retries are cleanup failures.
      requestWindowsTreeStop(true);
      requested = true;
    } catch {
      child.kill("SIGKILL");
      return { requested: false, forced: true };
    }
  } else {
    try {
      killGroup("SIGTERM");
      requested = true;
    } catch {
      requested = child.kill("SIGTERM");
    }
  }
  const deadline = Date.now() + timeoutMs;
  let treeStopped = false;
  do {
    const parentStopped = child.exitCode !== null || child.signalCode !== null;
    treeStopped = parentStopped && (platform === "win32" || !groupExists());
    if (!treeStopped) await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (!treeStopped && Date.now() < deadline);
  if (treeStopped) return { requested, forced: false };
  if (platform === "win32") {
    try {
      requestWindowsTreeStop(true);
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      killGroup("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  return { requested, forced: true };
}

export function makePackagedLaunch(executablePath, profileRoot, nonce) {
  const env = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    COMSPEC: process.env.COMSPEC ?? "",
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    APPDATA: join(profileRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(profileRoot, "AppData", "Local"),
    XDG_CONFIG_HOME: join(profileRoot, "config"),
    XDG_DATA_HOME: join(profileRoot, "data"),
    XDG_CACHE_HOME: join(profileRoot, "cache"),
    TMPDIR: join(profileRoot, "tmp"), TEMP: join(profileRoot, "tmp"), TMP: join(profileRoot, "tmp"),
    NODE_ENV: "production",
    SKYTWIN_DEV_AUTH_BYPASS: "false",
    SKYTWIN_RELEASE_EVIDENCE_NONCE: nonce,
  };
  const executableArgs = [`--user-data-dir=${join(profileRoot, "electron")}`];
  return {
    command: process.platform === "linux" ? "/usr/bin/xvfb-run" : executablePath,
    args: process.platform === "linux" ? ["-a", executablePath, ...executableArgs] : executableArgs,
    options: {
      cwd: profileRoot,
      env,
      stdio: "ignore",
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  };
}

async function bootAndProbeSampleLoop(executablePath) {
  const baseUrl = validateBaseUrl("http://127.0.0.1:3100/");
  const dashboardUrl = validateBaseUrl("http://127.0.0.1:3200/");
  assert(baseUrl.port === "3100", "packaged sample evidence must use port 3100");
  assert(await targetIsUnused(baseUrl), "sample API port was already occupied before launch");
  assert(await targetIsUnused(dashboardUrl), "sample dashboard port was already occupied before launch");
  const profileRoot = mkdtempSync(join(tmpdir(), "skytwin-sample-evidence-"));
  for (const directory of [
    join(profileRoot, "AppData", "Roaming"), join(profileRoot, "AppData", "Local"),
    join(profileRoot, "config"), join(profileRoot, "data"), join(profileRoot, "cache"),
    join(profileRoot, "tmp"), join(profileRoot, "electron"),
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const nonce = randomBytes(32).toString("hex");
  const launch = makePackagedLaunch(executablePath, profileRoot, nonce);
  const deadline = Date.now() + 60_000;
  const child = spawn(launch.command, launch.args, launch.options);
  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
  try {
    let lastError = new Error("packaged sample did not become ready");
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`packaged executable exited before readiness (${child.exitCode ?? child.signalCode})`);
      }
      try {
        const info = await requestJson(baseUrl, "/api/v1/demo/info");
        if (info.status === 200 && info.body?.available === true && info.body?.instanceNonce === nonce) {
          await probeDashboard(dashboardUrl.href, deadline);
          return await probeSampleLoop(baseUrl.href, nonce, deadline);
        }
        if (info.body?.instanceNonce && info.body.instanceNonce !== nonce) {
          throw new Error("sample API is not owned by the launched release subject");
        }
      } catch (error) {
        if (error?.message === "sample API is not owned by the launched release subject") throw error;
        lastError = error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    throw lastError;
  } finally {
    const termination = await stopProcessTree(child);
    const shutdownDeadline = Date.now() + 10_000;
    while (
      (!(await targetIsUnused(baseUrl)) || !(await targetIsUnused(dashboardUrl))) &&
      Date.now() < shutdownDeadline
    ) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    const stoppedCleanly = await targetIsUnused(baseUrl) && await targetIsUnused(dashboardUrl);
    rmSync(profileRoot, { recursive: true, force: true });
    assert(termination.requested && !termination.forced, "packaged sample exited unexpectedly or required forced termination");
    assert(stoppedCleanly, "packaged sample left a listener running after shutdown");
  }
}

async function produceEvidence({ executablePath, sourceCommit, provenance }) {
  validateCommit(sourceCommit);
  const executable = validateExecutable(executablePath);
  const checks = await bootAndProbeSampleLoop(executable.path);
  const executableAfterProbe = validateExecutable(executable.path);
  assert(
    executableAfterProbe.sha256 === executable.sha256 &&
      executableAfterProbe.sizeBytes === executable.sizeBytes &&
      executableAfterProbe.device === executable.device &&
      executableAfterProbe.inode === executable.inode,
    "derived packaged executable identity changed while evidence was collected",
  );
  const {
    evidencePlatform,
    derivationMethod,
    derivationPath,
    ...reportProvenance
  } = provenance;
  return {
    ...reportProvenance,
    schemaVersion: 1,
    generatedBy: "release-machine-verifier",
    claimId: CLAIM_ID,
    result: "pass",
    sourceCommit,
    platform: evidencePlatform,
    runnerPlatform: `${process.platform}-${process.arch}`,
    executedBinary: {
      name: executable.name,
      sizeBytes: executable.sizeBytes,
      sha256: executable.sha256,
      device: executable.device,
      inode: executable.inode,
      identityResult: "pass",
      derivationMethod,
      derivationPath,
    },
    checks: checks.map(({ checkId, assertion, measurement }) => ({
      id: checkId,
      testId: checkId,
      result: "pass",
      observed: { assertion, measurement, exitCode: 0 },
    })),
  };
}

export function parseCanonicalArgs(argv) {
  if (
    argv.length === 5 &&
    argv[0] === "--discover" &&
    argv[1] === "--platform" &&
    argv[3] === "--descriptor"
  ) {
    assert(argv[2] && argv[4], "discovery arguments must have values");
    return { phase: "discover", platform: argv[2], descriptor: argv[4] };
  }
  if (
    argv.length === 7 &&
    argv[0] === "--verify" &&
    argv[1] === "--platform" &&
    argv[3] === "--descriptor" &&
    argv[5] === "--output"
  ) {
    assert(argv[2] && argv[4] && argv[6], "verification arguments must have values");
    return { phase: "verify", platform: argv[2], descriptor: argv[4], output: argv[6] };
  }
  throw new Error("arguments must use the canonical discovery or credential-free verification form");
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  assert(value && pattern.test(value), `${name} is missing or malformed`);
  return value;
}

function positiveInteger(name) {
  const raw = requiredEnvironment(name, /^\d+$/);
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

export function assertSafeArchiveMember(rawName) {
  assert(typeof rawName === "string" && rawName.length > 0 && !rawName.includes("\0"), "archive member name is empty or contains NUL");
  const name = rawName.replaceAll("\\", "/").replace(/\/$/, "");
  if (name === "") return;
  assert(!/[\u0000-\u001f\u007f]/.test(name), `archive member contains a control character: ${rawName}`);
  assert(!name.startsWith("/") && !/^[A-Za-z]:\//.test(name), `archive member is absolute: ${rawName}`);
  const parts = name.split("/");
  assert(parts.every((part) => part !== "" && part !== "." && part !== ".."), `archive member escapes its extraction root: ${rawName}`);
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  assert(parts.every((part) => !part.includes(":") && !/[. ]$/.test(part) && !reserved.test(part)), `archive member is unsafe on Windows: ${rawName}`);
}

function validateMemberInventory(names, { allowBackslash = true } = {}) {
  assert(names.length > 0 && names.length <= 100_000, "archive member count is outside the release bound");
  const exact = new Set();
  const folded = new Set();
  for (const name of names) {
    assert(allowBackslash || !name.includes("\\"), `archive member uses an ambiguous path separator: ${name}`);
    assertSafeArchiveMember(name);
    const normalized = name.replaceAll("\\", "/").replace(/\/$/, "");
    if (!normalized) continue;
    assert(!exact.has(normalized), `archive contains duplicate member ${name}`);
    assert(!folded.has(normalized.toLowerCase()), `archive contains case-colliding member ${name}`);
    exact.add(normalized);
    folded.add(normalized.toLowerCase());
  }
}

function command(command, args, options = {}) {
  const toolEnvironment = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    WINDIR: process.env.WINDIR ?? "",
    TEMP: process.env.RUNNER_TEMP ?? tmpdir(),
    TMP: process.env.RUNNER_TEMP ?? tmpdir(),
  };
  return execFileSync(command, args, {
    encoding: "utf8",
    env: toolEnvironment,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function listRegularFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(path);
    }
  }
  walk(root);
  return files;
}

function validateExtractedTree(root) {
  const absoluteRoot = resolve(root);
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = resolve(directory, readlinkSync(path));
        assert(target === absoluteRoot || target.startsWith(`${absoluteRoot}${sep}`), `extracted symlink escapes its root: ${relative(absoluteRoot, path)}`);
      } else if (stat.isDirectory()) walk(path);
      else assert(stat.isFile(), `extracted archive contains a special file: ${relative(absoluteRoot, path)}`);
    }
  }
  walk(absoluteRoot);
}

export function selectDownloadedSubject(root, config) {
  const artifactDirectory = resolve(realpathSync(root), "artifacts", config.artifactName);
  assert(lstatSync(artifactDirectory).isDirectory(), `${config.artifactName} download is not a directory`);
  assert(realpathSync(artifactDirectory) === artifactDirectory, `${config.artifactName} directory traverses a symbolic link`);
  const entries = readdirSync(artifactDirectory, { withFileTypes: true });
  assert(entries.length === 1, `${config.artifactName} must contain exactly one direct subject`);
  const entry = entries[0];
  assert(entry?.isFile() && !entry.isSymbolicLink(), `${config.artifactName} subject must be a direct regular file`);
  assert(/^[A-Za-z0-9][A-Za-z0-9_.+() -]{0,240}$/.test(entry.name), `${config.artifactName} subject name is unsafe`);
  assert(entry.name.endsWith(config.subjectSuffix), `${config.artifactName} subject has the wrong file type`);
  return inspectRegularFile(join(artifactDirectory, entry.name), `${config.artifactName} subject`);
}

function safeSevenZipListing(archivePath, archiveType) {
  const sevenZip = process.platform === "linux"
    ? "/usr/bin/7z"
    : join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe");
  command(sevenZip, ["t", `-t${archiveType}`, archivePath]);
  const listing = command(sevenZip, ["l", "-slt", `-t${archiveType}`, archivePath]);
  let skippedContainer = false;
  const members = [];
  for (const line of listing.split(/\r?\n/)) {
    if (!line.startsWith("Path = ")) continue;
    const name = line.slice("Path = ".length);
    if (!skippedContainer && (resolve(name) === resolve(archivePath) || name === basename(archivePath))) {
      skippedContainer = true;
      continue;
    }
    members.push(name);
  }
  validateMemberInventory(members);
}

export function oneExecutable(root, suffix) {
  const normalizedSuffix = suffix.replaceAll("\\", "/");
  const candidates = listRegularFiles(root).filter((path) =>
    relative(root, path).split(sep).join("/").endsWith(normalizedSuffix),
  );
  assert(candidates.length === 1, `expected exactly one derived executable ending in ${suffix}, found ${candidates.length}`);
  const candidate = resolve(candidates[0]);
  assert(lstatSync(candidate).isFile(), "derived executable must be a direct regular file");
  const canonicalRoot = realpathSync(root);
  const canonicalCandidate = realpathSync(candidate);
  assert(canonicalCandidate.startsWith(`${canonicalRoot}${sep}`), "derived executable escapes its extraction root");
  return canonicalCandidate;
}

export function deriveExecutable(platform, subjectPath, extractionRoot) {
  const config = PLATFORM_CONFIG[platform];
  assert(config, `unsupported platform ${platform}`);
  mkdirSync(extractionRoot, { recursive: true });
  if (platform === "macos") {
    const zipPreflight = String.raw`
import posixpath, stat, sys, zipfile
archive = zipfile.ZipFile(sys.argv[1])
infos = archive.infolist()
if not infos or len(infos) > 100000:
    raise SystemExit("zip member count outside release bound")
expanded = 0
for info in infos:
    if info.flag_bits & 1:
        raise SystemExit("encrypted zip member")
    expanded += info.file_size
    if expanded > 8 * 1024 * 1024 * 1024:
        raise SystemExit("expanded zip exceeds release bound")
    if info.file_size > 64 * 1024 * 1024 and info.compress_size * 1000 < info.file_size:
        raise SystemExit("zip compression ratio exceeds release bound")
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
        raise SystemExit("zip contains special file")
    if kind == stat.S_IFLNK:
        target = archive.read(info).decode("utf-8", "strict")
        if "\\" in target or target.startswith("/"):
            raise SystemExit("zip symlink target is unsafe")
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(info.filename), target))
        if resolved == ".." or resolved.startswith("../"):
            raise SystemExit("zip symlink escapes extraction root")
`;
    command("/usr/bin/python3", ["-c", zipPreflight, subjectPath]);
    const members = command("/usr/bin/unzip", ["-Z1", subjectPath]).split(/\r?\n/).filter(Boolean);
    validateMemberInventory(members, { allowBackslash: false });
    command("/usr/bin/ditto", ["-x", "-k", subjectPath, extractionRoot]);
  } else if (platform === "windows") {
    const sevenZip = join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe");
    safeSevenZipListing(subjectPath, "NSIS");
    command(sevenZip, ["x", "-tNSIS", subjectPath, `-o${extractionRoot}`, "-y", "-bb0", "-bd"]);
    const payloads = listRegularFiles(extractionRoot).filter((path) => /^app-[^/\\]+\.7z$/i.test(basename(path)));
    assert(payloads.length === 1, `NSIS extraction produced ${payloads.length} application payloads`);
    assert(basename(payloads[0]) === "app-64.7z", `NSIS application payload was ${basename(payloads[0])}, expected app-64.7z`);
    safeSevenZipListing(payloads[0], "7z");
    const payloadRoot = join(extractionRoot, "payload");
    mkdirSync(payloadRoot, { recursive: true });
    command(sevenZip, ["x", "-t7z", payloads[0], `-o${payloadRoot}`, "-y", "-bb0", "-bd"]);
  } else {
    const bytes = readFileSync(subjectPath);
    assert(bytes.length >= 12 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString("ascii") === "ELF", "AppImage subject is not ELF");
    assert(bytes.subarray(8, 11).toString("ascii") === "AI\x02", "AppImage subject is not type 2");
    const offsets = [];
    for (let offset = bytes.indexOf("hsqs"); offset >= 0; offset = bytes.indexOf("hsqs", offset + 4)) {
      offsets.push(offset);
      assert(offsets.length <= 16, "AppImage has too many SquashFS magic candidates");
    }
    const valid = [];
    for (const [index, offset] of offsets.entries()) {
      const carved = join(extractionRoot, `candidate-${index}.squashfs`);
      writeFileSync(carved, bytes.subarray(offset), { flag: "wx", mode: 0o600 });
      try {
        command("/usr/bin/7z", ["t", "-tSquashFS", carved]);
        valid.push(carved);
      } catch {
        rmSync(carved, { force: true });
      }
    }
    assert(valid.length === 1, `AppImage contained ${valid.length} valid SquashFS payloads`);
    safeSevenZipListing(valid[0], "SquashFS");
    const squashfsRoot = join(extractionRoot, "squashfs-root");
    mkdirSync(squashfsRoot, { recursive: true });
    command("/usr/bin/7z", ["x", "-tSquashFS", valid[0], `-o${squashfsRoot}`, "-y", "-bb0", "-bd"]);
  }
  validateExtractedTree(extractionRoot);
  const executablePath = oneExecutable(extractionRoot, config.executableSuffix);
  const extractedPath = relative(realpathSync(extractionRoot), executablePath).split(sep).join("/");
  assert(extractedPath === config.extractedPath, `derived executable path ${extractedPath} did not match ${config.extractedPath}`);
  const executableBytes = readFileSync(executablePath);
  const executableHeader = executableBytes.subarray(0, 4);
  if (platform === "windows") {
    assert(executableHeader.subarray(0, 2).toString("ascii") === "MZ", "derived Windows executable is not PE/MZ");
    assert(executableBytes.length >= 0x40, "derived Windows executable has a truncated DOS header");
    const peOffset = executableBytes.readUInt32LE(0x3c);
    assert(peOffset + 6 <= executableBytes.length && executableBytes.subarray(peOffset, peOffset + 4).toString("binary") === "PE\0\0", "derived Windows executable has an invalid PE header");
    assert(executableBytes.readUInt16LE(peOffset + 4) === 0x8664, "derived Windows executable is not AMD64");
  } else if (platform === "linux") {
    assert(executableHeader[0] === 0x7f && executableHeader.subarray(1).toString("ascii") === "ELF", "derived Linux executable is not ELF");
    assert(executableBytes.length >= 20 && executableBytes.readUInt16LE(18) === 0x3e, "derived Linux executable is not x86-64");
  } else {
    const magic = executableHeader.toString("hex");
    assert(["cffaedfe", "feedfacf", "cafebabe", "bebafeca"].includes(magic), "derived macOS executable is not Mach-O");
  }
  if (process.platform !== "win32") chmodSync(executablePath, 0o755);
  return {
    executablePath,
    derivationPath: config.reportDerivationPath,
  };
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "skytwin-release-machine-verifier",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `GitHub API ${path} returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length <= 16 * 1024 * 1024, `GitHub API ${path} exceeded the response-size limit`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`GitHub API ${path} returned invalid JSON`);
  }
}

export async function resolveCurrentRunArtifact({ repository, runId, artifactName, token }) {
  const run = await githubJson(`/repos/${repository}/actions/runs/${runId}`, token);
  assert(run?.id === runId, "GitHub workflow run id does not match the current run");
  assert(run?.repository?.full_name === repository, "GitHub workflow run belongs to a different repository");
  assert(run?.head_sha === process.env.GITHUB_SHA, "GitHub workflow run belongs to a different source commit");
  assert(run?.event === "push" && run?.path === ".github/workflows/build.yml", "evidence must come from the canonical tag-push workflow");
  const matches = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = await githubJson(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`, token);
    assert(Array.isArray(body?.artifacts), "GitHub artifact response is malformed");
    assert(Number.isSafeInteger(body.total_count) && body.total_count <= 100, "current-run artifact inventory exceeded the single-page release bound");
    matches.push(...body.artifacts.filter((artifact) => artifact?.name === artifactName));
    if (body.artifacts.length < 100) break;
    assert(page < 100, "GitHub artifact pagination exceeded the fail-closed limit");
  }
  assert(matches.length === 1, `expected one current-run ${artifactName} artifact, found ${matches.length}`);
  const artifact = matches[0];
  assert(artifact.expired === false, `${artifactName} artifact is expired`);
  assert(Number.isSafeInteger(artifact.id) && artifact.id > 0, `${artifactName} artifact id is invalid`);
  const digest = String(artifact.digest ?? "").replace(/^sha256:/, "");
  assert(/^[0-9a-f]{64}$/.test(digest), `${artifactName} artifact digest is missing or invalid`);
  assert(artifact.workflow_run?.id === runId, `${artifactName} belongs to a different workflow run`);
  assert(artifact.workflow_run?.head_sha === process.env.GITHUB_SHA, `${artifactName} belongs to a different source commit`);
  const detail = await githubJson(`/repos/${repository}/actions/artifacts/${artifact.id}`, token);
  assert(detail?.id === artifact.id && detail?.name === artifactName && detail?.expired === false, `${artifactName} artifact detail disagrees with the run inventory`);
  assert(String(detail.digest ?? "").replace(/^sha256:/, "") === digest, `${artifactName} artifact digest changed between API reads`);
  assert(detail.workflow_run?.id === runId && detail.workflow_run?.head_sha === process.env.GITHUB_SHA, `${artifactName} artifact detail belongs to a different run or commit`);
  return { id: artifact.id, digest };
}

function canonicalDescriptorPath(platform) {
  return `.release-evidence/provenance/${CLAIM_ID}.${platform}.json`;
}

function readRunIdentity(platform, config) {
  assert(process.platform === config.nodePlatform, `--platform ${platform} does not match native runtime ${process.platform}`);
  const expectedRunnerOs = { macos: "macOS", windows: "Windows", linux: "Linux" }[platform];
  const expectedRunnerArch = { x64: "X64", arm64: "ARM64" }[process.arch];
  assert(process.env.RUNNER_OS === expectedRunnerOs, `RUNNER_OS does not match ${platform}`);
  assert(expectedRunnerArch && process.env.RUNNER_ARCH === expectedRunnerArch, `RUNNER_ARCH does not match ${process.arch}`);
  const sourceCommit = requiredEnvironment("GITHUB_SHA", /^[0-9a-f]{40}$/);
  const runId = positiveInteger("GITHUB_RUN_ID");
  const repository = requiredEnvironment("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const ref = requiredEnvironment("GITHUB_REF", /^refs\/tags\/v[^\s]+$/);
  const releaseTag = requiredEnvironment("GITHUB_REF_NAME", /^v[^\s]+$/);
  assert(ref === `refs/tags/${releaseTag}`, "GITHUB_REF and GITHUB_REF_NAME disagree");
  return { sourceCommit, runId, repository, ref, releaseTag };
}

function writeExclusiveJson(root, relativePath, expectedDirectory, value) {
  const output = resolve(root, relativePath);
  const directory = resolve(root, expectedDirectory);
  assert(output.startsWith(`${directory}${sep}`), `${relativePath} must be inside ${expectedDirectory}`);
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
  return sha256(bytes);
}

export function parseDiscoveryDescriptor(bytes, expectedSha256, expected = {}) {
  assert(bytes.length <= 64 * 1024, "packaged sample provenance descriptor exceeds its size bound");
  assert(sha256(bytes) === expectedSha256, "packaged sample provenance descriptor digest changed between workflow steps");
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("packaged sample provenance descriptor is not valid JSON");
  }
  exactKeys(value, [
    "schemaVersion", "generatedBy", "claimId", "sourceCommit", "releaseTag", "runId",
    "repository", "ref", "releaseArtifactKind", "releaseArtifactId", "releaseArtifactName",
    "releaseArtifactSha256", "subjectName", "subjectPath", "subjectSha256", "subjectSizeBytes",
    "subjectDevice", "subjectInode", "evidencePlatform", "runnerPlatform",
  ], "packaged sample provenance descriptor");
  assert(value.schemaVersion === 1 && value.generatedBy === "release-artifact-discovery", "packaged sample provenance descriptor identity is invalid");
  assert(value.claimId === CLAIM_ID, "packaged sample provenance descriptor claim is invalid");
  assert(Number.isSafeInteger(value.releaseArtifactId) && value.releaseArtifactId > 0, "packaged sample provenance descriptor artifact id is invalid");
  assert(Number.isSafeInteger(value.subjectSizeBytes) && value.subjectSizeBytes > 0, "packaged sample provenance descriptor subject size is invalid");
  assert(Number.isSafeInteger(value.subjectDevice) && Number.isSafeInteger(value.subjectInode), "packaged sample provenance descriptor file identity is invalid");
  assert(/^[0-9a-f]{64}$/.test(value.releaseArtifactSha256) && /^[0-9a-f]{64}$/.test(value.subjectSha256), "packaged sample provenance descriptor digest is invalid");
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert(value[key] === expectedValue, `packaged sample provenance descriptor ${key} does not match the credential-free verification input`);
  }
  return value;
}

function readDiscoveryDescriptor(root, relativePath, expectedSha256, expected) {
  const descriptor = inspectRegularFile(resolve(root, relativePath), "packaged sample provenance descriptor");
  return parseDiscoveryDescriptor(readFileSync(descriptor.path), expectedSha256, expected);
}

export async function runCanonicalVerifier(argv = process.argv.slice(2)) {
  const args = parseCanonicalArgs(argv);
  const config = PLATFORM_CONFIG[args.platform];
  assert(config, `unsupported --platform ${args.platform}`);
  assert(args.descriptor === canonicalDescriptorPath(args.platform), "--descriptor does not match the canonical platform provenance path");
  if (args.phase === "verify") {
    assert(
      args.output === `.release-evidence/reports/${CLAIM_ID}.${args.platform}.json`,
      "--output does not match the canonical platform report path",
    );
  }
  const identity = readRunIdentity(args.platform, config);
  validateCommit(identity.sourceCommit);
  const root = realpathSync(process.cwd());
  const subject = selectDownloadedSubject(root, config);

  if (args.phase === "discover") {
    const token = requiredEnvironment("GITHUB_TOKEN", /^[A-Za-z0-9_=-]{20,}$/);
    const artifact = await resolveCurrentRunArtifact({
      repository: identity.repository,
      runId: identity.runId,
      artifactName: config.artifactName,
      token,
    });
    const descriptorSha256 = writeExclusiveJson(root, args.descriptor, ".release-evidence/provenance", {
      schemaVersion: 1,
      generatedBy: "release-artifact-discovery",
      claimId: CLAIM_ID,
      ...identity,
      releaseArtifactKind: config.artifactKind,
      releaseArtifactId: artifact.id,
      releaseArtifactName: config.artifactName,
      releaseArtifactSha256: artifact.digest,
      subjectName: subject.name,
      subjectPath: `artifacts/${config.artifactName}/${subject.name}`,
      subjectSha256: subject.sha256,
      subjectSizeBytes: subject.sizeBytes,
      subjectDevice: subject.device,
      subjectInode: subject.inode,
      evidencePlatform: args.platform,
      runnerPlatform: `${process.platform}-${process.arch}`,
    });
    const githubOutput = requiredEnvironment("GITHUB_OUTPUT", /^.+$/);
    appendFileSync(githubOutput, `descriptor_sha256=${descriptorSha256}\n`, { encoding: "utf8" });
    return;
  }

  assert(process.env.GITHUB_TOKEN === undefined && process.env.GH_TOKEN === undefined, "package verification must not receive a GitHub API token");
  const descriptorSha256 = requiredEnvironment("SKYTWIN_RELEASE_PROVENANCE_SHA256", /^[0-9a-f]{64}$/);
  const expectedDescriptor = {
    claimId: CLAIM_ID,
    sourceCommit: identity.sourceCommit,
    releaseTag: identity.releaseTag,
    runId: identity.runId,
    repository: identity.repository,
    ref: identity.ref,
    releaseArtifactKind: config.artifactKind,
    releaseArtifactName: config.artifactName,
    subjectName: subject.name,
    subjectPath: `artifacts/${config.artifactName}/${subject.name}`,
    subjectSha256: subject.sha256,
    subjectSizeBytes: subject.sizeBytes,
    subjectDevice: subject.device,
    subjectInode: subject.inode,
    evidencePlatform: args.platform,
    runnerPlatform: `${process.platform}-${process.arch}`,
  };
  const descriptor = readDiscoveryDescriptor(root, args.descriptor, descriptorSha256, expectedDescriptor);
  const extractionRoot = mkdtempSync(join(tmpdir(), `skytwin-${args.platform}-artifact-`));
  try {
    const { executablePath, derivationPath } = deriveExecutable(args.platform, subject.path, extractionRoot);
    const verifierPath = machineVerifierPath(CLAIM_ID);
    const verifierCommand = machineVerifierCommand(CLAIM_ID, args.platform);
    assert(verifierPath && verifierCommand, "canonical verifier metadata is unavailable");
    const verifier = inspectRegularFile(resolve(root, verifierPath), "canonical verifier");
    const evidence = await produceEvidence({
      executablePath,
      sourceCommit: identity.sourceCommit,
      provenance: {
        releaseTag: descriptor.releaseTag,
        runId: descriptor.runId,
        repository: descriptor.repository,
        ref: descriptor.ref,
        releaseArtifactKind: descriptor.releaseArtifactKind,
        releaseArtifactId: descriptor.releaseArtifactId,
        releaseArtifactName: descriptor.releaseArtifactName,
        releaseArtifactSha256: descriptor.releaseArtifactSha256,
        subjectName: descriptor.subjectName,
        subjectPath: descriptor.subjectPath,
        subjectSha256: descriptor.subjectSha256,
        producerJobName: machineProducerJobName(CLAIM_ID, args.platform),
        verifierPath,
        verifierCommand,
        verifierSha256: verifier.sha256,
        evidencePlatform: args.platform,
        derivationMethod: config.derivationMethod,
        derivationPath,
      },
    });
    const subjectAfterProbe = inspectRegularFile(subject.path, `${config.artifactName} subject after probe`);
    assert(
      subjectAfterProbe.sha256 === subject.sha256 &&
        subjectAfterProbe.sizeBytes === subject.sizeBytes &&
        subjectAfterProbe.device === subject.device &&
        subjectAfterProbe.inode === subject.inode,
      "downloaded release artifact subject changed while evidence was collected",
    );
    const output = resolve(root, args.output);
    const reportsRoot = resolve(root, ".release-evidence", "reports");
    assert(output.startsWith(`${reportsRoot}${sep}`), "--output must be inside .release-evidence/reports");
    mkdirSync(reportsRoot, { recursive: true });
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCanonicalVerifier().catch((error) => {
    console.error(`[sample.packaged-account-free] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
