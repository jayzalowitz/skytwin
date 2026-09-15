import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
      pnpmEntryPath: realpathSync(entryPath),
      pnpmEntrySha256: createHash("sha256")
        .update(readFileSync(entryPath))
        .digest("hex"),
    });
    expect(appendOutput).toHaveBeenCalledOnce();
    expect(appendOutput.mock.calls[0][1]).toContain(
      `node-path=${realpathSync(nodePath)}\n`,
    );
    expect(appendOutput.mock.calls[0][1]).toContain(
      `pnpm-entry-path=${realpathSync(entryPath)}\n`,
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
    expect(runtime.pnpmEntryPath).toBe(realpathSync(entryPath));
    expect(runtime.pnpmEntrySha256).not.toBe(
      createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
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
