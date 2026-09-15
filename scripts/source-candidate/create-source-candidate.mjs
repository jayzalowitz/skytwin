import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import { execFileSync, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const GIT_ENV = Object.freeze({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
});

function git(root, args, options = {}) {
  const result = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: GIT_ENV,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return Buffer.isBuffer(result) ? result : result.trim();
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function sha256File(path) {
  const hash = createHash("sha256");
  const bytes = readFileSync(path);
  hash.update(bytes);
  return hash.digest("hex");
}

function assertExactCleanCheckout(root, commit) {
  if (!FULL_COMMIT.test(commit)) {
    throw new Error(
      "--commit must be an exact lowercase 40-character commit SHA; refs and tags are refused",
    );
  }

  const repositoryRoot = realpathSync(
    git(root, ["rev-parse", "--show-toplevel"]),
  );
  const head = git(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head !== commit) {
    throw new Error(
      `requested commit ${commit} does not match checkout HEAD ${head}`,
    );
  }
  if (git(repositoryRoot, ["cat-file", "-t", commit]) !== "commit") {
    throw new Error(`${commit} is not a commit object`);
  }

  const status = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status !== "") {
    throw new Error(
      "source candidate requires a clean checkout with no untracked files",
    );
  }

  const flagged = git(repositoryRoot, ["ls-files", "-v", "-z"], {
    encoding: "buffer",
  });
  for (const record of flagged.toString("utf8").split("\0")) {
    if (record !== "" && record[0] !== "H") {
      throw new Error(
        "source candidate refuses skip-worktree or assume-unchanged index entries",
      );
    }
  }

  const tree = git(repositoryRoot, ["rev-parse", `${commit}^{tree}`]);
  const indexTree = git(repositoryRoot, ["write-tree"]);
  if (indexTree !== tree) {
    throw new Error("checkout index does not match the requested commit tree");
  }

  return { repositoryRoot, head, tree };
}

function readTrackedFiles(root, commit) {
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--long", "--full-tree", commit],
    {
      cwd: root,
      encoding: "buffer",
      env: GIT_ENV,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const files = [];
  for (const record of output.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("unexpected git ls-tree record");
    const metadata = record
      .slice(0, tab)
      .match(/^([0-9]{6}) (blob|commit) ([0-9a-f]{40,64}) +([0-9-]+)$/);
    if (!metadata) throw new Error("unexpected git ls-tree metadata");
    if (metadata[2] !== "blob") {
      throw new Error("source candidates refuse gitlinks/submodules");
    }
    files.push({
      path: record.slice(tab + 1),
      mode: metadata[1],
      gitObject: metadata[3],
      bytes: Number(metadata[4]),
    });
  }
  return files;
}

function assertArchiveMatchesTrackedFiles(root, files) {
  const input = Buffer.from(`${files.map(({ path }) => path).join("\0")}\0`);
  const output = execFileSync(
    "git",
    [
      "check-attr",
      "--cached",
      "-z",
      "--stdin",
      "export-ignore",
      "export-subst",
    ],
    {
      cwd: root,
      encoding: "buffer",
      env: GIT_ENV,
      input,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const fields = output.toString("utf8").split("\0");
  fields.pop();
  if (fields.length !== files.length * 6) {
    throw new Error("unexpected git attribute inventory");
  }
  for (let index = 0; index < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3);
    if (value !== "unspecified" && value !== "unset") {
      throw new Error(
        `source candidate refuses ${attribute} archive transformation for ${path}`,
      );
    }
  }
}

async function writeDeterministicArchive({ root, commit, prefix, outputPath }) {
  const archive = spawn(
    "git",
    ["archive", "--format=tar", `--prefix=${prefix}/`, commit],
    {
      cwd: root,
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  archive.stderr.setEncoding("utf8");
  archive.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    archive.once("error", rejectExit);
    archive.once("close", (code, signal) => {
      if (code === 0) resolveExit();
      else {
        rejectExit(
          new Error(
            `git archive failed (${signal ?? code}): ${stderr.trim() || "no diagnostic"}`,
          ),
        );
      }
    });
  });

  const results = await Promise.allSettled([
    pipeline(
      archive.stdout,
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    ),
    exited,
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

function candidateNotes({ commit, tree, archiveName, archiveSha256 }) {
  return `# SkyTwin internal source candidate

This is not a public release. It is a source-only evaluation snapshot and does
not contain supported installers or executable application packages.

## Immutable identity

- Commit: \`${commit}\`
- Tree: \`${tree}\`
- Archive: \`${archiveName}\`
- Archive SHA-256: \`${archiveSha256}\`

Verify \`SHA256SUMS\` before extracting. The archive has no \`.git\` directory,
so \`./install.sh\` uses these exact source bytes instead of following moving
\`main\`.

## Evaluation boundary

- The development demo can be explored without a Google or Microsoft account.
  Real-account connectors are not part of this evaluation path. The retained
  Google implementation is available only through an explicit, unsupported
  source-development experiment.
- A local model and compatible llama.cpp runtime are separate prerequisites;
  they are not bundled. Hosted providers remain an explicit opt-in.
- “Local-first” does not mean whole-application offline or no-network. Setup may
  download public dependencies, and configured providers, connectors, updates,
  model downloads, or diagnostics can use the network.
- Verified-private inference is unavailable until a production
  attestation-backed provider and verifier are wired. This snapshot makes no
  claim that confidential inference is available.
- The beta claim ledger remains authoritative and blocked. This snapshot does
  not change any claim state, platform support state, or stop-ship condition.

## Install the snapshot

\`\`\`bash
shasum -a 256 -c SHA256SUMS
tar -xzf ${archiveName}
cd ${prefixFromArchiveName(archiveName)}
SKYTWIN_SOURCE_ARCHIVE=true ./install.sh
\`\`\`

The installer needs network access for any missing public prerequisites. Use
“Just show me around” after seeding to enter the account-free development demo.
`;
}

function prefixFromArchiveName(archiveName) {
  return archiveName.replace(/\.tar\.gz$/, "");
}

export function parseArguments(argv) {
  const parsed = { commit: null, outputDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--commit") parsed.commit = argv[++index] ?? null;
    else if (argument === "--output-dir") {
      parsed.outputDirectory = argv[++index] ?? null;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!parsed.commit || !parsed.outputDirectory) {
    throw new Error("usage: --commit <full SHA> --output-dir <new directory>");
  }
  return parsed;
}

export async function createSourceCandidate({
  root = process.cwd(),
  commit,
  outputDirectory,
}) {
  const identity = assertExactCleanCheckout(root, commit);
  const unresolvedOutput = isAbsolute(outputDirectory)
    ? resolve(outputDirectory)
    : resolve(identity.repositoryRoot, outputDirectory);
  if (existsSync(unresolvedOutput)) {
    throw new Error("output directory must not already exist");
  }
  const outputParent = realpathSync(dirname(unresolvedOutput));
  if (!statSync(outputParent).isDirectory()) {
    throw new Error("output parent must be a directory");
  }
  const requestedOutput = join(outputParent, basename(unresolvedOutput));
  if (isInside(identity.repositoryRoot, requestedOutput)) {
    throw new Error("output directory must be outside the source checkout");
  }

  const shortCommit = commit.slice(0, 12);
  const candidateName = `skytwin-source-candidate-${shortCommit}`;
  const archiveName = `${candidateName}.tar.gz`;
  const archivePath = join(requestedOutput, archiveName);
  const trackedFiles = readTrackedFiles(identity.repositoryRoot, commit);
  assertArchiveMatchesTrackedFiles(identity.repositoryRoot, trackedFiles);
  mkdirSync(requestedOutput, { mode: 0o700 });

  try {
    await writeDeterministicArchive({
      root: identity.repositoryRoot,
      commit,
      prefix: candidateName,
      outputPath: archivePath,
    });
    const archiveSha256 = sha256File(archivePath);
    const manifest = {
      schemaVersion: 1,
      kind: "internal-source-candidate",
      publicRelease: false,
      sourceOnly: true,
      commit,
      tree: identity.tree,
      objectFormat: git(identity.repositoryRoot, [
        "rev-parse",
        "--show-object-format",
      ]),
      archive: {
        name: archiveName,
        prefix: `${candidateName}/`,
        sha256: archiveSha256,
      },
      files: trackedFiles,
    };
    const manifestPath = join(requestedOutput, "source-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const notesPath = join(requestedOutput, "CANDIDATE-NOTES.md");
    writeFileSync(
      notesPath,
      candidateNotes({
        commit,
        tree: identity.tree,
        archiveName,
        archiveSha256,
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );

    const checksumEntries = [
      archiveName,
      "CANDIDATE-NOTES.md",
      "source-manifest.json",
    ]
      .sort()
      .map((name) => `${sha256File(join(requestedOutput, name))}  ${name}`);
    writeFileSync(
      join(requestedOutput, "SHA256SUMS"),
      `${checksumEntries.join("\n")}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );

    return {
      outputDirectory: requestedOutput,
      commit,
      tree: identity.tree,
      archiveName,
      archiveSha256,
    };
  } catch (error) {
    rmSync(requestedOutput, { recursive: true, force: true });
    throw error;
  }
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await createSourceCandidate(options);
    process.stdout.write(
      `Created internal source candidate at ${result.outputDirectory}\n` +
        `Commit: ${result.commit}\nTree: ${result.tree}\n` +
        `Archive SHA-256: ${result.archiveSha256}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Source candidate creation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
