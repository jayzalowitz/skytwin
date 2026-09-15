import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureReleaseClaimCiRuntime } from "./capture-release-claim-ci-runtime.mjs";

const roots = [];

function executable(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  chmodSync(absolute, 0o755);
  return absolute;
}

function pnpmRuntime(root, content = "// pnpm CLI bundle\n") {
  const launcherPath = executable(
    root,
    "pnpm/bin/pnpm",
    "#!/usr/bin/env node\nrequire('../dist/pnpm.cjs')\n",
  );
  const entryPath = join(root, "pnpm/dist/pnpm.cjs");
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, content);
  return { launcherPath, entryPath };
}

function pnpmSnapshotPath(root) {
  return join(root, ".skytwin-release-pnpm-github-output.cjs");
}

function pnpmActionSetupRuntime(root, { alternatePathNodeTarget } = {}) {
  const relativePackageLauncher = "../pnpm/bin/pnpm.cjs";
  const packageRoot = join(
    root,
    "node_modules/.pnpm/pnpm@9.1.0/node_modules/pnpm",
  );
  const packageLauncherPath = executable(
    packageRoot,
    "bin/pnpm.cjs",
    "#!/usr/bin/env node\nrequire('../dist/pnpm.cjs')\n",
  );
  const entryPath = join(packageRoot, "dist/pnpm.cjs");
  mkdirSync(dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, "// action-setup pnpm CLI bundle\n");
  linkSync(packageLauncherPath, `${packageLauncherPath}.store-link`);
  linkSync(entryPath, `${entryPath}.store-link`);
  const packageLinkPath = join(root, "node_modules/pnpm");
  symlinkSync(".pnpm/pnpm@9.1.0/node_modules/pnpm", packageLinkPath);
  const launcherPath = executable(
    root,
    "node_modules/.bin/pnpm",
    `#!/bin/sh
basedir=$(dirname "$0")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/${relativePackageLauncher}" "$@"
else
  exec node  "$basedir/${alternatePathNodeTarget ?? relativePackageLauncher}" "$@"
fi
`,
  );
  return {
    launcherPath,
    packageLauncherPath,
    packageLinkPath,
    entryPath,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("release claim CI runtime capture", () => {
  it("captures canonical absolute node and first executable pnpm identities", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node/bin/node", "node runtime\n");
    const { launcherPath, entryPath } = pnpmRuntime(root);
    const appendOutput = vi.fn();
    const runtime = captureReleaseClaimCiRuntime({
      execPath: nodePath,
      env: {
        PATH: [join(root, "missing"), dirname(launcherPath)].join(delimiter),
        GITHUB_OUTPUT: join(root, "github-output"),
      },
      appendOutput,
    });

    expect(runtime).toEqual({
      nodePath: realpathSync(nodePath),
      nodeSha256: createHash("sha256")
        .update(readFileSync(nodePath))
        .digest("hex"),
      pnpmEntryPath: realpathSync(pnpmSnapshotPath(root)),
      pnpmEntrySha256: createHash("sha256")
        .update(readFileSync(entryPath))
        .digest("hex"),
    });
    expect(appendOutput).toHaveBeenCalledOnce();
    expect(appendOutput.mock.calls[0][1]).toContain(
      `node-path=${realpathSync(nodePath)}\n`,
    );
    expect(appendOutput.mock.calls[0][1]).toContain(
      `pnpm-entry-path=${realpathSync(pnpmSnapshotPath(root))}\n`,
    );
  });

  it("binds the delegated pnpm CLI bundle rather than only its launcher", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath, entryPath } = pnpmRuntime(root, "// original\n");
    const runtime = captureReleaseClaimCiRuntime({
      execPath: nodePath,
      env: {
        PATH: dirname(launcherPath),
        GITHUB_OUTPUT: join(root, "github-output"),
      },
    });
    writeFileSync(entryPath, "// lifecycle mutation\n");
    expect(runtime.pnpmEntryPath).toBe(realpathSync(pnpmSnapshotPath(root)));
    expect(readFileSync(runtime.pnpmEntryPath, "utf8")).toBe("// original\n");
    expect(runtime.pnpmEntrySha256).not.toBe(
      createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
    );
  });

  it("resolves the canonical CLI bundle through pnpm/action-setup's PATH shim", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath, entryPath } = pnpmActionSetupRuntime(root);

    expect(
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toMatchObject({
      pnpmEntryPath: realpathSync(pnpmSnapshotPath(root)),
      pnpmEntrySha256: createHash("sha256")
        .update(readFileSync(entryPath))
        .digest("hex"),
    });
  });

  it("rejects a PATH shim whose node branches delegate differently", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath } = pnpmActionSetupRuntime(root, {
      alternatePathNodeTarget: "../attacker/bin/pnpm.cjs",
    });

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow("one canonical package launcher");
  });

  it("rejects a PATH shim with duplicate delegation lines", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath } = pnpmActionSetupRuntime(root);
    appendFileSync(
      launcherPath,
      'exec node "$basedir/../pnpm/bin/pnpm.cjs" "$@"\n',
    );

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow("one canonical package launcher");
  });

  it("rejects delegation text that is not a POSIX shell shim", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath } = pnpmActionSetupRuntime(root);
    const launcher = readFileSync(launcherPath, "utf8").replace(
      "#!/bin/sh\n",
      "not a shell shim\n",
    );
    writeFileSync(launcherPath, launcher, { mode: 0o755 });

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow("one canonical package launcher");
  });

  it("rejects a PATH shim that delegates outside the pnpm package layout", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const launcherPath = executable(
      root,
      "node_modules/.bin/pnpm",
      `#!/bin/sh
exec "$basedir/node" "$basedir/../../attacker/pnpm.cjs" "$@"
exec node "$basedir/../../attacker/pnpm.cjs" "$@"
`,
    );

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow("one canonical package launcher");
  });

  it("rejects a package alias that resolves outside the pnpm store layout", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath, packageLinkPath } = pnpmActionSetupRuntime(root);
    rmSync(packageLinkPath);
    const attackerRoot = join(root, "attacker");
    executable(
      attackerRoot,
      "bin/pnpm.cjs",
      "#!/usr/bin/env node\nrequire('../dist/pnpm.cjs')\n",
    );
    mkdirSync(join(attackerRoot, "dist"), { recursive: true });
    writeFileSync(join(attackerRoot, "dist/pnpm.cjs"), "attacker bundle\n");
    symlinkSync("../attacker", packageLinkPath);

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow("outside the canonical package layout");
  });

  it("snapshots hosted package-store hardlinks behind a valid PATH shim", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath } = pnpmActionSetupRuntime(root);

    const runtime = captureReleaseClaimCiRuntime({
      execPath: nodePath,
      env: {
        PATH: dirname(launcherPath),
        GITHUB_OUTPUT: join(root, "github-output"),
      },
    });
    expect(runtime.pnpmEntryPath).toBe(realpathSync(pnpmSnapshotPath(root)));
    expect(lstatSync(runtime.pnpmEntryPath).nlink).toBe(1);
  });

  it("rejects a hard-linked node runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath } = pnpmRuntime(root);
    linkSync(nodePath, `${nodePath}.hardlink`);

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow("single-link regular file");
  });

  it("snapshots a hard-linked delegated pnpm bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath, entryPath } = pnpmRuntime(root);
    linkSync(entryPath, `${entryPath}.hardlink`);

    const runtime = captureReleaseClaimCiRuntime({
      execPath: nodePath,
      env: {
        PATH: dirname(launcherPath),
        GITHUB_OUTPUT: join(root, "github-output"),
      },
    });
    expect(runtime.pnpmEntryPath).toBe(realpathSync(pnpmSnapshotPath(root)));
    expect(lstatSync(runtime.pnpmEntryPath).nlink).toBe(1);
  });

  it("refuses to replace an existing runtime snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const { launcherPath } = pnpmRuntime(root);
    writeFileSync(pnpmSnapshotPath(root), "preexisting bytes\n");

    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: dirname(launcherPath),
          GITHUB_OUTPUT: join(root, "github-output"),
        },
      }),
    ).toThrow(/EEXIST/u);
    expect(readFileSync(pnpmSnapshotPath(root), "utf8")).toBe(
      "preexisting bytes\n",
    );
  });

  it("rejects relative and non-executable PATH candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
    roots.push(root);
    const nodePath = executable(root, "node", "node runtime\n");
    const pnpmPath = join(root, "bin/pnpm");
    mkdirSync(dirname(pnpmPath), { recursive: true });
    writeFileSync(pnpmPath, "not executable\n");
    expect(() =>
      captureReleaseClaimCiRuntime({
        execPath: nodePath,
        env: {
          PATH: `relative${delimiter}${dirname(pnpmPath)}`,
          GITHUB_OUTPUT: "unused",
        },
      }),
    ).toThrow("pnpm was not found");
  });

  it.each(["node;touch-owned", "node\nforged-output=value"])(
    "rejects shell or workflow-output metacharacters in %s",
    (name) => {
      const root = mkdtempSync(join(tmpdir(), "skytwin-runtime-capture-"));
      roots.push(root);
      const nodePath = executable(root, name, "node runtime\n");
      const { launcherPath } = pnpmRuntime(root);
      expect(() =>
        captureReleaseClaimCiRuntime({
          execPath: nodePath,
          env: {
            PATH: dirname(launcherPath),
            GITHUB_OUTPUT: join(root, "github-output"),
          },
        }),
      ).toThrow("node must resolve to a safe absolute path");
      expect(() => readFileSync(join(root, "github-output"))).toThrow();
    },
  );
});
