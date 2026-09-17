#!/usr/bin/env node

import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashStableRegularFile,
  readStableRegularFile,
} from "./file-integrity.mjs";
import {
  readArtifactManifest,
  verifyReleaseManifest,
} from "./verify-release-manifest.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    const name = key.slice(2);
    if (Object.hasOwn(result, name)) throw new Error(`duplicate --${name}`);
    result[name] = value;
  }
  for (const name of ["manifest", "bundle", "output"])
    if (!result[name]) throw new Error(`missing --${name}`);
  return result;
}

function assertJsonLines(bytes) {
  const lines = bytes
    .toString("utf8")
    .split(/\r?\n/gu)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("attestation bundle is empty");
  for (const line of lines) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("attestation bundle is not valid JSONL");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("attestation bundle JSONL entries must be objects");
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildVerificationInstructions({
  subjects,
  repository,
  sourceCommit,
  sourceRef,
}) {
  const orderedSubjects = [...subjects].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const commands = orderedSubjects.map(
    (subject) =>
      `gh attestation verify ${shellQuote(subject.name)} --repo ${shellQuote(repository)} --bundle ${shellQuote(`${subject.sha256}.attestation.jsonl`)} --source-digest ${shellQuote(sourceCommit)} --source-ref ${shellQuote(sourceRef)} --signer-workflow ${shellQuote(`github.com/${repository}/.github/workflows/build.yml`)} --predicate-type ${shellQuote("https://slsa.dev/provenance/v1")}`,
  );
  const windowsInstaller =
    orderedSubjects.find((subject) => subject.name.endsWith(".exe"))?.name ??
    "<missing Windows installer>";
  return `# Verify SkyTwin release artifacts

Download every release asset into one directory with these verification files.

## SHA-256 checksums

On Linux:

\`\`\`sh
sha256sum --check SHA256SUMS
\`\`\`

On macOS:

\`\`\`sh
shasum --algorithm 256 --check SHA256SUMS
\`\`\`

## GitHub build provenance

Run every command below from that directory:

\`\`\`sh
${commands.join("\n")}
\`\`\`

## Platform signature status

Artifact signing and macOS notarization are currently unavailable because the
release credentials are not configured. The checksum and provenance checks
above do not satisfy this separate public-beta stop-ship gate.

### macOS

After mounting the DMG and installing the app in Applications, run:

\`\`\`sh
codesign --verify --deep --strict --verbose=2 '/Applications/SkyTwin.app'
spctl --assess --type execute --verbose=2 '/Applications/SkyTwin.app'
xcrun stapler validate '/Applications/SkyTwin.app'
\`\`\`

These commands are expected to fail until Developer ID signing and notarization
are configured and the macOS signing evidence report passes.

### Windows

In PowerShell, run:

\`\`\`powershell
$signature = Get-AuthenticodeSignature -LiteralPath '.\\${windowsInstaller}'
if ($signature.Status -ne 'Valid') { $signature | Format-List; exit 1 }
\`\`\`

This check is expected to fail until Authenticode credentials are configured
and the Windows signing evidence report passes.

### Linux

No platform-native package-signature policy is configured yet. Use the SHA-256
and GitHub provenance checks above for integrity only; Linux remains unsupported
for the public beta until its signing evidence report proves the selected
distribution policy.
`;
}

export function materializeAttestationBundles({
  manifest: manifestPath,
  bundle,
  output,
  testHooks,
}) {
  const absoluteManifest = resolve(manifestPath);
  const manifestRoot = dirname(absoluteManifest);
  const outputDirectory = resolve(output);
  if (outputDirectory !== join(manifestRoot, "artifact-verification"))
    throw new Error(
      "artifact verification output must be the manifest root's canonical artifact-verification directory",
    );
  const outputStat = lstatSync(outputDirectory, { bigint: true });
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink())
    throw new Error("artifact verification output must be a real directory");
  verifyReleaseManifest({ root: manifestRoot, manifest: absoluteManifest });
  const manifest = readArtifactManifest(manifestRoot, absoluteManifest);

  const absoluteBundle = resolve(bundle);
  const source = readStableRegularFile(
    dirname(absoluteBundle),
    absoluteBundle,
    { ...testHooks?.bundle, maxBytes: 64 * 1024 * 1024 },
  );
  assertJsonLines(source.bytes);
  const digests = [
    ...new Set(manifest.assets.map((asset) => asset.sha256)),
  ].sort();
  const targets = [
    "VERIFY.md",
    ...digests.map((digest) => `${digest}.attestation.jsonl`),
  ];
  for (const name of targets) {
    if (existsSync(join(outputDirectory, name)))
      throw new Error(
        `refusing to overwrite artifact verification material ${name}`,
      );
  }

  const instructions = buildVerificationInstructions({
    subjects: manifest.assets.map((asset) => ({
      name: asset.filename,
      sha256: asset.sha256,
    })),
    repository: manifest.repository,
    sourceCommit: manifest.sourceCommit,
    sourceRef: manifest.sourceRef,
  });
  writeFileSync(join(outputDirectory, "VERIFY.md"), instructions, {
    flag: "wx",
  });
  for (const digest of digests) {
    const name = `${digest}.attestation.jsonl`;
    const path = join(outputDirectory, name);
    writeFileSync(path, source.bytes, { flag: "wx", mode: 0o644 });
    const observed = hashStableRegularFile(outputDirectory, path);
    if (
      observed.sha1 !== source.sha1 ||
      observed.sha256 !== source.sha256 ||
      observed.sha512 !== source.sha512 ||
      observed.size !== source.size
    )
      throw new Error(`${name} changed while materializing`);
  }
  return { subjects: manifest.assets.length, bundles: digests.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = materializeAttestationBundles({
    manifest: args.manifest,
    bundle: args.bundle,
    output: args.output,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
