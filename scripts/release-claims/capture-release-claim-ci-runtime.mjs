#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalRegularFile(path, name, { executable = false } = {}) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !/^[A-Za-z0-9_./+-]+$/u.test(path)
  )
    throw new Error(`${name} must resolve to a safe absolute path`);
  const canonical = realpathSync(path);
  if (!/^[A-Za-z0-9_./+-]+$/u.test(canonical))
    throw new Error(`${name} must resolve to a safe absolute path`);
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${name} must resolve to a regular file`);
  if (executable) accessSync(canonical, fsConstants.X_OK);
  return canonical;
}

function canonicalExecutable(path, name) {
  return canonicalRegularFile(path, name, { executable: true });
}

function resolvePathExecutable(name, pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0)
    throw new Error("PATH is required to resolve the pnpm entry");
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      return canonicalExecutable(join(directory, name), name);
    } catch {
      // Continue to the next PATH component. The first executable regular file
      // is the same resolution rule the subsequent shell step would use.
    }
  }
  throw new Error(
    `${name} was not found as an executable regular file on PATH`,
  );
}

function resolvePnpmEntry(launcherPath) {
  const launcher = readFileSync(launcherPath, "utf8");
  if (!/require\((['"])\.\.\/dist\/pnpm\.cjs\1\)/u.test(launcher))
    throw new Error("pnpm launcher does not identify the canonical CLI bundle");
  return canonicalRegularFile(
    resolve(dirname(launcherPath), "../dist/pnpm.cjs"),
    "pnpm CLI bundle",
  );
}

export function captureReleaseClaimCiRuntime({
  env = process.env,
  execPath = process.execPath,
  appendOutput = appendFileSync,
} = {}) {
  const nodePath = canonicalExecutable(execPath, "node");
  const pnpmLauncherPath = resolvePathExecutable("pnpm", env.PATH);
  const pnpmEntryPath = resolvePnpmEntry(pnpmLauncherPath);
  const runtime = {
    nodePath,
    nodeSha256: sha256(nodePath),
    pnpmEntryPath,
    pnpmEntrySha256: sha256(pnpmEntryPath),
  };
  if (typeof env.GITHUB_OUTPUT !== "string" || env.GITHUB_OUTPUT.length === 0)
    throw new Error("GITHUB_OUTPUT is required");
  appendOutput(
    env.GITHUB_OUTPUT,
    [
      `node-path=${runtime.nodePath}`,
      `node-sha256=${runtime.nodeSha256}`,
      `pnpm-entry-path=${runtime.pnpmEntryPath}`,
      `pnpm-entry-sha256=${runtime.pnpmEntrySha256}`,
      "",
    ].join("\n"),
    { encoding: "utf8" },
  );
  return runtime;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  captureReleaseClaimCiRuntime();
