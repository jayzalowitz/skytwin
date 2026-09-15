#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { release as osRelease, tmpdir, totalmem } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  machineProducerJobName,
  machineVerifierCommand,
  machineVerifierPath,
} from "../release-constants.mjs";
import {
  deriveExecutable,
  selectDownloadedSubject,
} from "./sample.packaged-account-free.mjs";
import {
  assertSourceCheckout,
  CANONICAL_MODEL,
  inspectStableRegularFile,
} from "./models.verified-delivery.mjs";

export const CLAIM_ID = "inference.on-device-availability";
export const CHECK_IDS = Object.freeze(["inference.packaged-on-device"]);

const PLATFORM = "macos";
const ARTIFACT_NAME = "SkyTwin-macOS-zip";
const ARTIFACT_KIND = "desktop-archive";
const ARTIFACT_CONFIG = Object.freeze({
  artifactName: ARTIFACT_NAME,
  subjectSuffix: ".zip",
});
const EXPECTED_ARTIFACT_NAMES = Object.freeze([
  "SkyTwin-macOS-dmg",
  ARTIFACT_NAME,
]);
const PACKAGED_PROBE_PATH = "api/dist/bin/verify-on-device-inference.js";
const PACKAGED_APP_ROOTS = Object.freeze(["api", "worker", "web"]);
const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)";
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 100_000;
const MAX_PACKAGED_API_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_PACKAGED_API_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGED_API_EXPANDED_BYTES = 192 * 1024 * 1024;
const MAX_PACKAGED_API_COMPRESSION_RATIO = 100;
const MAX_RUNTIME_REDIRECTS = 2;
const MAX_MODEL_REDIRECTS = 4;
const INFERENCE_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const RUNTIME_IDENTITY_TIMEOUT_MS = 60_000;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const LLAMA_RELEASE_DOWNLOAD_PATH = ["releases", "download"].join("/");
const LLAMA_RELEASE_TAG_PATH = ["releases", "tags"].join("/");

export const PINNED_LLAMA_RUNTIME = Object.freeze({
  repository: "ggml-org/llama.cpp",
  tag: "b10985",
  commit: "7609846557c50f9d984719a9e1e8c5f3d02f807b",
  build: 10_985,
  releaseId: 389_209_275,
  assetId: 565_855_246,
  archiveName: "llama-b10985-bin-macos-arm64.tar.gz",
  source: `https://github.com/ggml-org/llama.cpp/${LLAMA_RELEASE_DOWNLOAD_PATH}/b10985/llama-b10985-bin-macos-arm64.tar.gz`,
  allowedRedirectHosts: Object.freeze(["release-assets.githubusercontent.com"]),
  exactBytes: 11_150_340,
  sha256: "af0c49bbc35add2cdfcdfd9b6fd1fa6d30a9087d4950561fbd6ebda37bd4fe2d",
  root: "llama-b10985",
  binaryName: "llama-completion",
  binaryExactBytes: 33_472,
  binarySha256:
    "3d3d8fd9265fe429b44b49244deb70d6712c93e31d9085b0cb660428fa4f07ab",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  assert(value && pattern.test(value), `${name} is missing or malformed`);
  return value;
}

function positiveInteger(name) {
  const raw = requiredEnvironment(name, /^\d+$/u);
  const value = Number(raw);
  assert(
    Number.isSafeInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
  return value;
}

export function parseCanonicalArgs(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--platform" ||
    argv[1] !== PLATFORM ||
    argv[2] !== "--output" ||
    argv[3] !== `.release-evidence/reports/${CLAIM_ID}.json`
  )
    throw new Error(
      `arguments must be exactly --platform ${PLATFORM} --output .release-evidence/reports/${CLAIM_ID}.json`,
    );
  return { platform: PLATFORM, output: argv[3] };
}

export function parseArtifactBindings(raw, valuePattern, description) {
  assert(
    typeof raw === "string" && raw.length > 0,
    `${description} is missing`,
  );
  const values = new Map();
  for (const item of raw.split(",")) {
    const separator = item.indexOf("=");
    assert(
      separator > 0 && separator === item.lastIndexOf("="),
      `${description} entry is malformed`,
    );
    const name = item.slice(0, separator);
    const value = item.slice(separator + 1);
    assert(
      EXPECTED_ARTIFACT_NAMES.includes(name),
      `${description} contains unexpected artifact ${name}`,
    );
    assert(
      !values.has(name),
      `${description} contains duplicate artifact ${name}`,
    );
    assert(
      valuePattern.test(value),
      `${description} has malformed value for ${name}`,
    );
    values.set(name, value);
  }
  assert(
    values.size === EXPECTED_ARTIFACT_NAMES.length &&
      EXPECTED_ARTIFACT_NAMES.every((name) => values.has(name)),
    `${description} must contain the exact macOS artifact set`,
  );
  return values;
}

function safeArchiveMember(rawName, expectedRoot) {
  assert(
    typeof rawName === "string" &&
      rawName.length > 0 &&
      !/[\u0000-\u001f\u007f]/u.test(rawName),
    "archive member name is empty or contains a control character",
  );
  const name = rawName.replace(/\/$/u, "");
  if (name === expectedRoot) return name;
  assert(!name.startsWith("/"), `archive member is absolute: ${rawName}`);
  const parts = name.split("/");
  assert(
    parts.every((part) => part !== "" && part !== "." && part !== ".."),
    `archive member escapes its extraction root: ${rawName}`,
  );
  assert(
    parts[0] === expectedRoot,
    `archive member has an unexpected root: ${rawName}`,
  );
  return name;
}

export function validateArchiveInventory(output, expectedRoot) {
  const names = String(output).trimEnd().split("\n");
  assert(
    names.length > 0 && names.length <= MAX_ARCHIVE_MEMBERS,
    "archive member count is outside the release bound",
  );
  const seen = new Set();
  for (const rawName of names) {
    const name = safeArchiveMember(rawName, expectedRoot);
    assert(!seen.has(name), `archive contains duplicate member ${name}`);
    seen.add(name);
  }
  return seen;
}

export function validateExtractedTree(root) {
  const canonicalRoot = realpathSync(root);
  let entries = 0;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      assert(
        entries <= MAX_ARCHIVE_MEMBERS,
        "extracted tree exceeds the member bound",
      );
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = resolve(directory, readlinkSync(path));
        assert(
          target === canonicalRoot ||
            target.startsWith(`${canonicalRoot}${sep}`),
          `extracted symlink escapes its root: ${relative(canonicalRoot, path)}`,
        );
      } else if (stat.isDirectory()) {
        walk(path);
      } else {
        assert(
          stat.isFile(),
          `extracted archive contains a special file: ${path}`,
        );
      }
    }
  }
  walk(canonicalRoot);
  assert(entries > 0, "extracted tree is empty");
}

