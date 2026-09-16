import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSourceCandidate,
  parseArguments,
} from "../source-candidate/create-source-candidate.mjs";

const cleanup = [];
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function git(root, args, env = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture() {
  const holder = mkdtempSync(join(tmpdir(), "skytwin-source-candidate-"));
  cleanup.push(holder);
  const root = join(holder, "repository");
  const outputs = join(holder, "outputs");
  mkdirSync(root);
  mkdirSync(outputs);
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Source Candidate Test"]);
  git(root, ["config", "user.email", "source-candidate@example.invalid"]);
  writeFileSync(join(root, "README.md"), "fixture source\n", "utf8");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "run"), "#!/bin/sh\necho fixture\n", "utf8");
  chmodSync(join(root, "bin", "run"), 0o755);
  symlinkSync("README.md", join(root, "README-link"));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"], {
    GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
    GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
  });
  return {
    holder,
    root,
    outputs,
    commit: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("internal source candidate packager", () => {
  it("emits byte-identical source-only materials for one exact commit and tree", async () => {
    const item = fixture();
    const firstDirectory = join(item.outputs, "first");
    const secondDirectory = join(item.outputs, "second");
    const first = await createSourceCandidate({
      root: item.root,
      commit: item.commit,
      outputDirectory: firstDirectory,
    });
    const second = await createSourceCandidate({
      root: item.root,
      commit: item.commit,
      outputDirectory: secondDirectory,
    });

    expect(first.commit).toBe(item.commit);
    expect(first.tree).toBe(item.tree);
    expect(second.archiveSha256).toBe(first.archiveSha256);
    for (const name of [
      first.archiveName,
      "CANDIDATE-NOTES.md",
      "source-manifest.json",
      "SHA256SUMS",
    ]) {
      expect(readFileSync(join(firstDirectory, name))).toEqual(
        readFileSync(join(secondDirectory, name)),
      );
    }

    const manifest = JSON.parse(
      readFileSync(join(firstDirectory, "source-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "internal-source-candidate",
      publicRelease: false,
      sourceOnly: true,
      commit: item.commit,
      tree: item.tree,
      archive: {
        name: first.archiveName,
        sha256: first.archiveSha256,
      },
    });
    expect(manifest.files).toEqual([
      expect.objectContaining({ path: "README-link", mode: "120000" }),
      expect.objectContaining({ path: "README.md", mode: "100644" }),
      expect.objectContaining({ path: "bin/run", mode: "100755" }),
    ]);

    const members = execFileSync(
      "tar",
      ["-tzf", join(firstDirectory, first.archiveName)],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const prefix = `skytwin-source-candidate-${item.commit.slice(0, 12)}/`;
    expect(members).toContain(`${prefix}README.md`);
    expect(members).toContain(`${prefix}bin/run`);
    expect(members.some((member) => member.includes("/.git"))).toBe(false);
    expect(
      members
        .filter((member) => member !== prefix && !member.endsWith("/"))
        .map((member) => member.slice(prefix.length))
        .sort(),
    ).toEqual(manifest.files.map(({ path }) => path).sort());

    const checksums = readFileSync(join(firstDirectory, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n");
    expect(checksums).toHaveLength(3);
    for (const line of checksums) {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/);
      expect(match).not.toBeNull();
      expect(sha256(join(firstDirectory, match[2]))).toBe(match[1]);
    }

    const notes = readFileSync(
      join(firstDirectory, "CANDIDATE-NOTES.md"),
      "utf8",
    );
    expect(notes).toContain("This is not a public release.");
    expect(notes).toContain("without a Google or Microsoft account");
    expect(notes).toContain(
      "does not mean whole-application offline or no-network",
    );
    expect(notes).toContain("Verified-private inference is unavailable");
    expect(notes).toContain("SKYTWIN_SOURCE_ARCHIVE=true ./install.sh");
    expect(notes).toContain(
      "beta claim ledger remains authoritative and blocked",
    );
  });

  it("refuses dirty, hidden, and non-exact checkout state", async () => {
    const item = fixture();
    const output = (name) => join(item.outputs, name);

    writeFileSync(join(item.root, "untracked.txt"), "dirty\n", "utf8");
    await expect(
      createSourceCandidate({
        root: item.root,
        commit: item.commit,
        outputDirectory: output("untracked"),
      }),
    ).rejects.toThrow("clean checkout");
    rmSync(join(item.root, "untracked.txt"));

    writeFileSync(join(item.root, "README.md"), "changed source\n", "utf8");
    await expect(
      createSourceCandidate({
        root: item.root,
        commit: item.commit,
        outputDirectory: output("tracked"),
      }),
    ).rejects.toThrow("clean checkout");
    writeFileSync(join(item.root, "README.md"), "fixture source\n", "utf8");

    git(item.root, ["update-index", "--assume-unchanged", "README.md"]);
    await expect(
      createSourceCandidate({
        root: item.root,
        commit: item.commit,
        outputDirectory: output("hidden"),
      }),
    ).rejects.toThrow("assume-unchanged");
    git(item.root, ["update-index", "--no-assume-unchanged", "README.md"]);

    await expect(
      createSourceCandidate({
        root: item.root,
        commit: "0".repeat(40),
        outputDirectory: output("wrong-commit"),
      }),
    ).rejects.toThrow("does not match checkout HEAD");
    await expect(
      createSourceCandidate({
        root: item.root,
        commit: "v0.7.0-beta",
        outputDirectory: output("tag"),
      }),
    ).rejects.toThrow("refs and tags are refused");
  });

  it("keeps generated materials outside the checkout and has no publication options", async () => {
    const item = fixture();
    await expect(
      createSourceCandidate({
        root: item.root,
        commit: item.commit,
        outputDirectory: join(item.root, "candidate"),
      }),
    ).rejects.toThrow("outside the source checkout");

    expect(() =>
      parseArguments([
        "--commit",
        item.commit,
        "--output-dir",
        join(item.outputs, "candidate"),
        "--publish",
      ]),
    ).toThrow("unknown argument: --publish");
    expect(() =>
      parseArguments([
        "--commit",
        item.commit,
        "--output-dir",
        join(item.outputs, "candidate"),
        "--label",
        "latest-beta-ready-binary-release",
      ]),
    ).toThrow("unknown argument: --label");
  });

  it("refuses Git archive transformations that would diverge from the file manifest", async () => {
    const item = fixture();
    writeFileSync(
      join(item.root, ".gitattributes"),
      "README.md export-ignore\n",
      "utf8",
    );
    git(item.root, ["add", ".gitattributes"]);
    git(item.root, ["commit", "-m", "add archive transformation"]);
    const transformedCommit = git(item.root, ["rev-parse", "HEAD"]);

    await expect(
      createSourceCandidate({
        root: item.root,
        commit: transformedCommit,
        outputDirectory: join(item.outputs, "transformed"),
      }),
    ).rejects.toThrow("refuses export-ignore archive transformation");
  });

  it("keeps the one-command installer on the account-free development route", () => {
    const installer = readFileSync(join(sourceRoot, "install.sh"), "utf8");
    expect(installer).toContain("Just show me around");
    expect(installer).toContain("unsupported source-development experiment");
    expect(installer).not.toContain("Set up Google access");
    expect(installer).not.toContain("Continue with Google");
    expect(installer).not.toContain("Google OAuth Client ID");
  });

  it("installs the extracted archive in place without Git or moving main", () => {
    const holder = mkdtempSync(join(tmpdir(), "skytwin-archive-install-"));
    cleanup.push(holder);
    const staging = join(holder, "staging");
    const extracted = join(holder, "extracted");
    const archivePath = join(holder, "archive-path");
    const decoyInstall = join(holder, "must-not-be-used");
    const marker = join(holder, "archive-source-used");
    const archive = join(holder, "candidate.tar.gz");
    mkdirSync(join(staging, "bin"), { recursive: true });
    mkdirSync(extracted);
    mkdirSync(archivePath);
    for (const command of ["dirname", "grep", "ls", "uname"]) {
      const executable = (process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => resolve(directory, command))
        .find((candidate) => existsSync(candidate));
      if (!executable) {
        throw new Error(`test prerequisite is unavailable: ${command}`);
      }
      symlinkSync(executable, join(archivePath, command));
    }
    copyFileSync(join(sourceRoot, "install.sh"), join(staging, "install.sh"));
    chmodSync(join(staging, "install.sh"), 0o755);
    writeFileSync(
      join(staging, "bin", "skytwin-install"),
      '#!/bin/sh\nprintf "%s\\n" archive > "$ARCHIVE_TEST_MARKER"\nexit 23\n',
      "utf8",
    );
    chmodSync(join(staging, "bin", "skytwin-install"), 0o755);
    execFileSync("tar", ["-czf", archive, "-C", staging, "."]);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);

    const result = spawnSync("/bin/bash", ["./install.sh"], {
      cwd: extracted,
      encoding: "utf8",
      env: {
        PATH: archivePath,
        HOME: join(holder, "home"),
        SKYTWIN_INSTALL_DIR: decoyInstall,
        SKYTWIN_SOURCE_ARCHIVE: "true",
        ARCHIVE_TEST_MARKER: marker,
      },
    });

    const gitProbe = spawnSync("/bin/sh", ["-c", "command -v git"], {
      env: { PATH: archivePath },
    });
    expect(gitProbe.status).not.toBe(0);
    expect(result.status).toBe(23);
    expect(readFileSync(marker, "utf8")).toBe("archive\n");
    expect(existsSync(decoyInstall)).toBe(false);
    expect(result.stdout).toContain("Using immutable source archive in place");
    expect(result.stdout).not.toContain("pulling latest");
    expect(result.stdout).not.toContain("Cloned");
  });
});
