#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  delimiter,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";

const SAFE_ABSOLUTE_PATH = /^[A-Za-z0-9_./+@-]+$/u;
const PNPM_PACKAGE_LAUNCHER =
  /^\.\.\/\.pnpm\/pnpm@[A-Za-z0-9._+-]+\/node_modules\/pnpm\/bin\/pnpm\.cjs$/u;
const PNPM_SHIM_PACKAGE_LAUNCHER = "../pnpm/bin/pnpm.cjs";
const PNPM_CLI_REQUIRE = /require\((['"])\.\.\/dist\/pnpm\.cjs\1\)/u;
const PNPM_SHIM_BUNDLED_NODE =
  /^\s*exec "\$basedir\/node"\s+"\$basedir\/(\.\.\/pnpm\/bin\/pnpm\.cjs)"\s+"\$@"\s*$/gmu;
const PNPM_SHIM_PATH_NODE =
  /^\s*exec node\s+"\$basedir\/(\.\.\/pnpm\/bin\/pnpm\.cjs)"\s+"\$@"\s*$/gmu;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalRegularFile(
  path,
  name,
  { executable = false, requireSingleLink = true } = {},
) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !SAFE_ABSOLUTE_PATH.test(path)
  )
    throw new Error(`${name} must resolve to a safe absolute path`);
  const canonical = realpathSync(path);
  if (!SAFE_ABSOLUTE_PATH.test(canonical))
    throw new Error(`${name} must resolve to a safe absolute path`);
  const stat = lstatSync(canonical);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (requireSingleLink && stat.nlink !== 1)
  )
    throw new Error(
      `${name} must resolve to a ${requireSingleLink ? "single-link " : ""}regular file`,
    );
  if (executable) accessSync(canonical, fsConstants.X_OK);
  return canonical;
}

function canonicalExecutable(path, name, options = {}) {
  return canonicalRegularFile(path, name, { ...options, executable: true });
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

function resolvePnpmPackageLauncher(launcherPath) {
  const launcher = readFileSync(launcherPath, "utf8");
  if (PNPM_CLI_REQUIRE.test(launcher)) return launcherPath;

  // pnpm/action-setup installs pnpm through pnpm itself. Its PATH entry is
  // therefore the generated POSIX .bin shim, not pnpm's JavaScript launcher.
  // Require both branches of that shim to delegate to the same narrowly
  // shaped package path before following the package launcher's own binding.
  const bundledNodeMatches = [...launcher.matchAll(PNPM_SHIM_BUNDLED_NODE)];
  const pathNodeMatches = [...launcher.matchAll(PNPM_SHIM_PATH_NODE)];
  const relativePackageLauncher = bundledNodeMatches[0]?.[1];
  if (
    !launcher.startsWith("#!/bin/sh\n") ||
    bundledNodeMatches.length !== 1 ||
    pathNodeMatches.length !== 1 ||
    relativePackageLauncher !== PNPM_SHIM_PACKAGE_LAUNCHER ||
    pathNodeMatches[0]?.[1] !== relativePackageLauncher ||
    !relativePackageLauncher
  )
    throw new Error(
      "pnpm PATH shim does not identify one canonical package launcher",
    );
  const packageLauncherPath = canonicalExecutable(
    resolve(dirname(launcherPath), relativePackageLauncher),
    "pnpm package launcher",
    { requireSingleLink: false },
  );
  if (
    !PNPM_PACKAGE_LAUNCHER.test(
      relative(dirname(launcherPath), packageLauncherPath),
    )
  )
    throw new Error(
      "pnpm package launcher resolves outside the canonical package layout",
    );
  return packageLauncherPath;
}

function resolvePnpmEntry(launcherPath) {
  const packageLauncherPath = resolvePnpmPackageLauncher(launcherPath);
  const launcher = readFileSync(packageLauncherPath, "utf8");
  if (!PNPM_CLI_REQUIRE.test(launcher))
    throw new Error(
      "pnpm package launcher does not identify the canonical CLI bundle",
    );
  return canonicalRegularFile(
    resolve(dirname(packageLauncherPath), "../dist/pnpm.cjs"),
    "pnpm CLI bundle",
    { requireSingleLink: false },
  );
}

function snapshotPnpmEntry(entryPath, githubOutputPath) {
  if (
    typeof githubOutputPath !== "string" ||
    !isAbsolute(githubOutputPath) ||
    !SAFE_ABSOLUTE_PATH.test(githubOutputPath)
  )
    throw new Error("GITHUB_OUTPUT must be a safe absolute path");
  const outputDirectory = realpathSync(dirname(githubOutputPath));
  if (!SAFE_ABSOLUTE_PATH.test(outputDirectory))
    throw new Error("GITHUB_OUTPUT must be inside a safe canonical directory");
  const outputStat = lstatSync(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink())
    throw new Error("GITHUB_OUTPUT must be inside a canonical directory");
  const snapshotPath = join(
    outputDirectory,
    `.skytwin-release-pnpm-${basename(githubOutputPath)}.cjs`,
  );
  writeFileSync(snapshotPath, readFileSync(entryPath), {
    flag: "wx",
    mode: 0o500,
  });
  return canonicalExecutable(snapshotPath, "pnpm CLI snapshot");
}

export function captureReleaseClaimCiRuntime({
  env = process.env,
  execPath = process.execPath,
  appendOutput = appendFileSync,
} = {}) {
  const nodePath = canonicalExecutable(execPath, "node");
  const pnpmLauncherPath = resolvePathExecutable("pnpm", env.PATH);
  const pnpmEntryPath = snapshotPnpmEntry(
    resolvePnpmEntry(pnpmLauncherPath),
    env.GITHUB_OUTPUT,
  );
  const runtime = {
    nodePath,
    nodeSha256: sha256(nodePath),
    pnpmEntryPath,
    pnpmEntrySha256: sha256(pnpmEntryPath),
  };
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