export function runBoundedCommand(command, args, options = {}) {
  const result = (options.runner ?? spawnSync)(command, args, {
    encoding: "utf8",
    env: options.env ?? {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
    killSignal: "SIGKILL",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 30_000,
  });
  assert(
    !result.error,
    `native command failed closed (${result.error?.code ?? "unknown"})`,
  );
  assert(result.signal === null, "native command was signalled");
  assert(
    result.status === 0,
    `native command exited ${result.status ?? "without status"}`,
  );
  return options.includeStderr
    ? `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    : (result.stdout ?? "");
}

async function writeFully(handle, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    assert(result.bytesWritten > 0, "download write made no progress");
    written += result.bytesWritten;
  }
}

function validateDownloadUrl(
  url,
  sourceHost,
  allowedRedirectHosts,
  redirected,
) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === "https:" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "" &&
      (redirected
        ? allowedRedirectHosts.includes(parsed.hostname)
        : parsed.hostname === sourceHost),
    "download URL left its reviewed HTTPS host boundary",
  );
  return parsed;
}

export async function downloadPinnedFile(
  spec,
  root,
  fetchImpl = globalThis.fetch,
) {
  const path = join(root, spec.name);
  assert(basename(spec.name) === spec.name, "download filename is unsafe");
  assert(
    Number.isSafeInteger(spec.exactBytes) && spec.exactBytes > 0,
    "download size pin is invalid",
  );
  assert(SHA256.test(spec.sha256), "download digest pin is invalid");
  let url = validateDownloadUrl(
    spec.source,
    spec.sourceHost,
    spec.allowedRedirectHosts,
    false,
  );
  for (let redirect = 0; redirect <= spec.maxRedirects; redirect += 1) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/octet-stream",
        "Accept-Encoding": "identity",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      assert(
        redirect < spec.maxRedirects,
        "download exceeded its redirect bound",
      );
      const location = response.headers.get("location");
      assert(location, "download redirect omitted Location");
      const next = validateDownloadUrl(
        new URL(location, url).href,
        spec.sourceHost,
        spec.allowedRedirectHosts,
        true,
      );
      await response.body?.cancel();
      url = next;
      continue;
    }
    assert(
      response.status === 200 && response.body,
      `download returned HTTP ${response.status}`,
    );
    assert(
      response.headers.get("content-encoding") === null ||
        response.headers.get("content-encoding") === "identity",
      "download used a content encoding",
    );
    assert(
      response.headers.get("content-length") === String(spec.exactBytes),
      "download Content-Length does not match the immutable size pin",
    );
    const handle = await openFile(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let position = 0;
    const hash = createHash("sha256");
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        position += value.length;
        assert(
          position <= spec.exactBytes,
          "download exceeded its immutable size pin",
        );
        await writeFully(handle, value, position - value.length);
        hash.update(value);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    assert(position === spec.exactBytes, "download was incomplete");
    assert(
      hash.digest("hex") === spec.sha256,
      "download digest did not match the immutable pin",
    );
    return inspectStableRegularFile(
      root,
      path,
      "downloaded pinned file",
      spec.exactBytes,
      spec.sha256,
    );
  }
  throw new Error("download exceeded its redirect bound");
}

async function boundedJson(response, description) {
  assert(
    response.status === 200 && response.body,
    `${description} returned HTTP ${response.status}`,
  );
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    assert(
      length <= 4 * 1024 * 1024,
      `${description} exceeded its response-size bound`,
    );
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

export async function observePinnedRuntimeRelease(
  token,
  fetchImpl = globalThis.fetch,
) {
  assert(
    typeof token === "string" && token.length > 0,
    "GitHub API token is unavailable",
  );
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const releaseResponse = await fetchImpl(
    `https://api.github.com/repos/${PINNED_LLAMA_RUNTIME.repository}/${LLAMA_RELEASE_TAG_PATH}/${PINNED_LLAMA_RUNTIME.tag}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
  );
  const release = await boundedJson(
    releaseResponse,
    "llama.cpp release metadata",
  );
  const matchingAssets = Array.isArray(release.assets)
    ? release.assets.filter(
        (asset) => asset?.id === PINNED_LLAMA_RUNTIME.assetId,
      )
    : [];
  const asset = matchingAssets[0];
  assert(
    release.id === PINNED_LLAMA_RUNTIME.releaseId &&
      release.tag_name === PINNED_LLAMA_RUNTIME.tag &&
      release.target_commitish === PINNED_LLAMA_RUNTIME.commit &&
      matchingAssets.length === 1 &&
      asset.name === PINNED_LLAMA_RUNTIME.archiveName &&
      asset.size === PINNED_LLAMA_RUNTIME.exactBytes &&
      asset.digest === `sha256:${PINNED_LLAMA_RUNTIME.sha256}` &&
      asset.browser_download_url === PINNED_LLAMA_RUNTIME.source,
    "llama.cpp release metadata does not match the immutable runtime pin",
  );
  const refResponse = await fetchImpl(
    `https://api.github.com/repos/${PINNED_LLAMA_RUNTIME.repository}/git/ref/tags/${PINNED_LLAMA_RUNTIME.tag}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
  );
  const ref = await boundedJson(refResponse, "llama.cpp tag metadata");
  assert(
    ref?.ref === `refs/tags/${PINNED_LLAMA_RUNTIME.tag}` &&
      ref?.object?.type === "commit" &&
      ref?.object?.sha === PINNED_LLAMA_RUNTIME.commit,
    "llama.cpp release tag does not resolve to the pinned commit",
  );
  return { releaseMetadataResult: "pass", tagCommitResult: "pass" };
}

function assertDownloadSpace(root) {
  const stats = statfsSync(root);
  const available = stats.bavail * stats.bsize;
  const required = CANONICAL_MODEL.exactBytes + 512 * 1024 * 1024;
  assert(
    available >= required,
    "insufficient disk for the pinned inference inputs",
  );
}

export async function acquirePinnedInputs(root, fetchImpl = globalThis.fetch) {
  assertDownloadSpace(root);
  const runtimeArchive = await downloadPinnedFile(
    {
      name: PINNED_LLAMA_RUNTIME.archiveName,
      source: PINNED_LLAMA_RUNTIME.source,
      sourceHost: "github.com",
      allowedRedirectHosts: PINNED_LLAMA_RUNTIME.allowedRedirectHosts,
      exactBytes: PINNED_LLAMA_RUNTIME.exactBytes,
      sha256: PINNED_LLAMA_RUNTIME.sha256,
      maxRedirects: MAX_RUNTIME_REDIRECTS,
    },
    root,
    fetchImpl,
  );
  const model = await downloadPinnedFile(
    {
      name: CANONICAL_MODEL.name,
      source: CANONICAL_MODEL.source,
      sourceHost: "huggingface.co",
      allowedRedirectHosts: CANONICAL_MODEL.allowedRedirectHosts,
      exactBytes: CANONICAL_MODEL.exactBytes,
      sha256: CANONICAL_MODEL.sha256,
      maxRedirects: MAX_MODEL_REDIRECTS,
    },
    root,
    fetchImpl,
  );

  const inventory = runBoundedCommand("/usr/bin/tar", [
    "-tzf",
    runtimeArchive.path,
  ]);
  validateArchiveInventory(inventory, PINNED_LLAMA_RUNTIME.root);
  runBoundedCommand("/usr/bin/tar", ["-xzf", runtimeArchive.path, "-C", root]);
  const runtimeRoot = join(root, PINNED_LLAMA_RUNTIME.root);
  // Inspect the lexical canonical path before the tree walk canonicalizes it.
  const binary = inspectPinnedRuntimeBinary(runtimeRoot);
  validateExtractedTree(runtimeRoot);
  const versionText = runBoundedCommand(binary.path, ["--version"], {
    // A freshly downloaded executable can spend several seconds in the macOS
    // provenance scan before it emits its immutable build identity.
    timeoutMs: RUNTIME_IDENTITY_TIMEOUT_MS,
    includeStderr: true,
  });
  assert(
    new RegExp(
      `(?:build\\s+${PINNED_LLAMA_RUNTIME.build}|b${PINNED_LLAMA_RUNTIME.build})`,
      "iu",
    ).test(versionText) &&
      versionText.includes(PINNED_LLAMA_RUNTIME.commit.slice(0, 9)),
    "llama.cpp version output does not match the pinned build and commit",
  );
  return { runtimeArchive, model, binary, versionText };
}

export function inspectPinnedRuntimeBinary(runtimeRoot) {
  const binaryPath = join(runtimeRoot, PINNED_LLAMA_RUNTIME.binaryName);
  const binary = inspectStableRegularFile(
    runtimeRoot,
    binaryPath,
    "pinned llama.cpp binary",
    PINNED_LLAMA_RUNTIME.binaryExactBytes,
    PINNED_LLAMA_RUNTIME.binarySha256,
  );
  assert(
    (lstatSync(binary.path).mode & 0o111) !== 0,
    "pinned llama.cpp binary is not executable",
  );
  return binary;
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function runBoundedProcess(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    const killOwnedGroup = () => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") child.kill("SIGKILL");
      }
    };
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > options.maxOutputBytes) {
        overflowed = true;
        killOwnedGroup();
      }
      return next.subarray(0, options.maxOutputBytes + 1);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killOwnedGroup();
      rejectRun(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (groupExists(child.pid)) {
        killOwnedGroup();
        rejectRun(
          new Error("bounded process left an owned descendant running"),
        );
        return;
      }
      if (timedOut || overflowed || signal !== null || status !== 0) {
        rejectRun(
          new Error(
            timedOut
              ? "bounded process timed out"
              : overflowed
                ? "bounded process exceeded its output limit"
                : `bounded process exited ${status ?? signal}`,
          ),
        );
        return;
      }
      resolveRun({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killOwnedGroup();
    }, options.timeoutMs);
  });
}

export async function verifySandboxNetworkDenial(nodePath, options = {}) {
  const { createServer } = await import("node:net");
  const server = createServer();
  let connectionObserved = false;
  server.on("connection", (socket) => {
    connectionObserved = true;
    socket.destroy();
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  try {
    const address = server.address();
    assert(
      address && typeof address === "object",
      "sandbox self-test listener has no address",
    );
    const childExpression =
      `const n=require("node:net");const a=[["127.0.0.1",${address.port}],["1.1.1.1",443]];` +
      `let done=0;let failed=false;for(const [host,port] of a){const s=n.connect({host,port});let settled=false;` +
      `const finish=(denied)=>{if(settled)return;settled=true;s.destroy();if(!denied)failed=true;` +
      `if(++done===a.length){if(failed)process.exit(4);process.stdout.write("child-network-denied",()=>process.exit(0));}};` +
      `s.once("connect",()=>finish(false));s.once("error",(e)=>finish(e.code==="EPERM"||e.code==="EACCES"));` +
      `s.setTimeout(2000,()=>finish(false));}setTimeout(()=>process.exit(5),3000);`;
    const expression =
      `const c=require("node:child_process");const r=c.spawnSync(process.execPath,["-e",${JSON.stringify(childExpression)}],` +
      `{encoding:"utf8",env:{PATH:"/usr/bin:/bin",HOME:${JSON.stringify(tmpdir())}},timeout:4000,maxBuffer:65536});` +
      `if(r.error||r.signal!==null||r.status!==0||r.stdout!=="child-network-denied"||r.stderr!=="")process.exit(6);`;
    const result = await (options.run ?? runBoundedProcess)(
      "/usr/bin/sandbox-exec",
      ["-p", SANDBOX_PROFILE, nodePath, "-e", expression],
      {
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      },
    );
    assert(
      result.stdout === "" && result.stderr === "",
      "sandbox self-test emitted output",
    );
    assert(
      !connectionObserved,
      "network-deny sandbox allowed a loopback connection",
    );
    return true;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

export function parseProbeResult(output, expected) {
  assert(
    output.endsWith("\n") && !output.includes("\0"),
    "probe output framing is invalid",
  );
  const lines = output.trimEnd().split("\n");
  assert(lines.length === 1, "packaged probe must emit exactly one JSON line");
  const value = JSON.parse(lines[0]);
  const keys = [
    "schemaVersion",
    "generatedBy",
    "result",
    "provider",
    "modelName",
    "reasoningMode",
    "executionLocation",
    "networkScope",
    "confidentiality",
    "pricingKind",
    "responseBytes",
    "responseSha256",
    "nonceSha256",
  ].sort();
  assert(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys),
    "packaged probe result has unexpected fields",
  );
  assert(
    value.schemaVersion === 1 &&
      value.generatedBy === "packaged-on-device-inference-probe" &&
      value.result === "pass" &&
      value.provider === "embedded" &&
      value.modelName === expected.modelName &&
      value.reasoningMode === "on_device" &&
      value.executionLocation === "on_device" &&
      value.networkScope === "none" &&
      value.confidentiality === "device_local" &&
      value.pricingKind === "zero" &&
      Number.isSafeInteger(value.responseBytes) &&
      value.responseBytes > 0 &&
      value.responseBytes <= 64 * 1024 &&
      SHA256.test(value.responseSha256) &&
      value.nonceSha256 === sha256(expected.nonce),
    "packaged probe result did not prove the exact on-device execution boundary",
  );
  return value;
}

const PACKAGED_API_PREFLIGHT = String.raw`
import json, os, sys, tarfile, unicodedata

archive_path, expected_probe = sys.argv[1], sys.argv[2]
expected_roots = set(sys.argv[3].split(","))
max_members = int(sys.argv[4])
max_file_bytes = int(sys.argv[5])
max_expanded_bytes = int(sys.argv[6])
max_ratio = int(sys.argv[7])
archive_bytes = os.stat(archive_path).st_size
if archive_bytes <= 0:
    raise SystemExit("packaged API archive is empty")

seen = set()
seen_casefold = set()
member_count = 0
regular_count = 0
directory_count = 0
expanded_bytes = 0
probe_seen = False
roots_seen = set()

with tarfile.open(archive_path, mode="r:gz", errorlevel=2) as archive:
    for member in archive:
        member_count += 1
        if member_count > max_members:
            raise SystemExit("packaged API member count exceeds release bound")
        raw_name = member.name
        if not raw_name or any(ord(character) < 32 or ord(character) == 127 for character in raw_name):
            raise SystemExit("packaged API member name is empty or contains a control character")
        if "\\" in raw_name or raw_name.startswith("/"):
            raise SystemExit("packaged API member path is unsafe")
        name = raw_name[:-1] if raw_name.endswith("/") else raw_name
        parts = name.split("/")
        if not parts or parts[0] not in expected_roots or any(part in ("", ".", "..") for part in parts):
            raise SystemExit("packaged API member escapes its canonical root")
        roots_seen.add(parts[0])
        if name in seen:
            raise SystemExit("packaged API archive contains a duplicate member")
        folded = unicodedata.normalize("NFC", name).casefold()
        if folded in seen_casefold:
            raise SystemExit("packaged API archive contains a case-colliding member")
        seen.add(name)
        seen_casefold.add(folded)
        if member.isdir():
            if member.size != 0:
                raise SystemExit("packaged API directory has a non-zero size")
            directory_count += 1
        elif member.isfile() and member.sparse is None:
            if member.size < 0 or member.size > max_file_bytes:
                raise SystemExit("packaged API file exceeds release bound")
            expanded_bytes += member.size
            if expanded_bytes > max_expanded_bytes:
                raise SystemExit("packaged API expanded bytes exceed release bound")
            regular_count += 1
            if name == expected_probe:
                probe_seen = True
        else:
            raise SystemExit("packaged API archive contains a link or special member")

if member_count == 0 or regular_count == 0:
    raise SystemExit("packaged API archive is empty")
if not probe_seen:
    raise SystemExit("packaged API archive omits the inference probe")
if roots_seen != expected_roots:
    raise SystemExit("packaged API archive does not contain the exact application roots")
if expanded_bytes > archive_bytes * max_ratio:
    raise SystemExit("packaged API compression ratio exceeds release bound")
print(json.dumps({"memberCount": member_count, "regularFileCount": regular_count, "directoryCount": directory_count, "expandedBytes": expanded_bytes, "rootCount": len(roots_seen)}, separators=(",", ":")))
`;

export function preflightPackagedApiArchive(archivePath) {
  const archiveStat = lstatSync(archivePath);
  assert(
    archiveStat.isFile() &&
      !archiveStat.isSymbolicLink() &&
      archiveStat.nlink === 1 &&
      Number.isSafeInteger(archiveStat.size) &&
      archiveStat.size > 0 &&
      archiveStat.size <= MAX_PACKAGED_API_ARCHIVE_BYTES,
    "packaged API archive is not a bounded private regular file",
  );
  const output = runBoundedCommand(
    "/usr/bin/python3",
    [
      "-c",
      PACKAGED_API_PREFLIGHT,
      archivePath,
      PACKAGED_PROBE_PATH,
      PACKAGED_APP_ROOTS.join(","),
      String(MAX_ARCHIVE_MEMBERS),
      String(MAX_PACKAGED_API_FILE_BYTES),
      String(MAX_PACKAGED_API_EXPANDED_BYTES),
      String(MAX_PACKAGED_API_COMPRESSION_RATIO),
    ],
    { timeoutMs: 120_000 },
  );
  let summary;
  try {
    summary = JSON.parse(output);
  } catch {
    throw new Error("packaged API preflight returned invalid JSON");
  }
  assert(
    summary &&
      typeof summary === "object" &&
      !Array.isArray(summary) &&
      JSON.stringify(Object.keys(summary).sort()) ===
        JSON.stringify(
          [
            "memberCount",
            "regularFileCount",
            "directoryCount",
            "expandedBytes",
            "rootCount",
          ].sort(),
        ) &&
      Number.isSafeInteger(summary.memberCount) &&
      summary.memberCount > 0 &&
      summary.memberCount <= MAX_ARCHIVE_MEMBERS &&
      Number.isSafeInteger(summary.regularFileCount) &&
      summary.regularFileCount > 0 &&
      Number.isSafeInteger(summary.directoryCount) &&
      summary.directoryCount >= 0 &&
      Number.isSafeInteger(summary.expandedBytes) &&
      summary.expandedBytes > 0 &&
      summary.expandedBytes <= MAX_PACKAGED_API_EXPANDED_BYTES &&
      summary.rootCount === PACKAGED_APP_ROOTS.length,
    "packaged API preflight summary is invalid",
  );
  return summary;
}

export function inspectPackagedProbe(targetRoot) {
  const probePath = join(targetRoot, PACKAGED_PROBE_PATH);
  const probeStat = lstatSync(probePath);
  return inspectStableRegularFile(
    targetRoot,
    probePath,
    "packaged inference probe",
    Number(probeStat.size),
    null,
  );
}

export function extractPackagedApiArchive(archivePath, targetRoot) {
  preflightPackagedApiArchive(archivePath);
  runBoundedCommand("/usr/bin/tar", [
    "-xzf",
    archivePath,
    "-C",
    targetRoot,
    "api",
  ]);
  // Reject an in-root symlink at the canonical path before any tree realpath.
  const probe = inspectPackagedProbe(targetRoot);
  validateExtractedTree(join(targetRoot, "api"));
  return probe;
}

function unpackPackagedApi(appExtractionRoot, executablePath, targetRoot) {
  const appsArchive = join(
    dirname(executablePath),
    "..",
    "Resources",
    "embedded",
    "apps.tar.gz",
  );
  const archiveStat = lstatSync(appsArchive);
  const archive = inspectStableRegularFile(
    appExtractionRoot,
    appsArchive,
    "packaged API archive",
    Number(archiveStat.size),
    null,
  );
  const probe = extractPackagedApiArchive(archive.path, targetRoot);
  return { archive, probe };
}

async function runPackagedInference(
  probePath,
  binaryPath,
  modelPath,
  profileRoot,
) {
  const nonce = randomBytes(32).toString("hex");
  const nodePath = realpathSync(process.execPath);
  await verifySandboxNetworkDenial(nodePath);
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: profileRoot,
    TMPDIR: join(profileRoot, "tmp"),
    TEMP: join(profileRoot, "tmp"),
    TMP: join(profileRoot, "tmp"),
    NODE_ENV: "production",
  };
  const startedAt = Date.now();
  const result = await runBoundedProcess(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      SANDBOX_PROFILE,
      nodePath,
      probePath,
      "--binary",
      binaryPath,
      "--model",
      modelPath,
      "--nonce",
      nonce,
    ],
    {
      cwd: profileRoot,
      env: environment,
      timeoutMs: INFERENCE_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
    },
  );
  assert(result.stderr === "", "packaged inference probe emitted stderr");
  const observation = parseProbeResult(result.stdout, {
    modelName: basename(modelPath),
    nonce,
  });
  return { observation, latencyMs: Date.now() - startedAt };
}

function runIdentity() {
  assert(process.platform === "darwin", "on-device evidence must run on macOS");
  assert(
    process.arch === "arm64",
    "on-device evidence requires the canonical macOS arm64 runner",
  );
  assert(process.env.RUNNER_OS === "macOS", "RUNNER_OS must identify macOS");
  assert(
    process.env.RUNNER_ARCH === "ARM64",
    "RUNNER_ARCH must identify arm64",
  );
  const sourceCommit = requiredEnvironment("GITHUB_SHA", COMMIT);
  const runId = positiveInteger("GITHUB_RUN_ID");
  const repository = requiredEnvironment(
    "GITHUB_REPOSITORY",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  );
  const ref = requiredEnvironment("GITHUB_REF", /^refs\/tags\/v[^\s]+$/u);
  const releaseTag = requiredEnvironment("GITHUB_REF_NAME", /^v[^\s]+$/u);
  assert(
    ref === `refs/tags/${releaseTag}`,
    "GITHUB_REF and GITHUB_REF_NAME disagree",
  );
  return { sourceCommit, runId, repository, ref, releaseTag };
}

function writeExclusiveReport(root, outputPath, report) {
  const output = resolve(root, outputPath);
  const reportsRoot = resolve(root, ".release-evidence", "reports");
  assert(
    output === join(reportsRoot, `${CLAIM_ID}.json`),
    "output path is not canonical",
  );
  mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function runCanonicalVerifier(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const args = parseCanonicalArgs(argv);
  const identity = runIdentity();
  const root = realpathSync(process.cwd());
  assertSourceCheckout(root, identity);
  const artifactIds = parseArtifactBindings(
    requiredEnvironment("SKYTWIN_RELEASE_ARTIFACT_IDS", /^.+$/u),
    /^\d+$/u,
    "SKYTWIN_RELEASE_ARTIFACT_IDS",
  );
  const artifactDigests = parseArtifactBindings(
    requiredEnvironment("SKYTWIN_RELEASE_ARTIFACT_DIGESTS", /^.+$/u),
    SHA256,
    "SKYTWIN_RELEASE_ARTIFACT_DIGESTS",
  );
  const releaseArtifactId = Number(artifactIds.get(ARTIFACT_NAME));
  assert(
    Number.isSafeInteger(releaseArtifactId) && releaseArtifactId > 0,
    "macOS ZIP artifact ID is invalid",
  );
  const subject = selectDownloadedSubject(root, ARTIFACT_CONFIG);
  const appExtractionRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "skytwin-on-device-app-")),
  );
  const packageRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "skytwin-on-device-package-")),
  );
  const inputRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "skytwin-on-device-inputs-")),
  );
  const profileRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "skytwin-on-device-profile-")),
  );
  for (const directory of [
    appExtractionRoot,
    packageRoot,
    inputRoot,
    profileRoot,
  ])
    chmodSync(directory, 0o700);
  mkdirSync(join(profileRoot, "tmp"), { mode: 0o700 });
  try {
    const { executablePath, derivationPath } = deriveExecutable(
      PLATFORM,
      subject.path,
      appExtractionRoot,
    );
    const executableStat = lstatSync(executablePath);
    const executable = inspectStableRegularFile(
      appExtractionRoot,
      executablePath,
      "derived packaged application",
      Number(executableStat.size),
      null,
    );
    assert(
      (executableStat.mode & 0o111) !== 0,
      "derived packaged application is not executable",
    );
    const packaged = unpackPackagedApi(
      appExtractionRoot,
      executable.path,
      packageRoot,
    );
    const runtimeRelease = await observePinnedRuntimeRelease(
      requiredEnvironment("GITHUB_TOKEN", /^\S+$/u),
      dependencies.fetchImpl,
    );
    const inputs = await acquirePinnedInputs(inputRoot, dependencies.fetchImpl);
    const verifierPath = machineVerifierPath(CLAIM_ID);
    const verifierCommand = machineVerifierCommand(CLAIM_ID, PLATFORM);
    assert(
      verifierPath && verifierCommand,
      "canonical on-device verifier metadata is unavailable",
    );
    const verifierStat = lstatSync(resolve(root, verifierPath));
    const verifier = inspectStableRegularFile(
      root,
      resolve(root, verifierPath),
      "canonical on-device verifier",
      Number(verifierStat.size),
      null,
    );
    const inference = await runPackagedInference(
      packaged.probe.path,
      inputs.binary.path,
      inputs.model.path,
      profileRoot,
    );

    const subjectAfter = selectDownloadedSubject(root, ARTIFACT_CONFIG);
    const executableAfter = inspectStableRegularFile(
      appExtractionRoot,
      executable.path,
      "derived packaged application after inference",
      executable.sizeBytes,
      executable.sha256,
    );
    const probeAfter = inspectStableRegularFile(
      packageRoot,
      packaged.probe.path,
      "packaged inference probe after inference",
      packaged.probe.sizeBytes,
      packaged.probe.sha256,
    );
    const binaryAfter = inspectStableRegularFile(
      inputRoot,
      inputs.binary.path,
      "llama.cpp binary after inference",
      inputs.binary.sizeBytes,
      inputs.binary.sha256,
    );
    const modelAfter = inspectStableRegularFile(
      inputRoot,
      inputs.model.path,
      "GGUF model after inference",
      inputs.model.sizeBytes,
      inputs.model.sha256,
    );
    assert(
      subjectAfter.sha256 === subject.sha256 &&
        subjectAfter.sizeBytes === subject.sizeBytes &&
        executableAfter.sha256 === executable.sha256 &&
        probeAfter.sha256 === packaged.probe.sha256 &&
        binaryAfter.sha256 === inputs.binary.sha256 &&
        modelAfter.sha256 === inputs.model.sha256,
      "an evidence input changed while inference ran",
    );

    const report = {
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId: CLAIM_ID,
      result: "pass",
      sourceCommit: identity.sourceCommit,
      platform: PLATFORM,
      runnerPlatform: `${process.platform}-${process.arch}`,
      releaseTag: identity.releaseTag,
      runId: identity.runId,
      repository: identity.repository,
      ref: identity.ref,
      releaseArtifactKind: ARTIFACT_KIND,
      releaseArtifactId,
      releaseArtifactName: ARTIFACT_NAME,
      releaseArtifactSha256: artifactDigests.get(ARTIFACT_NAME),
      subjectName: subject.name,
      subjectPath: `artifacts/${ARTIFACT_NAME}/${subject.name}`,
      subjectSha256: subject.sha256,
      producerJobName: machineProducerJobName(CLAIM_ID, PLATFORM),
      verifierPath,
      verifierCommand,
      verifierSha256: verifier.sha256,
      packagedApplication: {
        name: executable.name,
        sizeBytes: executable.sizeBytes,
        sha256: executable.sha256,
        device: executable.device,
        inode: executable.inode,
        identityResult: "pass",
        derivationMethod: "zip-ditto",
        derivationPath,
      },
      packagedProbe: {
        path: PACKAGED_PROBE_PATH,
        sizeBytes: packaged.probe.sizeBytes,
        sha256: packaged.probe.sha256,
        identityResult: "pass",
      },
      runtime: {
        repository: PINNED_LLAMA_RUNTIME.repository,
        tag: PINNED_LLAMA_RUNTIME.tag,
        commit: PINNED_LLAMA_RUNTIME.commit,
        releaseId: PINNED_LLAMA_RUNTIME.releaseId,
        assetId: PINNED_LLAMA_RUNTIME.assetId,
        archiveName: PINNED_LLAMA_RUNTIME.archiveName,
        source: PINNED_LLAMA_RUNTIME.source,
        archiveExactBytes: inputs.runtimeArchive.sizeBytes,
        archiveSha256: inputs.runtimeArchive.sha256,
        binaryName: inputs.binary.name,
        binaryExactBytes: inputs.binary.sizeBytes,
        binarySha256: inputs.binary.sha256,
        build: PINNED_LLAMA_RUNTIME.build,
        versionCommit: PINNED_LLAMA_RUNTIME.commit.slice(0, 9),
        versionResult: "pass",
        identityResult: "pass",
        releaseMetadataResult: runtimeRelease.releaseMetadataResult,
        tagCommitResult: runtimeRelease.tagCommitResult,
      },
      model: {
        id: CANONICAL_MODEL.id,
        name: CANONICAL_MODEL.name,
        repository: CANONICAL_MODEL.repository,
        revision: CANONICAL_MODEL.revision,
        exactBytes: inputs.model.sizeBytes,
        sha256: inputs.model.sha256,
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
      inference: {
        ...inference.observation,
        latencyMs: inference.latencyMs,
      },
      hardwareObservation: {
        osRelease: osRelease(),
        architecture: process.arch,
        totalMemoryBytes: totalmem(),
      },
      checks: CHECK_IDS.map((id) => ({
        id,
        testId: id,
        result: "pass",
        observed: {
          assertion:
            "The packaged API bundle completed real llama.cpp text inference with the pinned GGUF model while the verifier process tree had all network access denied.",
          measurement: `embedded provider; ${inference.observation.responseBytes} response bytes; ${inference.latencyMs} ms; runtime build ${PINNED_LLAMA_RUNTIME.build}; macOS arm64`,
          exitCode: 0,
        },
      })),
    };
    writeExclusiveReport(root, args.output, report);
    return report;
  } finally {
    for (const directory of [
      profileRoot,
      inputRoot,
      packageRoot,
      appExtractionRoot,
    ])
      rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCanonicalVerifier().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
