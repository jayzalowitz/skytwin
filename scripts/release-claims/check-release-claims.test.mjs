import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_VERIFICATION_DIRECTORY,
  ARTIFACT_VERIFICATION_RELEASE_PATTERN,
  CANONICAL_ARTIFACT_VERIFICATION_ASSETS,
  CANONICAL_CI_EVIDENCE_CHECKS,
  CANONICAL_CI_EVIDENCE_COMMANDS,
  CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  CANONICAL_MACHINE_EVIDENCE_CHECKS,
  CANONICAL_MACHINE_EVIDENCE_MATRIX,
  CANONICAL_MACHINE_VERIFIER_STEP,
  CANONICAL_RELEASE_ASSETS,
  CANONICAL_RELEASE_SAFETY_ASSET_PATHS,
  MAX_RELEASE_CLAIM_OBSERVED_CODE_UNITS,
  RELEASE_ARTIFACT_GENERATOR_PATH,
  RELEASE_ARTIFACT_MANIFEST_PATH,
  RELEASE_ARTIFACT_MATERIALS_ARTIFACT,
  RELEASE_ARTIFACT_MATERIALS_DIRECTORY,
  RELEASE_ARTIFACT_STAGING_DIRECTORY,
  RELEASE_ARTIFACT_VALIDATOR_PATH,
  RELEASE_ATTESTATION_MATERIALIZER_PATH,
  RELEASE_CLAIM_CI_CONSTANTS_PATH,
  RELEASE_CLAIM_CI_ARTIFACT_FILES,
  RELEASE_CLAIM_CI_HARNESS_PATH,
  RELEASE_CLAIM_CI_LEDGER_PATH,
  RELEASE_CLAIM_CI_PRODUCER_STEP,
  RELEASE_CLAIM_CI_READINESS_STEP,
  RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH,
  RELEASE_CLAIM_CI_SOURCE_PATHS,
  RELEASE_CLAIM_CI_UPLOAD_STEP,
  RELEASE_SAFETY_EVIDENCE_STEP,
  machineProducerJobName,
  machineVerifierCommand,
  machineVerifierPath,
  CANONICAL_RELEASE_EVIDENCE_RUN,
  CANONICAL_UPDATE_FEED_RUN,
  REQUIRED_CATEGORIES,
  REQUIRED_READINESS_CLAIM_IDS,
  REQUIRED_STOP_SHIP_IDS,
  REQUIRED_SURFACE_CLASSES,
  buildCanonicalVerificationInstructions,
  hasCanonicalSuccessfulMachineSteps,
  isArtifactCreationWithinProducerWindow,
  isValidSigningSourceReportArtifact,
  isValidSigningUploadBinding,
  canonicalReleaseClaimCiJobSteps,
  isAllowlistedVerificationCommand,
  isValidSpdx23Document,
  normalizeReleaseTagToRepositoryVersion,
  readPublicationEvidenceManifest,
  runChecks,
  runPublicationChecks,
  runPublicationPreflight,
  scanProhibitedClaims,
  validateLedgerShape,
  verifyApprovedStatements,
  verifyArtifactVerificationMaterials,
  verifyCanonicalReleasePublisher,
  verifyGitHubArtifactAttestation,
  verifyMachineEvidenceApplicability,
  machineReportNamesForClaim,
  verifyPublicationEvidence,
  verifyReleaseVersionBinding,
  verifyVersionSources,
} from "./check-release-claims.mjs";

const temporaryRoots = [];
const EVIDENCE = "evidence\n";
const EVIDENCE_SHA256 = createHash("sha256").update(EVIDENCE).digest("hex");
const ATTEMPT_STARTED_AT = "2026-09-15T01:00:00Z";

function signingProducerFields(artifactId, artifactName, platform) {
  const producerNames = {
    macos: "Desktop — macOS (DMG + ZIP)",
    windows: "Desktop — Windows (NSIS installer)",
  };
  const uploadNames = {
    "SkyTwin-macOS-dmg": "Upload macOS DMG",
    "SkyTwin-macOS-zip": "Upload macOS ZIP",
    "SkyTwin-Windows-installer": "Upload Windows installer",
  };
  return {
    artifactCreatedAt: "2026-09-15T01:05:00Z",
    artifactUpdatedAt: "2026-09-15T01:05:00Z",
    artifactProducerJobId: 500,
    artifactProducerJobName: producerNames[platform],
    artifactProducerRunAttempt: 2,
    artifactProducerJobConclusion: "success",
    artifactProducerJobStartedAt: "2026-09-15T01:01:00Z",
    artifactProducerJobCompletedAt: "2026-09-15T01:10:00Z",
    artifactUploadStepName: uploadNames[artifactName],
    artifactUploadStepStartedAt: "2026-09-15T01:04:00Z",
    artifactUploadStepCompletedAt: "2026-09-15T01:06:00Z",
  };
}
const FIXTURE_RELEASE_SOURCE = "export {};\n";
const FIXTURE_RELEASE_SOURCE_SHA256 = createHash("sha256")
  .update(FIXTURE_RELEASE_SOURCE)
  .digest("hex");
const productionLedger = JSON.parse(
  readFileSync(
    new URL("../../docs/beta-claim-ledger.json", import.meta.url),
    "utf8",
  ),
);
const CLAIM_CATEGORIES = new Map([
  ["license.apache-2", "open-source"],
  ["storage.desktop-crdb", "local-storage"],
  ["encryption.oauth-default", "encryption"],
  ["encryption.twin-state-default", "encryption"],
  ["inference.on-device-availability", "inference"],
  ["inference.confidential-verification", "inference"],
  ["network.explicit-boundaries", "network-use"],
  ["sample.packaged-account-free", "sample-mode"],
  ["connectors.account-free-boundary", "connectors"],
  ["models.verified-delivery", "model-delivery"],
  ["safety.policy-and-provenance", "action-safety"],
  ["safety.explanation-coverage", "action-safety"],
  ["release.signing", "signing"],
  ["release.artifact-verification", "artifact-verification"],
]);

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "skytwin-claims-"));
  temporaryRoots.push(root);
  return root;
}

function write(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

function replaceLast(content, needle, replacement) {
  const index = content.lastIndexOf(needle);
  if (index === -1) return content;
  return `${content.slice(0, index)}${replacement}${content.slice(index + needle.length)}`;
}

function replaceInReleaseSafetyStep(workflow, needle, replacement) {
  const start = workflow.indexOf(
    `      - name: ${RELEASE_SAFETY_EVIDENCE_STEP}\n`,
  );
  const end = workflow.indexOf(
    `      - name: ${RELEASE_CLAIM_CI_PRODUCER_STEP}\n`,
    start,
  );
  if (start < 0 || end < 0) throw new Error("release safety step is missing");
  const step = workflow.slice(start, end);
  const mutated = step.replace(needle, replacement);
  if (mutated === step)
    throw new Error("release safety mutation did not apply");
  return `${workflow.slice(0, start)}${mutated}${workflow.slice(end)}`;
}

function makeReleaseAssets(root, startId = 1000) {
  return CANONICAL_RELEASE_ASSETS.map(([artifactName, kind], index) => {
    const name = `${artifactName}.fixture`;
    const path = `artifacts/${artifactName}/${name}`;
    const content = `fixture release subject ${artifactName}\n`;
    write(root, path, content);
    return {
      artifactId: startId + index,
      artifactName,
      artifactSha256: index.toString(16).padStart(64, "0"),
      kind,
      subjects: [
        {
          name,
          path,
          sha256: createHash("sha256").update(content).digest("hex"),
          sizeBytes: Buffer.byteLength(content),
        },
      ],
    };
  });
}

function makeVerificationAssets(
  root,
  releaseAssets,
  {
    repository = "owner/repository",
    sourceCommit = "0123456789abcdef0123456789abcdef01234567",
    sourceRef = "refs/tags/v0.7.0-beta",
  } = {},
) {
  const subjects = releaseAssets.flatMap((asset) => asset.subjects);
  const packageVerificationCodeValue = createHash("sha1")
    .update(
      subjects
        .map((subject) =>
          createHash("sha1")
            .update(readFileSync(join(root, subject.path)))
            .digest("hex"),
        )
        .sort()
        .join(""),
    )
    .digest("hex");
  const contents = new Map([
    [
      "SHA256SUMS",
      `${subjects.map((subject) => `${subject.sha256}  ${subject.name}`).join("\n")}\n`,
    ],
    [
      "release.spdx.json",
      `${JSON.stringify({
        SPDXID: "SPDXRef-DOCUMENT",
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        name: "SkyTwin release artifacts",
        documentNamespace:
          "https://github.com/owner/repository/releases/tag/v0.7.0-beta/spdx",
        creationInfo: {
          created: "2026-09-14T00:00:00Z",
          creators: ["Tool: SkyTwin release-machine-verifier"],
        },
        documentDescribes: ["SPDXRef-Package"],
        packages: [
          {
            SPDXID: "SPDXRef-Package",
            downloadLocation: "NOASSERTION",
            name: "SkyTwin",
            versionInfo: "0.7.0-beta",
            filesAnalyzed: true,
            packageVerificationCode: { packageVerificationCodeValue },
          },
        ],
        files: subjects.map((subject, index) => ({
          SPDXID: `SPDXRef-ReleaseSubject-${index}`,
          fileName: subject.name,
          checksums: [{ algorithm: "SHA256", checksumValue: subject.sha256 }],
        })),
        relationships: [
          {
            spdxElementId: "SPDXRef-DOCUMENT",
            relationshipType: "DESCRIBES",
            relatedSpdxElement: "SPDXRef-Package",
          },
          ...subjects.map((_, index) => ({
            spdxElementId: "SPDXRef-Package",
            relationshipType: "CONTAINS",
            relatedSpdxElement: `SPDXRef-ReleaseSubject-${index}`,
          })),
        ],
      })}\n`,
    ],
    [
      "VERIFY.md",
      buildCanonicalVerificationInstructions({
        subjects,
        repository,
        sourceCommit,
        sourceRef,
      }),
    ],
  ]);
  for (const subject of subjects)
    contents.set(`${subject.sha256}.attestation.jsonl`, "{}\n");
  const canonical = new Map(CANONICAL_ARTIFACT_VERIFICATION_ASSETS);
  return [...contents].map(([name, content]) => {
    const path = `${ARTIFACT_VERIFICATION_DIRECTORY}/${name}`;
    write(root, path, content);
    return {
      kind: canonical.get(name) ?? "provenance-bundle",
      name,
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function makeArtifactVerificationReport(
  releaseAssets,
  verificationAssets,
  sourceCommit,
) {
  const byPath = new Map(
    verificationAssets.map((asset) => [asset.path, asset]),
  );
  const reference = (path) => ({ path, sha256: byPath.get(path).sha256 });
  return {
    sourceCommit,
    coveredSubjects: releaseAssets.flatMap((asset) =>
      asset.subjects.map((subject) => {
        const checksum = reference(
          `${ARTIFACT_VERIFICATION_DIRECTORY}/SHA256SUMS`,
        );
        const sbom = reference(
          `${ARTIFACT_VERIFICATION_DIRECTORY}/release.spdx.json`,
        );
        const verificationInstructions = reference(
          `${ARTIFACT_VERIFICATION_DIRECTORY}/VERIFY.md`,
        );
        const bundle = reference(
          `${ARTIFACT_VERIFICATION_DIRECTORY}/${subject.sha256}.attestation.jsonl`,
        );
        return {
          path: subject.path,
          sha256: subject.sha256,
          checksum: {
            ...checksum,
            algorithm: "sha256",
            subjectSha256: subject.sha256,
            result: "pass",
          },
          sbom: {
            ...sbom,
            format: "spdx-json",
            subjectSha256: subject.sha256,
            result: "pass",
          },
          provenance: {
            verificationMethod: "gh-attestation-verify",
            bundlePath: bundle.path,
            bundleSha256: bundle.sha256,
            sourceCommit,
            subjectSha256: subject.sha256,
            result: "pass",
          },
          verificationInstructions: {
            ...verificationInstructions,
            subjectSha256: subject.sha256,
            result: "pass",
          },
        };
      }),
    ),
  };
}

function releaseAssetApiBody(asset, runId, commit) {
  return {
    id: asset.artifactId,
    name: asset.artifactName,
    expired: false,
    digest: `sha256:${asset.artifactSha256}`,
    created_at: "2026-09-15T01:05:00Z",
    updated_at: "2026-09-15T01:05:00Z",
    workflow_run: { id: runId, head_sha: commit },
  };
}

function validLedger() {
  const ledger = {
    schemaVersion: 1,
    release: {
      targetVersion: "v0.7.0-beta",
      status: "blocked",
      audience: "technical early adopters",
      releaseSurface: "desktop",
      auditBaseline: structuredClone(productionLedger.release.auditBaseline),
      currentVersionSources: [
        { path: "VERSION", kind: "text" },
        { path: "package.json", kind: "package-json" },
      ],
      platforms: [
        {
          name: "macOS",
          state: "candidate",
          minimumHardware: "unverified",
          evidence: "clean-machine evidence pending",
        },
      ],
      readinessClaims: structuredClone(
        productionLedger.release.readinessClaims,
      ),
      deferredFeatures: ["hosted service"],
      stopShipConditions: structuredClone(
        productionLedger.release.stopShipConditions,
      ),
    },
    claimSurfaces: [
      { class: "root-public", path: "README.md" },
      { class: "root-public", path: "CHANGELOG.md" },
      { class: "root-public", path: "evidence.txt" },
      {
        class: "docs-public",
        path: "docs",
        extensions: [".md", ".html", ".svg", ".css"],
      },
      {
        class: "web-public",
        path: "apps/web/public",
        extensions: [".html", ".js", ".json", ".svg", ".css"],
      },
      {
        class: "desktop-public",
        path: "apps/desktop/src",
        extensions: [".ts", ".js", ".html", ".css", ".svg"],
      },
      {
        class: "mobile-public",
        path: "apps/mobile/src",
        extensions: [".ts", ".tsx", ".js", ".html", ".css", ".svg"],
      },
      { class: "release-metadata", path: "package.json" },
      { class: "release-metadata", path: "VERSION" },
      { class: "release-metadata", path: ".github/workflows/build.yml" },
      { class: "release-templates", path: ".github/PULL_REQUEST_TEMPLATE.md" },
    ],
    prohibitedClaims: structuredClone(productionLedger.prohibitedClaims),
    approvedStatements: structuredClone(productionLedger.approvedStatements),
    staleAssets: structuredClone(productionLedger.staleAssets),
    publicBinaryAssets: structuredClone(productionLedger.publicBinaryAssets),
    binaryAssetAudit: structuredClone(productionLedger.binaryAssetAudit),
    claims: [...CLAIM_CATEGORIES].map(([id, category]) => {
      const canonical = productionLedger.claims.find(
        (claim) => claim.id === id,
      );
      return {
        id,
        category,
        statement: canonical.statement,
        scope: canonical.scope,
        owner: canonical.owner,
        state:
          category === "action-safety" || id === "license.apache-2"
            ? "proven"
            : "limited",
        limitation:
          category === "action-safety" || id === "license.apache-2"
            ? ""
            : "This scope is limited.",
        evidence: [
          {
            path: id === "license.apache-2" ? "LICENSE" : "evidence.txt",
            sha256: EVIDENCE_SHA256,
            why: "test evidence",
          },
          ...(id === "release.artifact-verification"
            ? RELEASE_CLAIM_CI_SOURCE_PATHS.filter(
                (path) => path !== RELEASE_CLAIM_CI_LEDGER_PATH,
              ).map((path) => ({
                path,
                sha256: FIXTURE_RELEASE_SOURCE_SHA256,
                why: "pins a canonical release claim CI source",
              }))
            : []),
        ],
        verification:
          id === "connectors.account-free-boundary"
            ? CANONICAL_CI_EVIDENCE_CHECKS.get(id).map((checkId) => {
                const command = CANONICAL_CI_EVIDENCE_COMMANDS.get(checkId);
                return {
                  command: [command.executable, ...command.args].join(" "),
                  expected: "passes",
                };
              })
            : [
                {
                  command: 'rg -n -- "evidence" evidence.txt',
                  expected: "passes",
                },
              ],
      };
    }),
  };
  return ledger;
}

function writeValidFixture(
  root,
  ledger = validLedger(),
  repositoryVersion = "0.6.102.0",
) {
  write(root, "VERSION", `${repositoryVersion}\n`);
  write(root, "package.json", `{"version":"${repositoryVersion}"}\n`);
  const approvedByPath = new Map();
  for (const statement of ledger.approvedStatements) {
    approvedByPath.set(
      statement.path,
      `${approvedByPath.get(statement.path) ?? ""}${statement.exact}\n`,
    );
  }
  approvedByPath.set(
    "README.md",
    `${approvedByPath.get("README.md") ?? ""}Persistent state is local.\n`,
  );
  for (const [path, content] of approvedByPath) {
    const rendered = path.endsWith(".js")
      ? `const renderedClaimCopy = \`${content.replaceAll("`", "\\`")}\`;\n`
      : content;
    write(root, path, rendered);
  }
  write(
    root,
    "CHANGELOG.md",
    "<!-- release-claims:start -->\nCurrent release status is blocked.\n<!-- release-claims:end -->\nHistorical release text.\n## [Unreleased] — CI unblock\nCurrent changes are scoped.\n## [0.6.101.0] - 2026-07-06\nOlder history.\n",
  );
  for (const path of [
    "apps/desktop/src/placeholder.ts",
    "apps/mobile/src/placeholder.ts",
    ".github/PULL_REQUEST_TEMPLATE.md",
  ]) {
    if (!approvedByPath.has(path)) write(root, path, "Safe release copy.\n");
  }
  const approvedWorkflowLines = (
    approvedByPath.get(".github/workflows/build.yml") ?? ""
  )
    .split("\n")
    .filter(Boolean);
  const identityLine = approvedWorkflowLines.find((line) =>
    line.startsWith("CSC_IDENTITY_AUTO_DISCOVERY:"),
  );
  const evidenceLines = approvedWorkflowLines.filter(
    (line) => line !== identityLine,
  );
  const machineMatrix = CANONICAL_MACHINE_EVIDENCE_MATRIX.map(
    ({ claimId, platform, runner, reportName }) =>
      `          - claimId: ${claimId}\n            platform: ${platform}\n            runner: ${runner}\n            reportName: ${reportName}`,
  ).join("\n");
  const artifactDownloads = CANONICAL_RELEASE_ASSETS.map(
    ([artifactName]) => `      - name: Download ${artifactName}
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          name: ${artifactName}
          path: artifacts/${artifactName}`,
  ).join("\n");
  for (const path of [
    RELEASE_ARTIFACT_GENERATOR_PATH,
    RELEASE_ARTIFACT_VALIDATOR_PATH,
    RELEASE_ATTESTATION_MATERIALIZER_PATH,
    RELEASE_CLAIM_CI_CONSTANTS_PATH,
    RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH,
    RELEASE_CLAIM_CI_HARNESS_PATH,
    "scripts/release-artifacts/file-integrity.test.mjs",
    "scripts/release-artifacts/generate-release-manifest.test.mjs",
    "scripts/release-artifacts/materialize-attestation-bundles.test.mjs",
    "scripts/release-claims/verifiers/release.artifact-verification.mjs",
    ...RELEASE_CLAIM_CI_SOURCE_PATHS.filter(
      (sourcePath) => sourcePath !== RELEASE_CLAIM_CI_LEDGER_PATH,
    ),
  ])
    write(root, path, FIXTURE_RELEASE_SOURCE);
  const workflow = `env:
  ${identityLine}
permissions:
  contents: read
concurrency:
  group: build-\${{ github.ref }}
  cancel-in-progress: \${{ !startsWith(github.ref, 'refs/tags/v') }}
jobs:
  test:
    name: release-claim-ci
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
      - name: Capture release claim CI runtime
        id: capture-release-claim-runtime
        env:
          BASH_ENV: ''
          ENV: ''
          LD_LIBRARY_PATH: ''
          LD_PRELOAD: ''
          NODE_PATH: ''
          NODE_OPTIONS: ''
        shell: /bin/bash --noprofile --norc -eo pipefail {0}
        run: node scripts/release-claims/capture-release-claim-ci-runtime.mjs
      - run: pnpm install --frozen-lockfile
      - name: Test release artifact construction and verification
        env:
          BASH_ENV: ''
          ENV: ''
          LD_LIBRARY_PATH: ''
          LD_PRELOAD: ''
          NODE_PATH: ''
          NODE_OPTIONS: ''
          SKYTWIN_RELEASE_CI_NODE_PATH: \${{ steps.capture-release-claim-runtime.outputs.node-path }}
          SKYTWIN_RELEASE_CI_NODE_SHA256: \${{ steps.capture-release-claim-runtime.outputs.node-sha256 }}
        shell: /bin/bash --noprofile --norc -eo pipefail {0}
        run: |
          /usr/bin/printf '%s  %s\\n' "$SKYTWIN_RELEASE_CI_NODE_SHA256" "$SKYTWIN_RELEASE_CI_NODE_PATH" | /usr/bin/sha256sum --check --strict -
          /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$SKYTWIN_RELEASE_CI_NODE_PATH" node_modules/vitest/vitest.mjs run --passWithNoTests=false scripts/release-artifacts/file-integrity.test.mjs
          /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$SKYTWIN_RELEASE_CI_NODE_PATH" node_modules/vitest/vitest.mjs run --passWithNoTests=false scripts/release-artifacts/generate-release-manifest.test.mjs
          /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$SKYTWIN_RELEASE_CI_NODE_PATH" node_modules/vitest/vitest.mjs run --passWithNoTests=false scripts/release-artifacts/materialize-attestation-bundles.test.mjs
      - name: Produce and verify release safety evidence
        if: always() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
        timeout-minutes: 15
        env:
          BASH_ENV: ''
          COREPACK_HOME: ''
          ENV: ''
          LD_LIBRARY_PATH: ''
          LD_PRELOAD: ''
          NODE_PATH: ''
          NODE_OPTIONS: ''
          PNPM_HOME: ''
          SKYTWIN_RELEASE_CI_NODE_PATH: \${{ steps.capture-release-claim-runtime.outputs.node-path }}
          SKYTWIN_RELEASE_CI_NODE_SHA256: \${{ steps.capture-release-claim-runtime.outputs.node-sha256 }}
          SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH: \${{ steps.capture-release-claim-runtime.outputs.pnpm-entry-path }}
          SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256: \${{ steps.capture-release-claim-runtime.outputs.pnpm-entry-sha256 }}
        shell: /bin/bash --noprofile --norc -eo pipefail {0}
        run: |
          SKYTWIN_RELEASE_CI_NODE_BIN="\${SKYTWIN_RELEASE_CI_NODE_PATH%/*}"
          /usr/bin/test "$SKYTWIN_RELEASE_CI_NODE_BIN/node" -ef "$SKYTWIN_RELEASE_CI_NODE_PATH"
          /usr/bin/printf '%s  %s\\n' "$SKYTWIN_RELEASE_CI_NODE_SHA256" "$SKYTWIN_RELEASE_CI_NODE_PATH" | /usr/bin/sha256sum --check --strict -
          /usr/bin/printf '%s  %s\\n' "$SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256" "$SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH" | /usr/bin/sha256sum --check --strict -
          /usr/bin/env -i PATH="$SKYTWIN_RELEASE_CI_NODE_BIN:/usr/bin:/bin" CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_SHA="$GITHUB_SHA" GITHUB_REF="$GITHUB_REF" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" "$SKYTWIN_RELEASE_CI_NODE_PATH" "$SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH" --filter @skytwin/evals eval:adversarial --output release-claims-ci/adversarial-evidence.json
          /usr/bin/env -i PATH="$SKYTWIN_RELEASE_CI_NODE_BIN:/usr/bin:/bin" CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_SHA="$GITHUB_SHA" GITHUB_REF="$GITHUB_REF" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" "$SKYTWIN_RELEASE_CI_NODE_PATH" scripts/release-evidence/verify-adversarial-evidence.mjs release-claims-ci/adversarial-evidence.json --fixture packages/evals/fixtures/v1/adversarial-scenarios.json --expected-commit "$GITHUB_SHA" --require-clean
          /usr/bin/env -i PATH="$SKYTWIN_RELEASE_CI_NODE_BIN:/usr/bin:/bin" CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_SHA="$GITHUB_SHA" GITHUB_REF="$GITHUB_REF" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" "$SKYTWIN_RELEASE_CI_NODE_PATH" scripts/release-evidence/generate-release-safety-evidence.mjs --adversarial release-claims-ci/adversarial-evidence.json --output release-claims-ci/release-safety-evidence.json
          /usr/bin/env -i PATH="$SKYTWIN_RELEASE_CI_NODE_BIN:/usr/bin:/bin" CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_SHA="$GITHUB_SHA" GITHUB_REF="$GITHUB_REF" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" "$SKYTWIN_RELEASE_CI_NODE_PATH" scripts/release-evidence/verify-release-safety-evidence.mjs --adversarial release-claims-ci/adversarial-evidence.json --report release-claims-ci/release-safety-evidence.json
      - name: Produce release claim CI result
        if: always() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
        timeout-minutes: 15
        env:
          BASH_ENV: ''
          COREPACK_HOME: ''
          ENV: ''
          LD_LIBRARY_PATH: ''
          LD_PRELOAD: ''
          NODE_PATH: ''
          NODE_OPTIONS: ''
          PNPM_HOME: ''
          SKYTWIN_RELEASE_CI_NODE_PATH: \${{ steps.capture-release-claim-runtime.outputs.node-path }}
          SKYTWIN_RELEASE_CI_NODE_SHA256: \${{ steps.capture-release-claim-runtime.outputs.node-sha256 }}
          SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH: \${{ steps.capture-release-claim-runtime.outputs.pnpm-entry-path }}
          SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256: \${{ steps.capture-release-claim-runtime.outputs.pnpm-entry-sha256 }}
        shell: /bin/bash --noprofile --norc -eo pipefail {0}
        run: |
          /usr/bin/printf '%s  %s\\n' "$SKYTWIN_RELEASE_CI_NODE_SHA256" "$SKYTWIN_RELEASE_CI_NODE_PATH" | /usr/bin/sha256sum --check --strict -
          /usr/bin/printf '%s  %s\\n' "$SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256" "$SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH" | /usr/bin/sha256sum --check --strict -
          exec /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_SHA="$GITHUB_SHA" GITHUB_REF="$GITHUB_REF" GITHUB_EVENT_NAME="$GITHUB_EVENT_NAME" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" SKYTWIN_RELEASE_CI_NODE_PATH="$SKYTWIN_RELEASE_CI_NODE_PATH" SKYTWIN_RELEASE_CI_NODE_SHA256="$SKYTWIN_RELEASE_CI_NODE_SHA256" SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH="$SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH" SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256="$SKYTWIN_RELEASE_CI_PNPM_ENTRY_SHA256" "$SKYTWIN_RELEASE_CI_NODE_PATH" scripts/release-claims/run-release-claim-ci.mjs --output release-claims-ci/result.json
      - name: Upload release claim CI result
        if: always() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-claims-ci
          path: |
            release-claims-ci/result.json
            release-claims-ci/adversarial-evidence.json
            release-claims-ci/adversarial-evidence.json.sha256
            release-claims-ci/release-safety-evidence.json
          if-no-files-found: error
          compression-level: 0
      - name: Enforce beta release readiness
        if: always() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: |
          if [[ "\${GITHUB_REF_TYPE}" == "tag" && "\${GITHUB_REF_NAME}" == v* ]]; then
            pnpm claims:check -- --require-ready --preflight --tag "\${GITHUB_REF_NAME}" --commit "\${GITHUB_SHA}" --repository "\${GITHUB_REPOSITORY}" --run-id "\${GITHUB_RUN_ID}" --ref "\${GITHUB_REF}"
          fi
  desktop-mac:
    needs: [test, changes]
    if: github.event_name != 'pull_request' || needs.changes.outputs.desktop == 'true'
    outputs:
      dmg-artifact-id: \${{ steps.upload-macos-dmg.outputs.artifact-id }}
      dmg-artifact-digest: \${{ steps.upload-macos-dmg.outputs.artifact-digest }}
      zip-artifact-id: \${{ steps.upload-macos-zip.outputs.artifact-id }}
      zip-artifact-digest: \${{ steps.upload-macos-zip.outputs.artifact-digest }}
    runs-on: macos-15
    steps:
      - name: Upload macOS DMG
        id: upload-macos-dmg
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: SkyTwin-macOS-dmg
      - name: Upload macOS ZIP
        id: upload-macos-zip
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: SkyTwin-macOS-zip
  desktop-windows:
    needs: [test, changes]
    if: github.event_name != 'pull_request' || needs.changes.outputs.desktop == 'true'
    outputs:
      installer-artifact-id: \${{ steps.upload-windows-installer.outputs.artifact-id }}
      installer-artifact-digest: \${{ steps.upload-windows-installer.outputs.artifact-digest }}
    runs-on: windows-2025
    steps:
      - name: Upload Windows installer
        id: upload-windows-installer
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: SkyTwin-Windows-installer
  desktop-linux:
    needs: [test, changes]
    if: github.event_name != 'pull_request' || needs.changes.outputs.desktop == 'true'
    outputs:
      appimage-artifact-id: \${{ steps.upload-linux-appimage.outputs.artifact-id }}
      appimage-artifact-digest: \${{ steps.upload-linux-appimage.outputs.artifact-digest }}
      deb-artifact-id: \${{ steps.upload-linux-deb.outputs.artifact-id }}
      deb-artifact-digest: \${{ steps.upload-linux-deb.outputs.artifact-digest }}
      rpm-artifact-id: \${{ steps.upload-linux-rpm.outputs.artifact-id }}
      rpm-artifact-digest: \${{ steps.upload-linux-rpm.outputs.artifact-digest }}
    runs-on: ubuntu-24.04
    steps:
      - name: Upload Linux AppImage
        id: upload-linux-appimage
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: SkyTwin-Linux-AppImage
          path: apps/desktop/dist-electron/*.AppImage
      - name: Upload Linux deb
        id: upload-linux-deb
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: SkyTwin-Linux-deb
      - name: Upload Linux rpm
        id: upload-linux-rpm
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: SkyTwin-Linux-rpm
  mobile-android:
    needs: [test, changes]
    if: github.event_name != 'pull_request' || needs.changes.outputs.mobile == 'true'
    runs-on: ubuntu-24.04
    steps: []
  mobile-ios:
    needs: [test, changes]
    if: github.event_name != 'pull_request' || needs.changes.outputs.mobile == 'true'
    runs-on: macos-15
    steps: []
  release-artifact-materials:
    name: Produce release artifact verification materials
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [desktop-mac, desktop-windows, desktop-linux]
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      actions: read
      id-token: write
      attestations: write
      artifact-metadata: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - name: Derive release artifact identity
        shell: bash
        run: |
          bash .github/scripts/derive-app-version.sh
          CREATED_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
          printf 'CREATED_UTC=%s\\n' "$CREATED_UTC" >> "$GITHUB_ENV"
${artifactDownloads}
      - name: Generate exact release artifact materials
        shell: bash
        run: node ${RELEASE_ARTIFACT_GENERATOR_PATH} --root artifacts --output ${RELEASE_ARTIFACT_STAGING_DIRECTORY} --repository "$GITHUB_REPOSITORY" --commit "$GITHUB_SHA" --ref "$GITHUB_REF" --releaseTag "$GITHUB_REF_NAME" --appVersion "$APP_VERSION" --runId "$GITHUB_RUN_ID" --created "$CREATED_UTC"
      - name: Validate staged release artifact materials
        shell: bash
        run: node ${RELEASE_ARTIFACT_VALIDATOR_PATH} --root ${RELEASE_ARTIFACT_STAGING_DIRECTORY} --manifest ${RELEASE_ARTIFACT_MANIFEST_PATH} --repository "$GITHUB_REPOSITORY" --commit "$GITHUB_SHA" --ref "$GITHUB_REF" --releaseTag "$GITHUB_REF_NAME" --appVersion "$APP_VERSION" --runId "$GITHUB_RUN_ID" --created "$CREATED_UTC"
      - name: Attest exact release artifact subjects
        id: attest-release-artifacts
        uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6
        with:
          subject-checksums: ${RELEASE_ARTIFACT_MATERIALS_DIRECTORY}/SHA256SUMS
      - name: Materialize digest-named provenance bundles
        shell: bash
        run: node ${RELEASE_ATTESTATION_MATERIALIZER_PATH} --manifest ${RELEASE_ARTIFACT_MANIFEST_PATH} --bundle "\${{ steps.attest-release-artifacts.outputs.bundle-path }}" --output ${RELEASE_ARTIFACT_MATERIALS_DIRECTORY}
      - name: Upload release artifact verification materials
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: ${RELEASE_ARTIFACT_MATERIALS_ARTIFACT}
          path: ${RELEASE_ARTIFACT_MATERIALS_DIRECTORY}
          if-no-files-found: error
          compression-level: 0
  release-machine-evidence:
    name: release-machine-evidence / \${{ matrix.claimId }} / \${{ matrix.platform }}
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [desktop-mac, desktop-windows, desktop-linux, release-artifact-materials]
    permissions:
      contents: read
      actions: read
    strategy:
      fail-fast: false
      matrix:
        include:
${machineMatrix}
    runs-on: \${{ matrix.runner }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - name: Download release artifacts for non-model verifiers
        if: matrix.claimId != 'models.verified-delivery'
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          path: artifacts
      - name: Prepare private model delivery subject directory
        if: matrix.claimId == 'models.verified-delivery'
        shell: bash
        run: install -d -m 0700 -- .release-evidence/model-delivery-subject
      - name: Download exact Linux AppImage for model delivery
        id: download-model-appimage
        if: matrix.claimId == 'models.verified-delivery'
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          artifact-ids: \${{ needs.desktop-linux.outputs.appimage-artifact-id }}
          path: .release-evidence/model-delivery-subject
          digest-mismatch: error
      - name: Download release artifact verification materials
        if: matrix.claimId == 'release.artifact-verification'
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          name: ${RELEASE_ARTIFACT_MATERIALS_ARTIFACT}
          path: ${ARTIFACT_VERIFICATION_DIRECTORY}
      - name: Resolve packaged sample provenance
        id: sample-provenance
        if: matrix.claimId == 'sample.packaged-account-free'
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/release-claims/verifiers/sample.packaged-account-free.mjs --discover --platform \${{ matrix.platform }} --descriptor .release-evidence/provenance/\${{ matrix.reportName }}
      - name: Run canonical packaged sample verifier without GitHub API token
        if: matrix.claimId == 'sample.packaged-account-free'
        env:
          SKYTWIN_RELEASE_PROVENANCE_SHA256: \${{ steps.sample-provenance.outputs.descriptor_sha256 }}
        run: node scripts/release-claims/verifiers/sample.packaged-account-free.mjs --verify --platform \${{ matrix.platform }} --descriptor .release-evidence/provenance/\${{ matrix.reportName }} --output .release-evidence/reports/\${{ matrix.reportName }}
      - name: Run canonical machine verifier
        id: machine-verifier
        if: matrix.claimId != 'sample.packaged-account-free'
        env:
          GITHUB_TOKEN: \${{ github.token }}
          SKYTWIN_RELEASE_ARTIFACT_IDS: \${{ matrix.platform == 'macos' && format('SkyTwin-macOS-dmg={0},SkyTwin-macOS-zip={1}', needs.desktop-mac.outputs.dmg-artifact-id, needs.desktop-mac.outputs.zip-artifact-id) || matrix.platform == 'windows' && format('SkyTwin-Windows-installer={0}', needs.desktop-windows.outputs.installer-artifact-id) || matrix.platform == 'linux' && format('SkyTwin-Linux-AppImage={0},SkyTwin-Linux-deb={1},SkyTwin-Linux-rpm={2}', needs.desktop-linux.outputs.appimage-artifact-id, needs.desktop-linux.outputs.deb-artifact-id, needs.desktop-linux.outputs.rpm-artifact-id) || '' }}
          SKYTWIN_RELEASE_ARTIFACT_DIGESTS: \${{ matrix.platform == 'macos' && format('SkyTwin-macOS-dmg={0},SkyTwin-macOS-zip={1}', needs.desktop-mac.outputs.dmg-artifact-digest, needs.desktop-mac.outputs.zip-artifact-digest) || matrix.platform == 'windows' && format('SkyTwin-Windows-installer={0}', needs.desktop-windows.outputs.installer-artifact-digest) || matrix.platform == 'linux' && format('SkyTwin-Linux-AppImage={0},SkyTwin-Linux-deb={1},SkyTwin-Linux-rpm={2}', needs.desktop-linux.outputs.appimage-artifact-digest, needs.desktop-linux.outputs.deb-artifact-digest, needs.desktop-linux.outputs.rpm-artifact-digest) || '' }}
          SKYTWIN_LINUX_APPIMAGE_ARTIFACT_ID: \${{ needs.desktop-linux.outputs.appimage-artifact-id }}
          SKYTWIN_LINUX_APPIMAGE_ARTIFACT_DIGEST: \${{ needs.desktop-linux.outputs.appimage-artifact-digest }}
          SKYTWIN_MODEL_APPIMAGE_DOWNLOAD_PATH: \${{ steps.download-model-appimage.outputs.download-path }}
        run: node scripts/release-claims/verifiers/\${{ matrix.claimId }}.mjs --platform \${{ matrix.platform }} --output .release-evidence/reports/\${{ matrix.reportName }}
      - name: Upload machine evidence report
        id: upload-machine-evidence
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: \${{ matrix.claimId == 'release.signing' && format('release-signing-report-{0}-attempt-{1}', matrix.platform, github.run_attempt) || format('release-machine-evidence-{0}-{1}-attempt-{2}', matrix.claimId, matrix.platform, github.run_attempt) }}
          path: .release-evidence/reports/\${{ matrix.reportName }}
          if-no-files-found: error
          compression-level: 0
      - name: Download exact uploaded signing report
        if: matrix.claimId == 'release.signing'
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          artifact-ids: \${{ steps.upload-machine-evidence.outputs.artifact-id }}
          path: .release-evidence/upload-confirmation
          merge-multiple: true
      - name: Verify exact uploaded signing report binding
        if: matrix.claimId == 'release.signing'
        env:
          SKYTWIN_EXPECTED_REPORT_SHA256: \${{ steps.machine-verifier.outputs.report_sha256 }}
          SKYTWIN_UPLOADED_ARTIFACT_ID: \${{ steps.upload-machine-evidence.outputs.artifact-id }}
          SKYTWIN_UPLOADED_ARTIFACT_NAME: release-signing-report-\${{ matrix.platform }}-attempt-\${{ github.run_attempt }}
          SKYTWIN_UPLOADED_ARTIFACT_SHA256: \${{ steps.upload-machine-evidence.outputs.artifact-digest }}
        run: node scripts/release-claims/verifiers/release.signing.mjs --verify-upload --platform \${{ matrix.platform }} --report .release-evidence/upload-confirmation/\${{ matrix.reportName }} --binding .release-evidence/upload-bindings/\${{ matrix.reportName }}.binding.json
      - name: Upload signing report source binding
        if: matrix.claimId == 'release.signing'
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-signing-binding-\${{ matrix.platform }}-attempt-\${{ github.run_attempt }}
          path: .release-evidence/upload-bindings/\${{ matrix.reportName }}.binding.json
          if-no-files-found: error
          compression-level: 0
  aggregate-release-evidence:
    name: Aggregate release machine evidence
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [release-machine-evidence, release-artifact-materials]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - name: Download signing report source bindings for this run attempt
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          pattern: release-signing-binding-*-attempt-\${{ github.run_attempt }}
          path: .release-evidence/upload-bindings
          merge-multiple: true
      - name: Resolve exact source signing report artifact IDs
        id: signing-report-bindings
        run: node scripts/release-claims/verifiers/release.signing.mjs --resolve-upload-bindings --bindings .release-evidence/upload-bindings
      - name: Download exact source signing reports
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          artifact-ids: \${{ steps.signing-report-bindings.outputs.artifact_ids }}
          path: .release-evidence/reports
          merge-multiple: true
      - name: Verify aggregated source signing report bindings
        run: node scripts/release-claims/verifiers/release.signing.mjs --verify-aggregated-uploads --bindings .release-evidence/upload-bindings --reports .release-evidence/reports
      - name: Download non-signing machine evidence reports for this run attempt
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          pattern: release-machine-evidence-*-attempt-\${{ github.run_attempt }}
          path: .release-evidence/reports
          merge-multiple: true
      - name: Download release artifact verification materials
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          name: ${RELEASE_ARTIFACT_MATERIALS_ARTIFACT}
          path: ${ARTIFACT_VERIFICATION_DIRECTORY}
      - name: Upload aggregated release evidence
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-evidence
          path: .release-evidence
          if-no-files-found: error
          compression-level: 0
  release:
    name: Create GitHub Release
    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')
    needs: [test, desktop-mac, desktop-windows, desktop-linux, aggregate-release-evidence]
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: release-publication
    concurrency:
      group: release-publication-\${{ github.ref }}
      cancel-in-progress: false
    permissions:
      contents: write
      actions: read
      attestations: read
    steps:
      - name: Verify update feed reachable
        run: |
${CANONICAL_UPDATE_FEED_RUN.split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: \${{ env.NODE_VERSION }}
      - name: Install release claim checker
        run: corepack pnpm@9.1.0 install --frozen-lockfile --ignore-scripts --filter skytwin
      - name: Download all artifacts
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          path: artifacts
      - name: Verify post-build release evidence
        id: verify-release-evidence
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: |
${CANONICAL_RELEASE_EVIDENCE_RUN.split("\n")
  .map((line) => `          ${line}`)
  .join("\n")}
      - name: List artifacts
        run: find artifacts -type f | sort
      - name: Verify protected release environment
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/release-claims/verify-release-environment.mjs
      - name: Refuse an existing release tag
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/release-claims/publish-verified-draft.mjs --assert-absent
      - name: Verify release tag target and main ancestry
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/release-claims/publish-verified-draft.mjs --assert-tag-target
      - name: Create release
        id: create-release-draft
        uses: softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64
        with:
          draft: true
          prerelease: true
          target_commitish: \${{ github.sha }}
          generate_release_notes: true
          fail_on_unmatched_files: true
          files: |
${[...CANONICAL_RELEASE_ASSETS].map(([name]) => `            artifacts/${name}/*`).join("\n")}
${CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS.map((path) => `            ${path}`).join("\n")}
${CANONICAL_RELEASE_SAFETY_ASSET_PATHS.map((path) => `            ${path}`).join("\n")}
            ${ARTIFACT_VERIFICATION_RELEASE_PATTERN}
            .release-evidence/manifest.json
      - name: Verify exact draft assets and publish
        env:
          GITHUB_TOKEN: \${{ github.token }}
          RELEASE_ID: \${{ steps.create-release-draft.outputs.id }}
          RELEASE_EVIDENCE_MANIFEST_SHA256: \${{ steps.verify-release-evidence.outputs.manifest-sha256 }}
        run: node scripts/release-claims/publish-verified-draft.mjs .release-evidence/manifest.json
  approved-copy:
    runs-on: ubuntu-latest
    steps:
      - name: Approved workflow statement fixture
        run: |
${evidenceLines.map((line) => `          ${line}`).join("\n")}
`;
  write(root, ".github/workflows/build.yml", workflow);
  write(root, "evidence.txt", EVIDENCE);
  write(root, "LICENSE", EVIDENCE);
  for (const asset of ledger.publicBinaryAssets) {
    const source = new URL(`../../${asset.path}`, import.meta.url);
    write(root, asset.path, readFileSync(source));
  }
  write(
    root,
    "docs/beta-claim-ledger.json",
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

describe("release claim ledger validation", () => {
  it("documents tagging from the authoritative ledger target", () => {
    const procedure = readFileSync(
      new URL("../../docs/release-procedure.md", import.meta.url),
      "utf8",
    );
    expect(procedure).toContain(
      'require("./docs/beta-claim-ledger.json").release.targetVersion',
    );
    expect(procedure).not.toContain('git tag -a "v$(cat VERSION)"');
    expect(procedure).toContain("pnpm --filter @skytwin/db backup export");
    expect(procedure).not.toContain("backup -- export");
    expect(procedure).toMatch(
      /The `release-claims-ci` producer now\s+records the frozen source-check commands/u,
    );
    expect(procedure).not.toContain(
      "the separate `release-claims-ci` artifact producer are absent",
    );
  });

  it("accepts a complete blocked release contract", () => {
    const root = makeRoot();
    writeValidFixture(root);
    expect(runChecks({ root }).errors).toEqual([]);
  });

  it("requires the account-free ledger verification to match every frozen CI command", () => {
    const root = makeRoot();
    const ledger = validLedger();
    const claim = ledger.claims.find(
      (candidate) => candidate.id === "connectors.account-free-boundary",
    );
    claim.verification.pop();
    writeValidFixture(root, ledger);
    expect(
      validateLedgerShape(ledger, root).some((error) =>
        error.includes(
          "verification must exactly map the frozen account-free CI commands",
        ),
      ),
    ).toBe(true);
  });

  it("requires every executable CI-result source to be ledger-pinned", () => {
    const root = makeRoot();
    const ledger = validLedger();
    const claim = ledger.claims.find(
      (candidate) => candidate.id === "release.artifact-verification",
    );
    claim.evidence = claim.evidence.filter(
      (evidence) => evidence.path !== RELEASE_CLAIM_CI_HARNESS_PATH,
    );
    writeValidFixture(root, ledger);
    expect(validateLedgerShape(ledger, root)).toContain(
      `release.artifact-verification must pin release claim CI source: ${RELEASE_CLAIM_CI_HARNESS_PATH}`,
    );
  });

  it("rejects a no-op substituted for the canonical machine verifier", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "        run: node scripts/release-claims/verifiers/${{ matrix.claimId }}.mjs --platform ${{ matrix.platform }} --output .release-evidence/reports/${{ matrix.reportName }}",
        "        run: echo verifier skipped",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );
  });

  it("requires the model lane to download only the exact AppImage artifact ID", () => {
    for (const [expected, replacement] of [
      [
        "          artifact-ids: ${{ needs.desktop-linux.outputs.appimage-artifact-id }}",
        "          name: SkyTwin-Linux-AppImage",
      ],
      [
        "        if: matrix.claimId != 'models.verified-delivery'\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c\n        with:\n          path: artifacts",
        "        if: always()\n        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c\n        with:\n          path: artifacts",
      ],
    ]) {
      const root = makeRoot();
      writeValidFixture(root);
      const path = join(root, ".github/workflows/build.yml");
      const workflow = readFileSync(path, "utf8");
      expect(workflow).toContain(expected);
      writeFileSync(path, workflow.replace(expected, replacement));
      expect(verifyCanonicalReleasePublisher(root)).toContain(
        "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
      );
    }
  });

  it("requires the combined model and signing graph to retain every Linux artifact output", () => {
    for (const [needle, replacement] of [
      [
        "      deb-artifact-id: ${{ steps.upload-linux-deb.outputs.artifact-id }}",
        "      deb-artifact-id: forged",
      ],
      [
        "      rpm-artifact-digest: ${{ steps.upload-linux-rpm.outputs.artifact-digest }}",
        "      rpm-artifact-digest: forged",
      ],
    ]) {
      const root = makeRoot();
      writeValidFixture(root);
      const path = join(root, ".github/workflows/build.yml");
      const workflow = readFileSync(path, "utf8");
      expect(workflow).toContain(needle);
      expect(workflow).toContain(
        "          SKYTWIN_MODEL_APPIMAGE_DOWNLOAD_PATH: ${{ steps.download-model-appimage.outputs.download-path }}",
      );
      expect(workflow).toContain(
        "          SKYTWIN_RELEASE_ARTIFACT_IDS: ${{ matrix.platform == 'macos'",
      );
      writeFileSync(path, workflow.replace(needle, replacement));
      expect(verifyCanonicalReleasePublisher(root)).toContain(
        "Linux release uploads must expose their exact immutable current-attempt artifact IDs and digests",
      );
    }
  });

  it("requires every release-risk category and exact evidence command", () => {
    const root = makeRoot();
    write(root, "evidence.txt", "evidence");
    const ledger = validLedger();
    ledger.claims = ledger.claims.filter(
      (claim) => claim.category !== "signing",
    );
    ledger.claims[0].verification = [];
    const errors = validateLedgerShape(ledger, root);
    expect(errors).toContain("required claim category is missing: signing");
    expect(
      errors.some((error) =>
        error.includes(".verification must include an exact command or test"),
      ),
    ).toBe(true);
  });

  it("rejects weakening a canonical readiness claim without changing its id", () => {
    const root = makeRoot();
    const ledger = validLedger();
    const claim = ledger.claims.find(({ id }) => id === "release.signing");
    claim.statement = "One preview file has a signature.";
    writeValidFixture(root, ledger);
    expect(runChecks({ root }).errors).toContain(
      "canonical readiness claim meaning changed: release.signing",
    );
  });

  it("requires the post-build evidence gate before the sole publisher", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(path, "utf8");
    const publisherIndex = workflow.indexOf(
      "uses: softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64",
    );
    writeFileSync(
      path,
      `${workflow.slice(0, publisherIndex).replaceAll("--evidence-manifest .release-evidence/manifest.json", "--removed-evidence-manifest")}${workflow.slice(publisherIndex)}`,
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "post-build release evidence gate must execute before the canonical publisher",
    );
  });

  it("requires the checker to emit the digest of the manifest bytes it verified", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const workflowPath = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(workflowPath, "utf8");
    const canonicalOutput = '--github-output "$GITHUB_OUTPUT"';
    expect(workflow).toContain(canonicalOutput);
    writeFileSync(
      workflowPath,
      workflow.replace(
        canonicalOutput,
        "/usr/bin/sha256sum .release-evidence/manifest.json",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "post-build release evidence gate must execute with canonical fail-closed controls",
    );
  });

  it("returns the digest of exact stable manifest bytes and rejects hardlinks", () => {
    const root = makeRoot();
    const manifestPath = join(root, "manifest.json");
    const bytes = '{"schemaVersion":1}\n';
    writeFileSync(manifestPath, bytes);
    expect(readPublicationEvidenceManifest(root, "manifest.json")).toEqual({
      manifest: { schemaVersion: 1 },
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const hardlinkPath = join(root, "manifest-hardlink.json");
    linkSync(manifestPath, hardlinkPath);
    expect(() =>
      readPublicationEvidenceManifest(root, "manifest-hardlink.json"),
    ).toThrow("evidence manifest must be single-link");
  });

  it("rejects credentials on the packaged sample execution step", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "      - name: Run canonical packaged sample verifier without GitHub API token\n        if: matrix.claimId == 'sample.packaged-account-free'\n        env:\n          SKYTWIN_RELEASE_PROVENANCE_SHA256: ${{ steps.sample-provenance.outputs.descriptor_sha256 }}\n        run:",
        "      - name: Run canonical packaged sample verifier without GitHub API token\n        if: matrix.claimId == 'sample.packaged-account-free'\n        env:\n          SKYTWIN_RELEASE_PROVENANCE_SHA256: ${{ steps.sample-provenance.outputs.descriptor_sha256 }}\n          GITHUB_TOKEN: ${{ github.token }}\n        run:",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );
  });

  it("rejects evidence commands preserved only as inert text", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "cp -R artifacts/release-evidence .release-evidence",
        "echo cp -R artifacts/release-evidence .release-evidence",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "post-build release evidence gate must execute with canonical fail-closed controls",
    );
  });

  it("rejects an alternate release publisher", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n# not a comment\nrun: gh release create v1\n`,
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release workflow contains an alternate publisher outside the canonical gated action",
    );
  });

  it("rejects an alternate publisher in another workflow", () => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      ".github/workflows/release.yml",
      "jobs:\n  bypass:\n    steps:\n      - run: gh release create v1\n",
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release workflow contains an alternate publisher outside the canonical gated action",
    );
  });

  it("rejects workflow-level contents write", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "permissions:\n  contents: read\n",
        "permissions:\n  contents: write\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "workflow-level write permissions are prohibited: .github/workflows/build.yml",
    );
  });

  it.each([
    ["omitted", ""],
    ["null", "permissions:\n"],
    ["inherit-like", "permissions: inherit\n"],
  ])("rejects %s workflow default permissions", (_case, replacement) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "permissions:\n  contents: read\n",
        replacement,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "workflow must declare the exact read-only default permissions: .github/workflows/build.yml",
    );
  });

  it.each([
    [
      "dot-property secret under a neutral key",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    runs-on: ubuntu-latest\n    env:\n      CREDENTIAL: ${{ secrets.RELEASE_PAT }}\n    steps:\n      - run: echo bypass\n",
    ],
    [
      "single-quoted bracket secret under a neutral key",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bypass\n        env:\n          CREDENTIAL: \"${{ secrets['RELEASE_PAT'] }}\"\n",
    ],
    [
      "double-quoted bracket secret in reusable inputs",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    uses: owner/repo/.github/workflows/release.yml@main\n    with:\n      auth: '${{ secrets[\"RELEASE_PAT\"] }}'\n",
    ],
    [
      "inherited reusable-workflow secrets",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    uses: owner/repo/.github/workflows/release.yml@main\n    secrets: inherit\n",
    ],
    [
      "non-GITHUB_TOKEN action credential",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: owner/action@0123456789012345678901234567890123456789\n        with:\n          token: hard-coded-token\n",
    ],
  ])("rejects a non-release %s", (_case, workflow) => {
    const root = makeRoot();
    writeValidFixture(root);
    write(root, ".github/workflows/credentials.yml", workflow);
    expect(
      verifyCanonicalReleasePublisher(root).some((error) =>
        error.startsWith(
          "non-release workflow credentials are not allowlisted:",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "ordinary job",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    permissions:\n      contents: write\n    steps:\n      - run: echo bypass\n",
    ],
    [
      "reusable job",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    permissions:\n      contents: write\n    uses: owner/repo/.github/workflows/release.yml@main\n",
    ],
  ])("rejects another write-capable %s", (_kind, workflow) => {
    const root = makeRoot();
    writeValidFixture(root);
    write(root, ".github/workflows/alternate.yml", workflow);
    const errors = verifyCanonicalReleasePublisher(root);
    expect(errors).toContain(
      "write-capable workflow job is outside the canonical publisher: .github/workflows/alternate.yml jobs.bypass",
    );
    expect(errors).toContain(
      "exactly one job must have contents:write, and it must be build.yml jobs.release",
    );
  });

  it("rejects even a read-only non-release job permission override", () => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      ".github/workflows/alternate.yml",
      "permissions:\n  contents: read\njobs:\n  bypass:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bypass\n",
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "non-release job permissions must inherit the exact read-only workflow default: .github/workflows/alternate.yml jobs.bypass",
    );
  });

  it.each([
    [
      "mutable checkout tag",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/checkout@v6",
    ],
    [
      "github-script step",
      "      - name: Verify post-build release evidence\n",
      "      - uses: actions/github-script@v8\n      - name: Verify post-build release evidence\n",
    ],
  ])("rejects a %s in the write job", (_kind, needle, replacement) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      replaceLast(readFileSync(path, "utf8"), needle, replacement),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "every action in the write-capable release job must match the canonical full-SHA allowlist",
    );
  });

  it("rejects a mutable action in an upstream artifact producer", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@v7",
      ),
    );
    expect(
      verifyCanonicalReleasePublisher(root).some((error) =>
        error.startsWith(
          "canonical build workflow actions must use immutable full commit SHAs:",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "artifact-metadata permission",
      "      artifact-metadata: write",
      "      artifact-metadata: read",
    ],
    [
      "desktop dependency",
      "    needs: [desktop-mac, desktop-windows, desktop-linux]\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n      actions: read\n      id-token: write",
      "    needs: [desktop-mac, desktop-windows]\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n      actions: read\n      id-token: write",
    ],
    [
      "attestation action pin",
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
      "actions/attest@v4",
    ],
    [
      "materials upload destination",
      `          path: ${RELEASE_ARTIFACT_MATERIALS_DIRECTORY}`,
      "          path: .release-artifacts/unreviewed",
    ],
  ])("rejects a changed release-materials %s", (_case, needle, replacement) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(needle, replacement),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release artifact materials must use the exact tag-only permission, download, generation, attestation, materialization, and upload graph",
    );
  });

  it.each([
    RELEASE_ARTIFACT_GENERATOR_PATH,
    RELEASE_ARTIFACT_VALIDATOR_PATH,
    RELEASE_ATTESTATION_MATERIALIZER_PATH,
    "scripts/release-claims/verifiers/release.artifact-verification.mjs",
  ])("requires release artifact material source %s", (sourcePath) => {
    const root = makeRoot();
    writeValidFixture(root);
    rmSync(join(root, sourcePath));
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      `release artifact material source is missing or unsafe: ${sourcePath}`,
    );
  });

  it("rejects an alternate release-materials uploader and attester", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "\n  release:\n",
        `
  rogue-materials:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6
        with:
          subject-checksums: forged
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: ${RELEASE_ARTIFACT_MATERIALS_ARTIFACT}
          path: forged

  release:
`,
      ),
    );
    const errors = verifyCanonicalReleasePublisher(root);
    expect(errors).toContain(
      "only the canonical release artifact materials job may upload the fixed materials artifact",
    );
    expect(errors).toContain(
      "only the canonical release artifact materials job may attest release subjects",
    );
  });

  it.each([
    [
      "legacy generator",
      "      - uses: anchore/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26\n",
    ],
    [
      "duplicate SBOM artifact",
      `      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-sbom-forged
          path: forged.json
`,
    ],
  ])("rejects a %s", (_case, step) => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      ".github/workflows/legacy-sbom.yml",
      `permissions:
  contents: read
jobs:
  legacy:
    runs-on: ubuntu-24.04
    steps:
${step}`,
    );
    expect(
      verifyCanonicalReleasePublisher(root).some((error) =>
        error.startsWith(
          "legacy or duplicate release SBOM producers are prohibited:",
        ),
      ),
    ).toBe(true);
  });

  it("requires the artifact-verification matrix row to download exact materials before verification", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        `          name: ${RELEASE_ARTIFACT_MATERIALS_ARTIFACT}\n          path: ${ARTIFACT_VERIFICATION_DIRECTORY}`,
        `          name: unreviewed-materials\n          path: ${ARTIFACT_VERIFICATION_DIRECTORY}`,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );
  });

  it("requires exact-ID post-upload signing report verification in the producer job", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "          artifact-ids: ${{ steps.upload-machine-evidence.outputs.artifact-id }}",
        "          artifact-ids: 999",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );
  });

  it("requires the exact signing upload-verification step to succeed before publication", () => {
    const verifierStep = {
      name: CANONICAL_MACHINE_VERIFIER_STEP,
      conclusion: "success",
    };
    const uploadVerificationStep = {
      name: "Verify exact uploaded signing report binding",
      conclusion: "success",
    };
    expect(
      hasCanonicalSuccessfulMachineSteps("release.signing", {
        steps: [verifierStep],
      }),
    ).toBe(false);
    expect(
      hasCanonicalSuccessfulMachineSteps("release.signing", {
        steps: [
          verifierStep,
          { ...uploadVerificationStep, conclusion: "failure" },
        ],
      }),
    ).toBe(false);
    expect(
      hasCanonicalSuccessfulMachineSteps("release.signing", {
        steps: [verifierStep, uploadVerificationStep],
      }),
    ).toBe(true);
  });

  it("requires attempt-specific signing bindings and exact-ID aggregation", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(path, "utf8");
    writeFileSync(
      path,
      workflow.replace(
        "release-signing-binding-${{ matrix.platform }}-attempt-${{ github.run_attempt }}",
        "release-signing-binding-${{ matrix.platform }}",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );
    writeFileSync(
      path,
      workflow.replace(
        "artifact-ids: ${{ steps.signing-report-bindings.outputs.artifact_ids }}",
        "pattern: release-signing-report-*",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence aggregation must be the exact producer-dependent immutable artifact graph",
    );
  });

  it("requires machine verification to depend on the materials producer", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "    needs: [desktop-mac, desktop-windows, desktop-linux, release-artifact-materials]",
        "    needs: [desktop-mac, desktop-windows, desktop-linux]",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );
  });

  it("requires the sole evidence aggregator to depend on reports and materials", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "    needs: [release-machine-evidence, release-artifact-materials]",
        "    needs: release-machine-evidence",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "machine evidence aggregation must be the exact producer-dependent immutable artifact graph",
    );
  });

  it("rejects a second artifact whose name matches the machine-input prefix", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "\n  release:\n",
        `
  rogue-machine-input:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-machine-evidence-forged
          path: .release-evidence/reports

  release:
`,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "only the canonical machine producer may upload attempt-bound machine reports and signing bindings",
    );
  });

  it.each(["true", null])(
    "rejects checkout persist-credentials=%s in the write job",
    (persistCredentials) => {
      const root = makeRoot();
      writeValidFixture(root);
      const path = join(root, ".github/workflows/build.yml");
      const source = readFileSync(path, "utf8");
      writeFileSync(
        path,
        persistCredentials === null
          ? source.replace(
              "        with:\n          persist-credentials: false\n      - uses: actions/setup-node",
              "      - uses: actions/setup-node",
            )
          : replaceLast(
              source,
              "          persist-credentials: false",
              `          persist-credentials: ${persistCredentials}`,
            ),
      );
      expect(verifyCanonicalReleasePublisher(root)).toContain(
        "canonical release job must contain only the exact allowlisted step graph in order",
      );
    },
  );

  it("rejects an alternate softprops publisher in another workflow", () => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      ".github/workflows/alternate.yml",
      "jobs:\n  bypass:\n    steps:\n      - uses: softprops/action-gh-release@v3\n",
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "all workflows must contain exactly one GitHub release action; found 2",
    );
  });

  it("rejects a quoted alternate softprops publisher in another workflow", () => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      ".github/workflows/alternate.yml",
      'jobs:\n  bypass:\n    steps:\n      - "uses" : "softprops/action-gh-release@v3"\n',
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "all workflows must contain exactly one GitHub release action; found 2",
    );
  });

  it("requires the publisher and mutation gates to stay in jobs.release", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(path, "utf8").replace(
      "  release:\n",
      `  release:
  release:
    environment: release-publication
    concurrency:
      group: release-publication-\${{ github.ref }}
      cancel-in-progress: false
    permissions:
      contents: write
      actions: read
    steps:
      - run: node check.mjs --evidence-manifest .release-evidence/manifest.json
      - run: node scripts/release-claims/verify-release-environment.mjs
  "publisher" : # separate unprotected job
`,
    );
    writeFileSync(path, workflow);
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "exactly one job must have contents:write, and it must be build.yml jobs.release",
    );
  });

  it.each([
    ["id", "      - id: intervening\n        run: echo skipped gate\n"],
    ["if", "      - if: always()\n        run: echo skipped gate\n"],
  ])(
    "detects an intervening %s-first step before draft creation",
    (_key, interveningStep) => {
      const root = makeRoot();
      writeValidFixture(root);
      const path = join(root, ".github/workflows/build.yml");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          "      - name: Create release\n",
          `${interveningStep}      - name: Create release\n`,
        ),
      );
      expect(verifyCanonicalReleasePublisher(root)).toContain(
        "existing releases and moved tags must be rejected immediately before draft creation",
      );
    },
  );

  it.each([
    ["arbitrary run", "      - name: Extra run\n        run: echo bypass\n"],
    [
      "node fetch mutation",
      `      - name: Hidden release mutation
        run: |
          node -e "fetch(['https://api.github.com/repos/o/r', 'releases'].join('/'), { ['method']: 'POST' })"
`,
    ],
  ])("rejects an extra %s anywhere in the release job", (_case, extraStep) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "      - name: Verify protected release environment\n",
        `${extraStep}      - name: Verify protected release environment\n`,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "canonical release job must contain only the exact allowlisted step graph in order",
    );
  });

  it.each([
    [
      "if:false environment verifier",
      "Verify protected release environment",
      "        if: false\n",
      "release job must fail closed when the protected environment is absent or misconfigured",
    ],
    [
      "custom-shell absence check",
      "Refuse an existing release tag",
      "        shell: bash\n",
      "existing releases and moved tags must be rejected immediately before draft creation",
    ],
    [
      "continue-on-error upload action",
      "Create release",
      "        continue-on-error: true\n",
      "canonical GitHub release publisher must not have conditional or overridden execution controls",
    ],
    [
      "ignored controlled publisher failure",
      "Verify exact draft assets and publish",
      "        continue-on-error: true\n",
      "controlled draft verification and publication must use canonical fail-closed controls",
    ],
  ])("rejects %s", (_case, stepName, control, expectedError) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        `      - name: ${stepName}\n`,
        `      - name: ${stepName}\n${control}`,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(expectedError);
  });

  it.each([
    [
      "workflow",
      "concurrency:\n",
      "defaults:\n  run:\n    shell: bash\nconcurrency:\n",
    ],
    [
      "release job",
      "    environment: release-publication\n",
      "    environment: release-publication\n    defaults:\n      run:\n        shell: bash\n",
    ],
  ])("rejects custom %s run defaults", (_scope, needle, replacement) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(needle, replacement),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release publication must not inherit custom run defaults",
    );
  });

  it("rejects critical release settings supplied only by a decoy job", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(path, "utf8")
      .replace("          draft: true\n", "          draft: false\n")
      .replace("          prerelease: true\n", "          prerelease: false\n")
      .replace("          fail_on_unmatched_files: true\n", "")
      .replace(
        "        run: node scripts/release-claims/verify-release-environment.mjs\n",
        "        run: node scripts/release-claims/not-the-environment-check.mjs\n",
      );
    writeFileSync(
      path,
      `${workflow}\n  decoy:\n    steps:\n      - run: node scripts/release-claims/verify-release-environment.mjs\n      - run: echo decoy\n        env:\n          draft: true\n          prerelease: true\n          fail_on_unmatched_files: true\n`,
    );
    const errors = verifyCanonicalReleasePublisher(root);
    expect(errors).toContain(
      "canonical publisher must create an unpublished draft",
    );
    expect(errors).toContain(
      "canonical publisher must mark the beta as a prerelease",
    );
    expect(errors).toContain(
      "canonical publisher must fail when an exact release asset path is missing",
    );
    expect(errors).toContain(
      "release job must fail closed when the protected environment is absent or misconfigured",
    );
  });

  it("rejects same-step and comment decoys for critical release controls", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(path, "utf8")
      .replace("          draft: true\n", "          draft: false\n")
      .replace("          prerelease: true\n", "          prerelease: false\n")
      .replace(
        "          fail_on_unmatched_files: true\n",
        "          fail_on_unmatched_files: false\n",
      )
      .replace(
        "        with:\n",
        '        env:\n          DECOY_SETTINGS: "draft: true prerelease: true fail_on_unmatched_files: true"\n        with:\n',
      )
      .replace(
        "        run: node scripts/release-claims/verify-release-environment.mjs\n",
        "        run: echo noop # node scripts/release-claims/verify-release-environment.mjs\n",
      )
      .replace(
        "          RELEASE_ID: ${{ steps.create-release-draft.outputs.id }}\n",
        "          RELEASE_ID: 7\n          # RELEASE_ID: ${{ steps.create-release-draft.outputs.id }}\n",
      );
    writeFileSync(path, workflow);
    const errors = verifyCanonicalReleasePublisher(root);
    expect(errors).toContain(
      "canonical publisher must create an unpublished draft",
    );
    expect(errors).toContain(
      "canonical publisher must mark the beta as a prerelease",
    );
    expect(errors).toContain(
      "canonical publisher must fail when an exact release asset path is missing",
    );
    expect(errors).toContain(
      "release job must fail closed when the protected environment is absent or misconfigured",
    );
    expect(errors).toContain(
      "controlled publisher must consume the exact draft release ID",
    );
  });

  it("rejects a Releases API mutation hidden in a generically named script", () => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      "scripts/deploy.mjs",
      'await fetch("https://api.github.com/repos/o/r/releases/7", { method: "PATCH" });\n',
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release workflow contains an alternate publisher outside the canonical gated action",
    );
  });

  it("rejects gh api release mutation hidden in a generically named script", () => {
    const root = makeRoot();
    writeValidFixture(root);
    write(
      root,
      "scripts/deploy.sh",
      "gh api /repos/o/r/releases/7 --method DELETE\n",
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release workflow contains an alternate publisher outside the canonical gated action",
    );
  });

  it("requires serialized protected-environment publication", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "    environment: release-publication\n",
        "",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release job must use the protected release-publication environment",
    );
  });

  it("rejects a publisher that admits workflow_dispatch in a tag context", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      replaceLast(
        readFileSync(path, "utf8"),
        "    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n",
        "    if: startsWith(github.ref, 'refs/tags/v')\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "canonical release job identity and dependencies must be exact",
    );
  });

  it("rejects a CI-result producer that is not push-only", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "      - name: Produce release claim CI result\n        if: always() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
        "      - name: Produce release claim CI result\n        if: always() && startsWith(github.ref, 'refs/tags/v')",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it.each([
    ["loader environment", "BASH_ENV: ''", "BASH_ENV: attacker.sh"],
    [
      "closed PATH",
      'PATH="$SKYTWIN_RELEASE_CI_NODE_BIN:/usr/bin:/bin"',
      'PATH="/tmp:$SKYTWIN_RELEASE_CI_NODE_BIN:/usr/bin:/bin"',
    ],
    [
      "captured runtime",
      '"$SKYTWIN_RELEASE_CI_NODE_PATH" "$SKYTWIN_RELEASE_CI_PNPM_ENTRY_PATH"',
      "node pnpm",
    ],
    ["bounded timeout", "timeout-minutes: 15", "timeout-minutes: 30"],
  ])("rejects release safety %s drift", (_name, needle, replacement) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      replaceInReleaseSafetyStep(
        readFileSync(path, "utf8"),
        needle,
        replacement,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  const artifactTestStep = `      - name: Test release artifact construction and verification
        env:
          BASH_ENV: ''
          ENV: ''
          LD_LIBRARY_PATH: ''
          LD_PRELOAD: ''
          NODE_PATH: ''
          NODE_OPTIONS: ''
          SKYTWIN_RELEASE_CI_NODE_PATH: \${{ steps.capture-release-claim-runtime.outputs.node-path }}
          SKYTWIN_RELEASE_CI_NODE_SHA256: \${{ steps.capture-release-claim-runtime.outputs.node-sha256 }}
        shell: /bin/bash --noprofile --norc -eo pipefail {0}
        run: |
          /usr/bin/printf '%s  %s\\n' "$SKYTWIN_RELEASE_CI_NODE_SHA256" "$SKYTWIN_RELEASE_CI_NODE_PATH" | /usr/bin/sha256sum --check --strict -
          /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$SKYTWIN_RELEASE_CI_NODE_PATH" node_modules/vitest/vitest.mjs run --passWithNoTests=false scripts/release-artifacts/file-integrity.test.mjs
          /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$SKYTWIN_RELEASE_CI_NODE_PATH" node_modules/vitest/vitest.mjs run --passWithNoTests=false scripts/release-artifacts/generate-release-manifest.test.mjs
          /usr/bin/env -i PATH=/usr/bin:/bin CI=true NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC "$SKYTWIN_RELEASE_CI_NODE_PATH" node_modules/vitest/vitest.mjs run --passWithNoTests=false scripts/release-artifacts/materialize-attestation-bundles.test.mjs
`;

  it.each([
    ["removal", (workflow) => workflow.replace(artifactTestStep, "")],
    [
      "duplication",
      (workflow) =>
        workflow.replace(artifactTestStep, artifactTestStep.repeat(2)),
    ],
    [
      "renaming",
      (workflow) =>
        workflow.replace(
          "Test release artifact construction and verification",
          "Optional release artifact tests",
        ),
    ],
    [
      "command substitution",
      (workflow) =>
        workflow.replace(
          "node_modules/vitest/vitest.mjs run --passWithNoTests=false",
          "node_modules/vitest/vitest.mjs --help --passWithNoTests=false",
        ),
    ],
    [
      "conditional execution",
      (workflow) =>
        workflow.replace(
          "      - name: Test release artifact construction and verification\n",
          "      - name: Test release artifact construction and verification\n        if: github.event_name == 'push'\n",
        ),
    ],
    [
      "environment rebinding",
      (workflow) =>
        workflow.replace(
          artifactTestStep,
          artifactTestStep.replace("BASH_ENV: ''", "BASH_ENV: attacker.sh"),
        ),
    ],
    [
      "execution after evidence production",
      (workflow) =>
        workflow
          .replace(artifactTestStep, "")
          .replace(
            "      - name: Upload release claim CI result\n",
            `${artifactTestStep}      - name: Upload release claim CI result\n`,
          ),
    ],
  ])("rejects release artifact gate %s", (_name, mutate) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(path, mutate(readFileSync(path, "utf8")));
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it("rejects failure tolerance on the release-claim CI job", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    continue-on-error: true\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it.each([
    "scripts/release-artifacts/file-integrity.test.mjs",
    "scripts/release-artifacts/generate-release-manifest.test.mjs",
    "scripts/release-artifacts/materialize-attestation-bundles.test.mjs",
  ])("rejects a missing release artifact test file: %s", (testPath) => {
    const root = makeRoot();
    writeValidFixture(root);
    rmSync(join(root, testPath));
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it.each([
    ["desktop-mac", "desktop", "needs", "needs: [changes]"],
    ["desktop-mac", "desktop", "condition", "if: always()"],
    ["desktop-windows", "desktop", "needs", "needs: [changes]"],
    ["desktop-windows", "desktop", "condition", "if: always()"],
    ["desktop-linux", "desktop", "needs", "needs: [changes]"],
    ["desktop-linux", "desktop", "condition", "if: always()"],
    ["mobile-android", "mobile", "needs", "needs: [changes]"],
    ["mobile-android", "mobile", "condition", "if: always()"],
    ["mobile-ios", "mobile", "needs", "needs: [changes]"],
    ["mobile-ios", "mobile", "condition", "if: always()"],
  ])(
    "rejects %s package gate %s mutation",
    (jobName, changeOutput, _mutation, replacement) => {
      const root = makeRoot();
      writeValidFixture(root);
      const path = join(root, ".github/workflows/build.yml");
      const original = `  ${jobName}:\n    needs: [test, changes]\n    if: github.event_name != 'pull_request' || needs.changes.outputs.${changeOutput} == 'true'`;
      const mutated = original.replace(
        replacement.startsWith("needs:")
          ? "needs: [test, changes]"
          : `if: github.event_name != 'pull_request' || needs.changes.outputs.${changeOutput} == 'true'`,
        replacement,
      );
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(original, mutated),
      );
      expect(verifyCanonicalReleasePublisher(root)).toContain(
        `${jobName} must require the successful release-artifact test gate and exact path-change condition`,
      );
    },
  );

  it("requires the CI-result producer to use the exact hosted runner", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "  test:\n    name: release-claim-ci\n    runs-on: ubuntu-latest\n",
        "  test:\n    name: release-claim-ci\n    runs-on: ubuntu-24.04\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it("requires full history for v2 ancestry checks under synthetic PR merge refs", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "          fetch-depth: 0\n",
        "          fetch-depth: 1\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer checkout must use the pinned action with full history",
    );
  });

  it.each([
    ["env", "    env:\n      NODE_OPTIONS: --import=attacker.mjs\n"],
    ["container", "    container: attacker/image:latest\n"],
    ["defaults", "    defaults:\n      run:\n        shell: attacker-shell\n"],
  ])("rejects CI-result job-level %s authority", (_kind, authority) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "  test:\n    name: release-claim-ci\n",
        `  test:\n    name: release-claim-ci\n${authority}`,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it("rejects direct runtime-output interpolation in the producer shell", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        '"$SKYTWIN_RELEASE_CI_NODE_PATH" scripts/release-claims/run-release-claim-ci.mjs',
        '"\${{ steps.capture-release-claim-runtime.outputs.node-path }}" scripts/release-claims/run-release-claim-ci.mjs',
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it("rejects a harness invocation that inherits lifecycle environment", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "exec /usr/bin/env -i PATH=/usr/bin:/bin",
        'exec /usr/bin/env PATH=/usr/bin:/bin NODE_OPTIONS="$NODE_OPTIONS"',
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it("rejects a report mutation step between the producer and uploader", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "      - name: Upload release claim CI result\n",
        "      - name: Rewrite release claim CI result\n        run: node attacker.mjs release-claims-ci/result.json\n      - name: Upload release claim CI result\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it.each([
    ["static", "release-claims-ci"],
    ["dynamic", "${{ matrix.artifact }}"],
  ])("rejects an alternate %s CI-result artifact uploader", (_kind, name) => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "  desktop-mac:\n",
        `  shadow-ci-upload:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a\n        with:\n          name: ${name}\n          path: alternate.json\n  desktop-mac:\n`,
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim CI producer must use the exact tag-push-only frozen harness and pinned artifact upload",
    );
  });

  it("requires a bounded release job timeout", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "    timeout-minutes: 30\n",
        "    timeout-minutes: 360\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "canonical release job identity and dependencies must be exact",
    );
  });

  it("requires an exact locked checker dependency install", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "corepack pnpm@9.1.0 install --frozen-lockfile --ignore-scripts --filter skytwin",
        "npm install yaml",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "release claim checker dependencies must use the exact locked install",
    );
  });

  it("requires controlled verification immediately after draft creation", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        /.*publish-verified-draft\.mjs \.release-evidence\/manifest\.json.*\n/,
        "",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "controlled draft verification and publication must be the immediate step after draft creation",
    );
  });

  it("requires an existing-tag rejection immediately before draft creation", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        /.*publish-verified-draft\.mjs --assert-absent.*\n/,
        "",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "existing releases and moved tags must be rejected immediately before draft creation",
    );
  });

  it("rejects a mutable release publisher action tag", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64",
        "softprops/action-gh-release@v3",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "canonical GitHub release publisher must be pinned to softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64",
    );
  });

  it("rejects workflow-level cancellation of tag publication runs", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "cancel-in-progress: ${{ !startsWith(github.ref, 'refs/tags/v') }}",
        "cancel-in-progress: true",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "tag publication workflows must not be cancelled",
    );
  });

  it("requires the creator action release ID in controlled publication", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "RELEASE_ID: ${{ steps.create-release-draft.outputs.id }}",
        "RELEASE_ID: 7",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "controlled publisher must consume the exact draft release ID",
    );
  });

  it("requires every durable evidence report as an exact release asset", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        `            ${CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS[1]}\n`,
        "",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      `release publisher is missing canonical asset: ${CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS[1]}`,
    );
  });

  it("rejects wildcard evidence report uploads", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    const workflow = readFileSync(path, "utf8");
    writeFileSync(
      path,
      workflow.replace(
        CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS.map(
          (reportPath) => `            ${reportPath}\n`,
        ).join(""),
        "            .release-evidence/reports/*\n",
      ),
    );
    const errors = verifyCanonicalReleasePublisher(root);
    expect(errors).toContain(
      "release publisher has an unexpected asset: .release-evidence/reports/*",
    );
    expect(
      errors.some((error) =>
        error.includes("release publisher is missing canonical asset:"),
      ),
    ).toBe(true);
  });

  it("requires unmatched exact release asset paths to fail", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "          fail_on_unmatched_files: true\n",
        "",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "canonical publisher must fail when an exact release asset path is missing",
    );
  });

  it("requires signing proof for every installer/archive subject", () => {
    const assets = [
      {
        artifactId: 1,
        kind: "desktop-installer",
        artifactName: "SkyTwin-macOS-dmg",
        artifactSha256: "1".repeat(64),
        subjects: [
          {
            name: "a.dmg",
            path: "a.dmg",
            sha256: "a".repeat(64),
            sizeBytes: 10,
          },
        ],
      },
      {
        artifactId: 2,
        kind: "desktop-archive",
        artifactName: "SkyTwin-macOS-zip",
        artifactSha256: "2".repeat(64),
        subjects: [
          {
            name: "a.zip",
            path: "a.zip",
            sha256: "b".repeat(64),
            sizeBytes: 20,
          },
        ],
      },
      {
        kind: "update-manifest",
        subjects: [{ path: "latest.yml", sha256: "c".repeat(64) }],
      },
    ];
    const report = {
      platform: "macos",
      runnerPlatform: "darwin-arm64",
      releaseTag: "v0.7.0-beta",
      coveredSubjects: [
        {
          artifactId: 1,
          artifactName: "SkyTwin-macOS-dmg",
          artifactSha256: "1".repeat(64),
          ...signingProducerFields(1, "SkyTwin-macOS-dmg", "macos"),
          kind: "desktop-installer",
          path: "a.dmg",
          name: "a.dmg",
          sha256: "a".repeat(64),
          sizeBytes: 10,
          platform: "macos-arm64",
          signatureResult: "pass",
          notarizationResult: "pass",
          verificationMethod:
            "dmg-codesign+gatekeeper+stapler+dmg-contained-app-codesign",
          signer: "Developer ID Application: SkyTwin Test (TEAM123456)",
          signerTeamId: "TEAM123456",
          signedIdentifier: "com.skytwin.desktop",
          signedContentCdHash: "d".repeat(40),
          signedBundleVersion: "0.7.0",
          signedBundleBuildVersion: "0.7.0",
          executableArchitecture: "arm64",
          containerSignature: {
            signatureResult: "pass",
            signer: "Developer ID Application: SkyTwin Test (TEAM123456)",
            signerTeamId: "TEAM123456",
            signedIdentifier: "com.skytwin.desktop.dmg",
            signedContentCdHash: "e".repeat(40),
          },
        },
      ],
    };
    expect(
      verifyMachineEvidenceApplicability("release.signing", report, assets),
    ).toHaveLength(1);
    report.coveredSubjects.push({
      artifactId: 2,
      artifactName: "SkyTwin-macOS-zip",
      artifactSha256: "2".repeat(64),
      ...signingProducerFields(2, "SkyTwin-macOS-zip", "macos"),
      kind: "desktop-archive",
      path: "a.zip",
      name: "a.zip",
      sha256: "b".repeat(64),
      sizeBytes: 20,
      platform: "macos-arm64",
      signatureResult: "pass",
      notarizationResult: "pass",
      verificationMethod:
        "bounded-volume+ditto-contained-app+codesign+gatekeeper+stapler",
      signer: "Developer ID Application: SkyTwin Test (TEAM123456)",
      signerTeamId: "TEAM123456",
      signedIdentifier: "com.skytwin.desktop",
      signedContentCdHash: "d".repeat(40),
      signedBundleVersion: "0.7.0",
      signedBundleBuildVersion: "0.7.0",
      executableArchitecture: "arm64",
      containerSignature: null,
    });
    expect(
      verifyMachineEvidenceApplicability("release.signing", report, assets),
    ).toEqual([]);

    for (const [field, tampered] of [
      ["artifactId", 99],
      ["artifactSha256", "9".repeat(64)],
      ["kind", "desktop-archive"],
      ["name", "other.dmg"],
      ["sizeBytes", 11],
      ["signedContentCdHash", undefined],
      ["signedBundleVersion", "0.6.99"],
      ["signedBundleBuildVersion", "0.6.99"],
      ["executableArchitecture", "x86_64"],
      ["verificationMethod", "codesign-only"],
      ["signerTeamId", "OTHER12345"],
    ]) {
      const changed = structuredClone(report);
      if (tampered === undefined) delete changed.coveredSubjects[0][field];
      else changed.coveredSubjects[0][field] = tampered;
      expect(
        verifyMachineEvidenceApplicability("release.signing", changed, assets),
        `tampered ${field}`,
      ).toHaveLength(1);
    }
    const extraField = structuredClone(report);
    extraField.coveredSubjects[0].unexpected = true;
    expect(
      verifyMachineEvidenceApplicability("release.signing", extraField, assets),
    ).toHaveLength(1);
    const mismatchedContainer = structuredClone(report);
    mismatchedContainer.coveredSubjects[0].containerSignature.signer =
      "Developer ID Application: Other Publisher (TEAM123456)";
    expect(
      verifyMachineEvidenceApplicability(
        "release.signing",
        mismatchedContainer,
        assets,
      ),
    ).toHaveLength(1);
  });

  it("requires complete pinned Windows signature observations", () => {
    const assets = [
      {
        artifactId: 1,
        kind: "desktop-installer",
        artifactName: "SkyTwin-Windows-installer",
        artifactSha256: "1".repeat(64),
        subjects: [
          {
            name: "SkyTwin.exe",
            path: "SkyTwin.exe",
            sha256: "a".repeat(64),
            sizeBytes: 10,
          },
        ],
      },
    ];
    const report = {
      platform: "windows",
      runnerPlatform: "win32-x64",
      releaseTag: "v0.7.0-beta",
      coveredSubjects: [
        {
          artifactId: 1,
          artifactName: "SkyTwin-Windows-installer",
          artifactSha256: "1".repeat(64),
          ...signingProducerFields(1, "SkyTwin-Windows-installer", "windows"),
          kind: "desktop-installer",
          path: "SkyTwin.exe",
          name: "SkyTwin.exe",
          sha256: "a".repeat(64),
          sizeBytes: 10,
          platform: "windows-x64",
          signatureResult: "pass",
          verificationMethod:
            "Get-AuthenticodeSignature(Status=Valid)+pinned-signer-certificate",
          authenticodeStatus: "Valid",
          authenticodeSignatureType: "Authenticode",
          signer: "CN=SkyTwin Publisher",
          signerIssuer: "CN=Public Code Signing CA",
          signerCertificateSha256: "b".repeat(64),
          signerCertificatePinned: true,
          codeSigningEku: true,
          timestampCertificatePresent: true,
          timestampSignerCertificateSha256: "c".repeat(64),
          timestampCertificateValidation:
            "presence-and-fingerprint-recorded-not-independently-validated",
          productVersion: "0.7.0.0",
          fileVersionMajor: 0,
          fileVersionMinor: 7,
          fileVersionBuild: 0,
          fileVersionPrivate: 0,
          containedExecutable: {
            derivationMethod: "nsis-7zip",
            derivationPath: "app-64.7z!/SkyTwin.exe",
            name: "SkyTwin.exe",
            sha256: "d".repeat(64),
            sizeBytes: 128,
            architecture: "AMD64",
            productVersion: "0.7.0.0",
            fileVersionMajor: 0,
            fileVersionMinor: 7,
            fileVersionBuild: 0,
            fileVersionPrivate: 0,
            signatureResult: "pass",
            verificationMethod:
              "Get-AuthenticodeSignature(Status=Valid)+pinned-signer-certificate",
            authenticodeStatus: "Valid",
            authenticodeSignatureType: "Authenticode",
            signer: "CN=SkyTwin Publisher",
            signerIssuer: "CN=Public Code Signing CA",
            signerCertificateSha256: "b".repeat(64),
            signerCertificatePinned: true,
            codeSigningEku: true,
            timestampCertificatePresent: true,
            timestampSignerCertificateSha256: "c".repeat(64),
            timestampCertificateValidation:
              "presence-and-fingerprint-recorded-not-independently-validated",
          },
        },
      ],
    };
    expect(
      verifyMachineEvidenceApplicability("release.signing", report, assets),
    ).toEqual([]);

    for (const [field, tampered] of [
      ["artifactId", 99],
      ["artifactSha256", "9".repeat(64)],
      ["kind", "desktop-archive"],
      ["name", "other.exe"],
      ["sizeBytes", 11],
      ["codeSigningEku", undefined],
      ["signerCertificatePinned", false],
      ["signerCertificateSha256", "not-a-digest"],
      ["timestampCertificatePresent", false],
      ["productVersion", "0.6.0"],
      ["fileVersionBuild", 99],
      ["verificationMethod", "fingerprint-only"],
    ]) {
      const changed = structuredClone(report);
      if (tampered === undefined) delete changed.coveredSubjects[0][field];
      else changed.coveredSubjects[0][field] = tampered;
      expect(
        verifyMachineEvidenceApplicability("release.signing", changed, assets),
        `tampered ${field}`,
      ).toHaveLength(1);
    }
    for (const [field, tampered] of [
      ["sha256", "not-a-digest"],
      ["architecture", "I386"],
      ["productVersion", "0.6.0"],
      ["signer", "CN=Other"],
      ["fileVersionPrivate", 1],
    ]) {
      const changed = structuredClone(report);
      changed.coveredSubjects[0].containedExecutable[field] = tampered;
      expect(
        verifyMachineEvidenceApplicability("release.signing", changed, assets),
        `tampered contained executable ${field}`,
      ).toHaveLength(1);
    }
    const extraField = structuredClone(report);
    extraField.coveredSubjects[0].containedExecutable.unexpected = true;
    expect(
      verifyMachineEvidenceApplicability("release.signing", extraField, assets),
    ).toHaveLength(1);
  });

  it("rejects signing evidence asserted by the wrong native platform", () => {
    const assets = [
      {
        kind: "desktop-installer",
        artifactName: "SkyTwin-Windows-installer",
        subjects: [{ path: "SkyTwin.exe", sha256: "a".repeat(64) }],
      },
    ];
    const report = {
      platform: "linux",
      coveredSubjects: [
        {
          path: "SkyTwin.exe",
          sha256: "a".repeat(64),
          platform: "windows",
          signatureResult: "pass",
        },
      ],
    };
    expect(
      verifyMachineEvidenceApplicability("release.signing", report, assets),
    ).toHaveLength(1);
  });

  it("requires post-package verification evidence for every release subject", () => {
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const assets = [
      {
        kind: "desktop-installer",
        subjects: [{ path: "a.dmg", sha256: "a".repeat(64) }],
      },
      {
        kind: "desktop-archive",
        subjects: [{ path: "a.zip", sha256: "b".repeat(64) }],
      },
      {
        kind: "update-manifest",
        subjects: [{ path: "latest.yml", sha256: "c".repeat(64) }],
      },
    ];
    const verificationAssets = [
      {
        kind: "checksums",
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/SHA256SUMS`,
        sha256: "d".repeat(64),
      },
      {
        kind: "sbom",
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/release.spdx.json`,
        sha256: "e".repeat(64),
      },
      {
        kind: "verification-instructions",
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/VERIFY.md`,
        sha256: "f".repeat(64),
      },
      ...assets.flatMap((asset) =>
        asset.subjects.map((subject) => ({
          kind: "provenance-bundle",
          path: `${ARTIFACT_VERIFICATION_DIRECTORY}/${subject.sha256}.attestation.jsonl`,
          sha256: subject.sha256,
        })),
      ),
    ];
    const evidenceFor = ({ path, sha256 }) => ({
      path,
      sha256,
      checksum: {
        algorithm: "sha256",
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/SHA256SUMS`,
        sha256: "d".repeat(64),
        subjectSha256: sha256,
        result: "pass",
      },
      sbom: {
        format: "spdx-json",
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/release.spdx.json`,
        sha256: "e".repeat(64),
        subjectSha256: sha256,
        result: "pass",
      },
      provenance: {
        verificationMethod: "gh-attestation-verify",
        bundlePath: `${ARTIFACT_VERIFICATION_DIRECTORY}/${sha256}.attestation.jsonl`,
        bundleSha256: sha256,
        sourceCommit,
        subjectSha256: sha256,
        result: "pass",
      },
      verificationInstructions: {
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/VERIFY.md`,
        sha256: "f".repeat(64),
        subjectSha256: sha256,
        result: "pass",
      },
    });
    const report = {
      sourceCommit,
      coveredSubjects: [evidenceFor(assets[0].subjects[0])],
    };
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        report,
        assets,
        verificationAssets,
      ),
    ).toHaveLength(1);

    report.coveredSubjects = assets.flatMap((asset) =>
      asset.subjects.map(evidenceFor),
    );
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        report,
        assets,
        verificationAssets,
      ),
    ).toEqual([]);

    const missingSbom = structuredClone(report);
    missingSbom.coveredSubjects[1].sbom = undefined;
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        missingSbom,
        assets,
        verificationAssets,
      ),
    ).toHaveLength(1);

    const wrongProvenanceCommit = structuredClone(report);
    wrongProvenanceCommit.coveredSubjects[2].provenance.sourceCommit =
      "f".repeat(40);
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        wrongProvenanceCommit,
        assets,
        verificationAssets,
      ),
    ).toHaveLength(1);

    const missingInstructions = structuredClone(report);
    missingInstructions.coveredSubjects[0].verificationInstructions = undefined;
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        missingInstructions,
        assets,
        verificationAssets,
      ),
    ).toHaveLength(1);

    const selfAssertedOnly = structuredClone(report);
    selfAssertedOnly.coveredSubjects[0].provenance = {
      attestationId: "not-independent-proof",
      sourceCommit,
      subjectSha256: selfAssertedOnly.coveredSubjects[0].sha256,
      result: "pass",
    };
    expect(
      verifyMachineEvidenceApplicability(
        "release.artifact-verification",
        selfAssertedOnly,
        assets,
        verificationAssets,
      ),
    ).toHaveLength(1);
  });

  it("hashes real artifact-verification materials and independently verifies every provenance bundle", async () => {
    const root = makeRoot();
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const releaseAssets = makeReleaseAssets(root);
    const verificationAssets = makeVerificationAssets(root, releaseAssets);
    const report = makeArtifactVerificationReport(
      releaseAssets,
      verificationAssets,
      sourceCommit,
    );
    const attestationVerifier = vi.fn().mockResolvedValue(undefined);
    const context = {
      root,
      manifest: { releaseAssets, verificationAssets },
      report,
      repository: "owner/repository",
      releaseCommit: sourceCommit,
      triggerRef: "refs/tags/v0.7.0-beta",
      githubToken: "token",
    };
    expect(
      await verifyArtifactVerificationMaterials(context, attestationVerifier),
    ).toEqual([]);
    expect(attestationVerifier).toHaveBeenCalledTimes(releaseAssets.length);
    expect(attestationVerifier).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "owner/repository",
        sourceCommit,
        sourceRef: "refs/tags/v0.7.0-beta",
      }),
    );

    write(
      root,
      `${ARTIFACT_VERIFICATION_DIRECTORY}/VERIFY.md`,
      "tampered instructions\n",
    );
    expect(
      await verifyArtifactVerificationMaterials(context, attestationVerifier),
    ).toContain(
      `artifact-verification material digest changed: ${ARTIFACT_VERIFICATION_DIRECTORY}/VERIFY.md`,
    );
  });

  it("invokes GitHub's cryptographic verifier with exact provenance identity constraints", () => {
    const execute = vi.fn().mockReturnValue('[{"verificationResult":{}}]');
    verifyGitHubArtifactAttestation(
      {
        subjectPath: "/tmp/app.dmg",
        bundlePath: "/tmp/app.attestation.jsonl",
        repository: "owner/repository",
        sourceCommit: "a".repeat(40),
        sourceRef: "refs/tags/v0.7.0-beta",
        token: "token",
      },
      execute,
    );
    expect(execute).toHaveBeenCalledWith(
      "gh",
      [
        "attestation",
        "verify",
        "/tmp/app.dmg",
        "--repo",
        "owner/repository",
        "--bundle",
        "/tmp/app.attestation.jsonl",
        "--source-digest",
        "a".repeat(40),
        "--source-ref",
        "refs/tags/v0.7.0-beta",
        "--signer-workflow",
        "github.com/owner/repository/.github/workflows/build.yml",
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--format",
        "json",
      ],
      expect.objectContaining({
        encoding: "utf8",
        env: expect.objectContaining({ GH_TOKEN: "token" }),
      }),
    );
  });

  it("rejects extra materials and failed cryptographic attestations", async () => {
    const root = makeRoot();
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const releaseAssets = makeReleaseAssets(root);
    const verificationAssets = makeVerificationAssets(root, releaseAssets);
    const report = makeArtifactVerificationReport(
      releaseAssets,
      verificationAssets,
      sourceCommit,
    );
    const context = {
      root,
      manifest: { releaseAssets, verificationAssets },
      report,
      repository: "owner/repository",
      releaseCommit: sourceCommit,
      triggerRef: "refs/tags/v0.7.0-beta",
      githubToken: "token",
    };
    write(
      root,
      `${ARTIFACT_VERIFICATION_DIRECTORY}/unpublished.txt`,
      "extra\n",
    );
    expect(
      await verifyArtifactVerificationMaterials(context, vi.fn()),
    ).toContain(
      "artifact-verification material inventory does not exactly equal the manifest",
    );

    rmSync(join(root, ARTIFACT_VERIFICATION_DIRECTORY, "unpublished.txt"));
    const failedVerifier = vi
      .fn()
      .mockRejectedValue(new Error("signature did not verify"));
    const errors = await verifyArtifactVerificationMaterials(
      context,
      failedVerifier,
    );
    expect(errors).toHaveLength(releaseAssets.length);
    expect(
      errors.every((error) => error.includes("signature did not verify")),
    ).toBe(true);
  });

  it("rejects duplicate flattened filenames while allowing provenance bundles to be shared by digest", async () => {
    const root = makeRoot();
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const releaseAssets = makeReleaseAssets(root);
    releaseAssets[1].subjects[0].name = releaseAssets[0].subjects[0].name;
    releaseAssets[1].subjects[0].sha256 = releaseAssets[0].subjects[0].sha256;
    const verificationAssets = makeVerificationAssets(root, releaseAssets);
    const report = makeArtifactVerificationReport(
      releaseAssets,
      verificationAssets,
      sourceCommit,
    );
    const errors = await verifyArtifactVerificationMaterials(
      {
        root,
        manifest: { releaseAssets, verificationAssets },
        report,
        repository: "owner/repository",
        releaseCommit: sourceCommit,
        triggerRef: "refs/tags/v0.7.0-beta",
        githubToken: "token",
      },
      vi.fn(),
    );
    expect(errors).toContain(
      "canonical release subjects must have unique published filenames",
    );
    expect(
      verificationAssets.filter((asset) => asset.kind === "provenance-bundle"),
    ).toHaveLength(releaseAssets.length - 1);
  });

  it.each([
    ["SHA256SUMS", "bad checksum material\n", "SHA256SUMS must exactly cover"],
    [
      "release.spdx.json",
      `${JSON.stringify({ spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0" })}\n`,
      "SPDX SBOM must satisfy the SPDX 2.3",
    ],
    [
      "VERIFY.md",
      "No verification commands are documented.\n",
      "verification instructions must exactly match",
    ],
  ])(
    "rejects semantically incomplete %s material",
    async (name, content, expected) => {
      const root = makeRoot();
      const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
      const releaseAssets = makeReleaseAssets(root);
      const verificationAssets = makeVerificationAssets(root, releaseAssets);
      const asset = verificationAssets.find(
        (candidate) => candidate.name === name,
      );
      write(root, asset.path, content);
      asset.sha256 = createHash("sha256").update(content).digest("hex");
      const report = makeArtifactVerificationReport(
        releaseAssets,
        verificationAssets,
        sourceCommit,
      );
      const errors = await verifyArtifactVerificationMaterials(
        {
          root,
          manifest: { releaseAssets, verificationAssets },
          report,
          repository: "owner/repository",
          releaseCommit: sourceCommit,
          triggerRef: "refs/tags/v0.7.0-beta",
          githubToken: "token",
        },
        vi.fn(),
      );
      expect(errors.some((error) => error.includes(expected))).toBe(true);
    },
  );

  it.each([
    ["document creationInfo", (sbom) => delete sbom.creationInfo],
    ["document namespace", (sbom) => delete sbom.documentNamespace],
    ["package analysis state", (sbom) => delete sbom.packages[0].filesAnalyzed],
    [
      "false package analysis state",
      (sbom) => (sbom.packages[0].filesAnalyzed = false),
    ],
    ["package version", (sbom) => delete sbom.packages[0].versionInfo],
    [
      "package verification code",
      (sbom) => delete sbom.packages[0].packageVerificationCode,
    ],
    [
      "incorrect package verification code",
      (sbom) =>
        (sbom.packages[0].packageVerificationCode.packageVerificationCodeValue =
          "0".repeat(40)),
    ],
    ["package/file relationships", (sbom) => delete sbom.relationships],
    [
      "unknown relationship type",
      (sbom) =>
        (sbom.relationships[0].relationshipType = "NOT_AN_SPDX_RELATIONSHIP"),
    ],
    [
      "near-miss relationship type",
      (sbom) => (sbom.relationships[0].relationshipType = "DEPENDENT_OF"),
    ],
    [
      "package downloadLocation",
      (sbom) => delete sbom.packages[0].downloadLocation,
    ],
    ["file checksums", (sbom) => delete sbom.files[0].checksums],
    ["SPDX element ID pattern", (sbom) => (sbom.files[0].SPDXID = "bad/id")],
    [
      "UTC creation timestamp",
      (sbom) => (sbom.creationInfo.created = "September 14, 2026"),
    ],
    [
      "calendar-valid creation timestamp",
      (sbom) => (sbom.creationInfo.created = "2026-02-31T00:00:00Z"),
    ],
    [
      "lowercase checksum value",
      (sbom) => (sbom.files[0].checksums[0].checksumValue = "A".repeat(64)),
    ],
  ])("rejects an SPDX 2.3 SBOM with invalid %s", async (_field, mutate) => {
    const root = makeRoot();
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const releaseAssets = makeReleaseAssets(root);
    const verificationAssets = makeVerificationAssets(root, releaseAssets);
    const asset = verificationAssets.find(
      (candidate) => candidate.name === "release.spdx.json",
    );
    const sbom = JSON.parse(readFileSync(join(root, asset.path), "utf8"));
    mutate(sbom);
    const content = `${JSON.stringify(sbom)}\n`;
    write(root, asset.path, content);
    asset.sha256 = createHash("sha256").update(content).digest("hex");
    const report = makeArtifactVerificationReport(
      releaseAssets,
      verificationAssets,
      sourceCommit,
    );
    const errors = await verifyArtifactVerificationMaterials(
      {
        root,
        manifest: { releaseAssets, verificationAssets },
        report,
        repository: "owner/repository",
        releaseCommit: sourceCommit,
        triggerRef: "refs/tags/v0.7.0-beta",
        githubToken: "token",
      },
      vi.fn(),
    );
    expect(errors.some((error) => error.includes("SPDX 2.3"))).toBe(true);
  });

  it("accepts the SPDX 2.3 DEPENDS_ON relationship token", () => {
    const root = makeRoot();
    const releaseAssets = makeReleaseAssets(root);
    makeVerificationAssets(root, releaseAssets);
    const sbom = JSON.parse(
      readFileSync(
        join(root, ARTIFACT_VERIFICATION_DIRECTORY, "release.spdx.json"),
        "utf8",
      ),
    );
    sbom.relationships.push({
      spdxElementId: "SPDXRef-ReleaseSubject-0",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "SPDXRef-Package",
    });
    expect(isValidSpdx23Document(sbom)).toBe(true);
  });

  it("rejects a do-not-run guide even when it embeds every canonical command", async () => {
    const root = makeRoot();
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const releaseAssets = makeReleaseAssets(root);
    const verificationAssets = makeVerificationAssets(root, releaseAssets);
    const asset = verificationAssets.find(
      (candidate) => candidate.name === "VERIFY.md",
    );
    const canonical = readFileSync(join(root, asset.path), "utf8");
    const content = `Do not run any of these commands.\n\n${canonical}`;
    write(root, asset.path, content);
    asset.sha256 = createHash("sha256").update(content).digest("hex");
    const report = makeArtifactVerificationReport(
      releaseAssets,
      verificationAssets,
      sourceCommit,
    );
    const errors = await verifyArtifactVerificationMaterials(
      {
        root,
        manifest: { releaseAssets, verificationAssets },
        report,
        repository: "owner/repository",
        releaseCommit: sourceCommit,
        triggerRef: "refs/tags/v0.7.0-beta",
        githubToken: "token",
      },
      vi.fn(),
    );
    expect(errors.some((error) => error.includes("exactly match"))).toBe(true);
  });

  it("does not let a longer subject-name substring hide an omitted command", async () => {
    const root = makeRoot();
    const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
    const releaseAssets = makeReleaseAssets(root);
    releaseAssets[0].subjects[0].name = "SkyTwin.exe";
    releaseAssets[1].subjects[0].name = "SkyTwin.exe.blockmap";
    const verificationAssets = makeVerificationAssets(root, releaseAssets);
    const asset = verificationAssets.find(
      (candidate) => candidate.name === "VERIFY.md",
    );
    const canonical = readFileSync(join(root, asset.path), "utf8");
    const content = canonical
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("gh attestation verify 'SkyTwin.exe' --repo"),
      )
      .join("\n");
    expect(content).toContain("SkyTwin.exe");
    write(root, asset.path, content);
    asset.sha256 = createHash("sha256").update(content).digest("hex");
    const report = makeArtifactVerificationReport(
      releaseAssets,
      verificationAssets,
      sourceCommit,
    );
    const errors = await verifyArtifactVerificationMaterials(
      {
        root,
        manifest: { releaseAssets, verificationAssets },
        report,
        repository: "owner/repository",
        releaseCommit: sourceCommit,
        triggerRef: "refs/tags/v0.7.0-beta",
        githubToken: "token",
      },
      vi.fn(),
    );
    expect(errors.some((error) => error.includes("exactly match"))).toBe(true);
  });

  it("requires identified, verified model artifacts", () => {
    expect(
      verifyMachineEvidenceApplicability("models.verified-delivery", {}, []),
    ).toHaveLength(1);
    const report = {
      releaseTag: "v0.7.0-beta",
      runId: 123,
      runAttempt: 2,
      runAttemptStartedAt: "2026-09-15T01:02:00Z",
      repository: "owner/repository",
      ref: "refs/tags/v0.7.0-beta",
      releaseArtifactKind: "desktop-installer",
      releaseArtifactId: 456,
      releaseArtifactName: "SkyTwin-Linux-AppImage",
      releaseArtifactSha256: "a".repeat(64),
      releaseArtifactCreatedAt: "2026-09-15T01:02:04Z",
      releaseArtifactAttemptBindingResult:
        "workflow-output-and-producer-window-pass",
      releaseArtifactDownloadPath:
        ".release-evidence/model-delivery-subject/SkyTwin-0.7.0.AppImage",
      releaseArtifactDownloadStepName:
        "Download exact Linux AppImage for model delivery",
      releaseArtifactDownloadStepConclusion: "success",
      releaseArtifactDownloadBindingResult:
        "exact-artifact-id-action-download-pass",
      subjectName: "SkyTwin-0.7.0.AppImage",
      subjectPath: "artifacts/SkyTwin-Linux-AppImage/SkyTwin-0.7.0.AppImage",
      subjectSha256: "b".repeat(64),
      producerJobName:
        "release-machine-evidence / models.verified-delivery / linux",
      desktopProducerJobId: 41,
      desktopProducerJobName: "Desktop — Linux (AppImage + deb + rpm)",
      desktopProducerJobRunAttempt: 2,
      desktopProducerJobConclusion: "success",
      desktopProducerJobStartedAt: "2026-09-15T01:02:01Z",
      desktopProducerJobCompletedAt: "2026-09-15T01:02:07Z",
      desktopUploadStartedAt: "2026-09-15T01:02:03Z",
      desktopUploadCompletedAt: "2026-09-15T01:02:05Z",
      verifierJobId: 42,
      verifierJobName:
        "release-machine-evidence / models.verified-delivery / linux",
      verifierJobRunAttempt: 2,
      verifierJobStatus: "in_progress",
      verifierPath:
        "scripts/release-claims/verifiers/models.verified-delivery.mjs",
      verifierCommand:
        "node scripts/release-claims/verifiers/models.verified-delivery.mjs --platform linux --output .release-evidence/reports/models.verified-delivery.json",
      verifierSha256: "c".repeat(64),
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId: "models.verified-delivery",
      result: "pass",
      sourceCommit: "d".repeat(40),
      platform: "linux",
      runnerPlatform: "linux-x64",
      modelArtifacts: [
        {
          id: "qwen2.5-1.5b-instruct-q4-k-m",
          name: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
          source:
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
          deliveryHost: "us.aws.cdn.hf.co",
          sourceRepository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
          sourceRevision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
          metadata:
            "https://huggingface.co/api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/revision/91cad51170dc346986eccefdc2dd33a9da36ead9?blobs=true",
          metadataRepository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
          metadataRevision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
          metadataCardLicense: "apache-2.0",
          metadataSiblingName: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
          metadataSiblingExactBytes: 1_117_320_736,
          metadataSiblingSha256:
            "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
          metadataLicenseSiblingName: "LICENSE",
          metadataLicenseSiblingExactBytes: 11_343,
          metadataLicenseSiblingBlobId:
            "6634c8cc3133b3848ec74b9f275acaaa1ea618ab",
          metadataVerificationResult: "pass",
          license: "Apache-2.0",
          licenseName: "Apache License 2.0",
          licenseUrl:
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
          licenseSource:
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
          licenseExactBytes: 11_343,
          licenseSha256:
            "832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
          licenseBlobId: "6634c8cc3133b3848ec74b9f275acaaa1ea618ab",
          licenseVerificationResult: "pass",
          exactBytes: 1_117_320_736,
          sha256:
            "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
          digestVerificationResult: "pass",
          stableFileIdentityResult: "pass",
          deletionResult: "pass",
        },
      ],
      checks: [
        {
          id: "models.delivery-digest",
          testId: "models.delivery-digest",
          result: "pass",
          observed: {
            assertion:
              "The delivered model bytes match the reviewed immutable source pin",
            measurement:
              "qwen2.5-1.5b-instruct-q4_k_m.gguf 1117320736 bytes sha256:6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
            exitCode: 0,
          },
        },
        {
          id: "models.delivery-license",
          testId: "models.delivery-license",
          result: "pass",
          observed: {
            assertion:
              "The model metadata and license bytes are observed at the same immutable source revision",
            measurement:
              "Qwen/Qwen2.5-1.5B-Instruct-GGUF@91cad51170dc346986eccefdc2dd33a9da36ead9 card=apache-2.0; LICENSE 11343 bytes sha256:832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
            exitCode: 0,
          },
        },
        {
          id: "models.delivery-delete",
          testId: "models.delivery-delete",
          result: "pass",
          observed: {
            assertion:
              "The verified candidate was removed from the isolated verifier workspace",
            measurement:
              "stable inode quarantined and deleted after verification",
            exitCode: 0,
          },
        },
      ],
    };
    expect(
      verifyMachineEvidenceApplicability(
        "models.verified-delivery",
        report,
        [],
      ),
    ).toEqual([]);

    const observedGithubLag = {
      ...report,
      releaseArtifactCreatedAt: "2026-09-15T01:02:06Z",
    };
    expect(
      verifyMachineEvidenceApplicability(
        "models.verified-delivery",
        observedGithubLag,
        [],
      ),
    ).toEqual([]);

    for (const field of Object.keys(report.modelArtifacts[0])) {
      const changed = structuredClone(report);
      changed.modelArtifacts[0][field] =
        `${String(changed.modelArtifacts[0][field])}-changed`;
      expect(
        verifyMachineEvidenceApplicability(
          "models.verified-delivery",
          changed,
          [],
        ),
      ).toHaveLength(1);
    }
    const unexpectedModelField = structuredClone(report);
    unexpectedModelField.modelArtifacts[0].redirectUrl =
      "https://unreviewed.example/model.gguf";
    expect(
      verifyMachineEvidenceApplicability(
        "models.verified-delivery",
        unexpectedModelField,
        [],
      ),
    ).toHaveLength(1);
    const unexpectedReportField = { ...report, unboundOutput: "secret" };
    expect(
      verifyMachineEvidenceApplicability(
        "models.verified-delivery",
        unexpectedReportField,
        [],
      ),
    ).toHaveLength(1);
    for (const changed of [
      { ...report, runAttempt: 1 },
      { ...report, desktopProducerJobRunAttempt: 1 },
      { ...report, verifierJobRunAttempt: 1 },
      { ...report, releaseArtifactCreatedAt: "2026-09-14T01:02:04Z" },
      { ...report, runAttemptStartedAt: "2026-09-15T01:02:02Z" },
      {
        ...report,
        desktopProducerJobStartedAt: "2026-09-15T01:01:59Z",
      },
      {
        ...report,
        desktopUploadStartedAt: "2026-09-15T01:01:59Z",
      },
      {
        ...report,
        releaseArtifactCreatedAt: "2026-09-15T01:02:08Z",
      },
      {
        ...report,
        desktopUploadCompletedAt: "2026-09-15T01:02:08Z",
      },
    ])
      expect(
        verifyMachineEvidenceApplicability(
          "models.verified-delivery",
          changed,
          [],
        ),
      ).toHaveLength(1);
    const changedCheck = structuredClone(report);
    changedCheck.checks[0].observed.measurement = "unbound measurement";
    expect(
      verifyMachineEvidenceApplicability(
        "models.verified-delivery",
        changedCheck,
        [],
      ),
    ).toHaveLength(1);
  });

  it("cross-binds model delivery publication to live attempt and AppImage producer evidence", async () => {
    const root = makeRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const tag = "v0.7.0-beta";
    const ref = `refs/tags/${tag}`;
    const runId = 601;
    const runAttempt = 2;
    const machineJobId = 602;
    const desktopJobId = 603;
    const evidenceArtifactId = 604;
    const releaseAssets = makeReleaseAssets(root, 700);
    const releaseAsset = releaseAssets.find(
      ({ artifactName }) => artifactName === "SkyTwin-Linux-AppImage",
    );
    const subject = releaseAsset.subjects[0];
    const claimId = "models.verified-delivery";
    const producerJobName = machineProducerJobName(claimId, "linux");
    const verifierPath = machineVerifierPath(claimId);
    const verifierCommand = machineVerifierCommand(claimId, "linux");
    const verifierSource = "// model delivery verifier fixture\n";
    const verifierSha256 = createHash("sha256")
      .update(verifierSource)
      .digest("hex");
    write(root, verifierPath, verifierSource);
    const report = {
      releaseTag: tag,
      runId,
      runAttempt,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      repository: "owner/repository",
      ref,
      releaseArtifactKind: releaseAsset.kind,
      releaseArtifactId: releaseAsset.artifactId,
      releaseArtifactName: releaseAsset.artifactName,
      releaseArtifactSha256: releaseAsset.artifactSha256,
      releaseArtifactCreatedAt: "2026-09-15T01:04:00Z",
      releaseArtifactAttemptBindingResult:
        "workflow-output-and-producer-window-pass",
      releaseArtifactDownloadPath: `.release-evidence/model-delivery-subject/${subject.name}`,
      releaseArtifactDownloadStepName:
        "Download exact Linux AppImage for model delivery",
      releaseArtifactDownloadStepConclusion: "success",
      releaseArtifactDownloadBindingResult:
        "exact-artifact-id-action-download-pass",
      subjectName: subject.name,
      subjectPath: subject.path,
      subjectSha256: subject.sha256,
      producerJobName,
      desktopProducerJobId: desktopJobId,
      desktopProducerJobName: "Desktop — Linux (AppImage + deb + rpm)",
      desktopProducerJobRunAttempt: runAttempt,
      desktopProducerJobConclusion: "success",
      desktopProducerJobStartedAt: "2026-09-15T01:01:00Z",
      desktopProducerJobCompletedAt: "2026-09-15T01:06:00Z",
      desktopUploadStartedAt: "2026-09-15T01:03:00Z",
      desktopUploadCompletedAt: "2026-09-15T01:05:00Z",
      verifierJobId: machineJobId,
      verifierJobName: producerJobName,
      verifierJobRunAttempt: runAttempt,
      verifierJobStatus: "in_progress",
      verifierPath,
      verifierCommand,
      verifierSha256,
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      claimId,
      result: "pass",
      sourceCommit: commit,
      platform: "linux",
      runnerPlatform: "linux-x64",
      modelArtifacts: [
        {
          id: "qwen2.5-1.5b-instruct-q4-k-m",
          name: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
          source:
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
          deliveryHost: "us.aws.cdn.hf.co",
          sourceRepository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
          sourceRevision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
          metadata:
            "https://huggingface.co/api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/revision/91cad51170dc346986eccefdc2dd33a9da36ead9?blobs=true",
          metadataRepository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
          metadataRevision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
          metadataCardLicense: "apache-2.0",
          metadataSiblingName: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
          metadataSiblingExactBytes: 1_117_320_736,
          metadataSiblingSha256:
            "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
          metadataLicenseSiblingName: "LICENSE",
          metadataLicenseSiblingExactBytes: 11_343,
          metadataLicenseSiblingBlobId:
            "6634c8cc3133b3848ec74b9f275acaaa1ea618ab",
          metadataVerificationResult: "pass",
          license: "Apache-2.0",
          licenseName: "Apache License 2.0",
          licenseUrl:
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
          licenseSource:
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
          licenseExactBytes: 11_343,
          licenseSha256:
            "832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
          licenseBlobId: "6634c8cc3133b3848ec74b9f275acaaa1ea618ab",
          licenseVerificationResult: "pass",
          exactBytes: 1_117_320_736,
          sha256:
            "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
          digestVerificationResult: "pass",
          stableFileIdentityResult: "pass",
          deletionResult: "pass",
        },
      ],
      checks: [
        {
          id: "models.delivery-digest",
          testId: "models.delivery-digest",
          result: "pass",
          observed: {
            assertion:
              "The delivered model bytes match the reviewed immutable source pin",
            measurement:
              "qwen2.5-1.5b-instruct-q4_k_m.gguf 1117320736 bytes sha256:6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
            exitCode: 0,
          },
        },
        {
          id: "models.delivery-license",
          testId: "models.delivery-license",
          result: "pass",
          observed: {
            assertion:
              "The model metadata and license bytes are observed at the same immutable source revision",
            measurement:
              "Qwen/Qwen2.5-1.5B-Instruct-GGUF@91cad51170dc346986eccefdc2dd33a9da36ead9 card=apache-2.0; LICENSE 11343 bytes sha256:832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
            exitCode: 0,
          },
        },
        {
          id: "models.delivery-delete",
          testId: "models.delivery-delete",
          result: "pass",
          observed: {
            assertion:
              "The verified candidate was removed from the isolated verifier workspace",
            measurement:
              "stable inode quarantined and deleted after verification",
            exitCode: 0,
          },
        },
      ],
    };
    const reportPath =
      ".release-evidence/reports/models.verified-delivery.json";
    const reportBytes = `${JSON.stringify(report)}\n`;
    write(root, reportPath, reportBytes);
    const evidence = {
      claimId,
      kind: "machine",
      checkIds: CANONICAL_MACHINE_EVIDENCE_CHECKS.get(claimId),
      repository: "owner/repository",
      runId,
      runAttempt,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      ref,
      evidenceArtifactId,
      evidenceArtifactName: "release-evidence",
      evidenceArtifactSha256: "c".repeat(64),
      reportPath,
      reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
      sourceCommit: commit,
      releaseTag: tag,
      platform: "linux",
      producerJobId: machineJobId,
      producerJobName,
      producerJobRunAttempt: runAttempt,
      producerJobConclusion: "success",
      verifierPath,
      verifierCommand,
      verifierSha256,
      releaseArtifactKind: releaseAsset.kind,
      releaseArtifactId: releaseAsset.artifactId,
      releaseArtifactName: releaseAsset.artifactName,
      releaseArtifactSha256: releaseAsset.artifactSha256,
      subjectName: subject.name,
      subjectPath: subject.path,
      subjectSha256: subject.sha256,
      why: "fixture",
    };
    const manifest = {
      schemaVersion: 1,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      ref,
      runId,
      runAttempt,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [evidence],
    };
    const machineJob = {
      id: machineJobId,
      run_id: runId,
      name: producerJobName,
      status: "completed",
      conclusion: "success",
      run_attempt: runAttempt,
      started_at: "2026-09-15T01:07:00Z",
      completed_at: "2026-09-15T01:09:00Z",
      head_sha: commit,
      run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
      steps: [
        {
          name: "Download exact Linux AppImage for model delivery",
          conclusion: "success",
        },
        { name: CANONICAL_MACHINE_VERIFIER_STEP, conclusion: "success" },
      ],
    };
    let liveDesktopRunAttempt = runAttempt;
    let liveUploadStartedAt = report.desktopUploadStartedAt;
    let liveAppImageName = releaseAsset.artifactName;
    const desktopJob = ({ live = false } = {}) => ({
      id: desktopJobId,
      run_id: runId,
      name: report.desktopProducerJobName,
      status: "completed",
      conclusion: "success",
      run_attempt: live ? liveDesktopRunAttempt : runAttempt,
      started_at: report.desktopProducerJobStartedAt,
      completed_at: report.desktopProducerJobCompletedAt,
      head_sha: commit,
      run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
      steps: [
        { name: "Package Linux desktop app", conclusion: "success" },
        {
          name: "Upload Linux AppImage",
          conclusion: "success",
          started_at: live
            ? liveUploadStartedAt
            : report.desktopUploadStartedAt,
          completed_at: report.desktopUploadCompletedAt,
        },
      ],
    });
    const apiRoot = "https://api.github.com/repos/owner/repository/actions";
    const runUrl = `${apiRoot}/runs/${runId}`;
    const attemptUrl = `${runUrl}/attempts/${runAttempt}`;
    const attemptJobsUrl = `${attemptUrl}/jobs?per_page=100&page=1`;
    const machineJobUrl = `${apiRoot}/jobs/${machineJobId}`;
    const desktopJobUrl = `${apiRoot}/jobs/${desktopJobId}`;
    const evidenceArtifactUrl = `${apiRoot}/artifacts/${evidenceArtifactId}`;
    const releaseArtifactUrls = new Map(
      releaseAssets.map((asset) => [
        `${apiRoot}/artifacts/${asset.artifactId}`,
        asset,
      ]),
    );
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      const text = String(url);
      requestedUrls.push(text);
      let body;
      if (text === attemptJobsUrl)
        body = { total_count: 2, jobs: [machineJob, desktopJob()] };
      else if (text === attemptUrl)
        body = {
          id: runId,
          run_attempt: runAttempt,
          run_started_at: ATTEMPT_STARTED_AT,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      else if (text === runUrl)
        body = {
          id: runId,
          run_attempt: runAttempt,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      else if (text === machineJobUrl) body = machineJob;
      else if (text === desktopJobUrl) body = desktopJob({ live: true });
      else if (text === evidenceArtifactUrl)
        body = {
          id: evidenceArtifactId,
          name: "release-evidence",
          expired: false,
          digest: `sha256:${"c".repeat(64)}`,
          workflow_run: { id: runId, head_sha: commit },
        };
      else if (releaseArtifactUrls.has(text)) {
        const asset = releaseArtifactUrls.get(text);
        body = releaseAssetApiBody(asset, runId, commit);
        if (asset.artifactId === releaseAsset.artifactId)
          Object.assign(body, {
            name: liveAppImageName,
            created_at: report.releaseArtifactCreatedAt,
            updated_at: report.releaseArtifactCreatedAt,
          });
      } else throw new Error(`unexpected GitHub API URL: ${text}`);
      return { ok: true, json: async () => body };
    };
    const ledger = {
      release: {
        readinessClaims: [
          { claimId, requiredEvidenceKinds: ["source", "machine"] },
        ],
      },
    };
    const options = {
      root,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      runId,
      triggerRef: ref,
      githubToken: "token",
      fetchImpl,
    };
    expect(Date.parse(report.desktopProducerJobCompletedAt)).toBeLessThan(
      Date.parse(machineJob.started_at),
    );
    expect(await verifyPublicationEvidence(ledger, manifest, options)).toEqual(
      [],
    );
    const requestCount = (url) =>
      requestedUrls.filter((requested) => requested === url).length;
    expect(requestCount(runUrl)).toBe(1);
    expect(requestCount(attemptUrl)).toBe(2);
    expect(requestCount(attemptJobsUrl)).toBe(1);
    expect(requestCount(machineJobUrl)).toBe(1);
    expect(requestCount(desktopJobUrl)).toBe(1);
    expect(requestCount(evidenceArtifactUrl)).toBe(1);
    for (const [url, asset] of releaseArtifactUrls)
      expect(requestCount(url)).toBe(
        asset.artifactId === releaseAsset.artifactId ? 2 : 1,
      );
    expect(new Set(requestedUrls)).toEqual(
      new Set([
        runUrl,
        attemptUrl,
        attemptJobsUrl,
        machineJobUrl,
        desktopJobUrl,
        evidenceArtifactUrl,
        ...releaseArtifactUrls.keys(),
      ]),
    );

    liveUploadStartedAt = "2026-09-15T01:02:00Z";
    const exactTimestampErrors = await verifyPublicationEvidence(
      ledger,
      manifest,
      options,
    );
    expect(
      isArtifactCreationWithinProducerWindow(
        report.releaseArtifactCreatedAt,
        liveUploadStartedAt,
        report.desktopProducerJobCompletedAt,
      ),
    ).toBe(true);
    expect(exactTimestampErrors).toEqual([
      "models.verified-delivery machine evidence AppImage artifact is not bound to its exact-attempt successful producer and producer/upload timeline",
    ]);
    liveUploadStartedAt = report.desktopUploadStartedAt;

    liveDesktopRunAttempt = runAttempt - 1;
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("AppImage artifact is not bound"),
      ),
    ).toBe(true);
    liveDesktopRunAttempt = runAttempt;

    liveAppImageName = "SkyTwin-Linux-AppImage-unexpected";
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("release artifact is not the unexpired"),
      ),
    ).toBe(true);
    liveAppImageName = releaseAsset.artifactName;

    liveUploadStartedAt = "2026-09-15T00:59:59Z";
    report.desktopUploadStartedAt = liveUploadStartedAt;
    const invalidChronologyReportBytes = `${JSON.stringify(report)}\n`;
    write(root, reportPath, invalidChronologyReportBytes);
    evidence.reportSha256 = createHash("sha256")
      .update(invalidChronologyReportBytes)
      .digest("hex");
    const chronologyErrors = await verifyPublicationEvidence(
      ledger,
      manifest,
      options,
    );
    expect(
      chronologyErrors.some((error) =>
        error.includes("AppImage artifact is not bound"),
      ),
    ).toBe(true);
    expect(
      chronologyErrors.some((error) =>
        error.includes("complete verifier report contract"),
      ),
    ).toBe(true);
  });

  it("requires stable unpacked executable identity for packaged sample evidence", () => {
    expect(
      verifyMachineEvidenceApplicability(
        "sample.packaged-account-free",
        {},
        [],
      ),
    ).toHaveLength(1);
    expect(
      verifyMachineEvidenceApplicability(
        "sample.packaged-account-free",
        {
          platform: "macos",
          runnerPlatform: "darwin-arm64",
          executedBinary: {
            name: "SkyTwin",
            sizeBytes: 1024,
            sha256: "e".repeat(64),
            device: 1,
            inode: 2,
            identityResult: "pass",
            derivationMethod: "zip-ditto",
            derivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
          },
        },
        [],
      ),
    ).toEqual([]);
    for (const mutation of [
      { runnerPlatform: "linux-x64" },
      { executedBinary: { derivationPath: "decoy/SkyTwin" } },
    ]) {
      const report = {
        platform: "macos",
        runnerPlatform: "darwin-arm64",
        ...mutation,
        executedBinary: {
          name: "SkyTwin",
          sizeBytes: 1024,
          sha256: "e".repeat(64),
          device: 1,
          inode: 2,
          identityResult: "pass",
          derivationMethod: "zip-ditto",
          derivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
          ...(mutation.executedBinary ?? {}),
        },
      };
      expect(
        verifyMachineEvidenceApplicability(
          "sample.packaged-account-free",
          report,
          [],
        ),
      ).toHaveLength(1);
    }
  });

  it("requires native reports for sample mode and signing", () => {
    const root = makeRoot();
    const reportsDirectory = join(root, ".release-evidence", "reports");
    const names = machineReportNamesForClaim("sample.packaged-account-free");
    expect(names).toEqual([
      "sample.packaged-account-free.macos.json",
      "sample.packaged-account-free.windows.json",
      "sample.packaged-account-free.linux.json",
    ]);
    expect(machineReportNamesForClaim("release.signing")).toEqual([
      "release.signing.macos.json",
      "release.signing.windows.json",
      "release.signing.linux.json",
    ]);
    for (const name of names)
      write(root, `.release-evidence/reports/${name}`, "{}\n");
    expect(
      names.map((name) => existsSync(join(reportsDirectory, name))),
    ).toEqual([true, true, true]);
  });

  it("fails closed when an evidence source changes", () => {
    const root = makeRoot();
    write(root, "evidence.txt", "changed");
    const ledger = validLedger();
    ledger.claims[0].evidence[0].sha256 = "0".repeat(64);
    const errors = validateLedgerShape(ledger, root);
    expect(
      errors.some((error) => error.includes("evidence changed: evidence.txt")),
    ).toBe(true);
  });

  it("rejects circular evidence from the ledger itself", () => {
    const root = makeRoot();
    const ledger = validLedger();
    ledger.claims[0].evidence = [
      {
        path: "docs/beta-claim-ledger.json",
        why: "circular assertion",
      },
    ];
    writeValidFixture(root, ledger);
    const errors = runChecks({ root }).errors;
    expect(errors).toContain(
      `${ledger.claims[0].id}: the claim ledger cannot serve as its own evidence: docs/beta-claim-ledger.json`,
    );
  });

  it("reports prohibited copy with a file and line", () => {
    const root = makeRoot();
    write(root, "README.md", "Safe copy.\nSkyTwin runs entirely locally.\n");
    const ledger = validLedger();
    ledger.claimSurfaces = [{ class: "root-public", path: "README.md" }];
    ledger.prohibitedClaims = [
      {
        id: "absolute-local",
        pattern: "runs entirely locally",
        flags: "i",
        reason: "ambiguous boundary",
      },
    ];
    const errors = scanProhibitedClaims(ledger, root);
    expect(errors).toEqual([
      'README.md:2: prohibited release claim absolute-local: "runs entirely locally"',
    ]);
  });

  it("distinguishes source-only sample data from shipped sample and supported-installer claims", () => {
    const root = makeRoot();
    write(
      root,
      "README.md",
      "Packaged installers ship an account-free sample.\nThese are supported public-beta installers.\n",
    );
    const ledger = validLedger();
    ledger.claimSurfaces = [{ class: "root-public", path: "README.md" }];
    ledger.prohibitedClaims = [
      {
        id: "packaged-sample-shipped",
        pattern: "packaged installers? ship (?:an? )?account-free sample",
        flags: "i",
        reason: "sample mode is source-only",
      },
      {
        id: "supported-installer-available",
        pattern: "supported public-beta installers",
        flags: "i",
        reason: "signing evidence is missing",
      },
    ];
    expect(scanProhibitedClaims(ledger, root)).toEqual([
      'README.md:1: prohibited release claim packaged-sample-shipped: "Packaged installers ship an account-free sample"',
      'README.md:2: prohibited release claim supported-installer-available: "supported public-beta installers"',
    ]);
  });

  it("rejects a missing or edited approved statement", () => {
    const root = makeRoot();
    write(root, "README.md", "Different copy.\n");
    const errors = verifyApprovedStatements(validLedger(), root);
    expect(errors[0]).toContain("approved statement is missing, stale");
  });

  it("rejects disagreement between release version sources", () => {
    const root = makeRoot();
    write(root, "VERSION", "0.7.0.0\n");
    write(root, "package.json", '{"version":"0.6.102.0"}\n');
    const errors = verifyVersionSources(validLedger(), root);
    expect(errors[0]).toContain("release version sources disagree");
  });

  it("requires VERSION and package.json as the canonical version sources", () => {
    const root = makeRoot();
    write(root, "VERSION-copy", "0.6.102.0\n");
    write(root, "package-copy.json", '{"version":"0.6.102.0"}\n');
    const ledger = validLedger();
    ledger.release.currentVersionSources = [
      { path: "VERSION-copy", kind: "text" },
      { path: "package-copy.json", kind: "package-json" },
    ];
    const errors = verifyVersionSources(ledger, root);
    expect(errors).toContain(
      "release.currentVersionSources must include VERSION with kind text",
    );
    expect(errors).toContain(
      "release.currentVersionSources must include package.json with kind package-json",
    );
  });

  it.each([
    ["v0.6.102.0", "0.6.102.0"],
    ["v0.7.0-beta", "0.7.0.0"],
    ["v0.7.0-beta.12", "0.7.0.12"],
  ])("normalizes canonical release tag %s safely", (tag, expected) => {
    expect(normalizeReleaseTagToRepositoryVersion(tag)).toBe(expected);
  });

  it.each([
    "v0.7.00-beta",
    "v0.7.0-beta.0",
    "v0.7.0-beta.01",
    "v0.7.0-beta;echo-owned",
    "v0.7.0",
    `v0.7.${"9".repeat(10)}.0`,
  ])("rejects unsafe or ambiguous release tag %s", (tag) => {
    expect(normalizeReleaseTagToRepositoryVersion(tag)).toBeNull();
  });

  it("binds a ready release to the exact tag and four-segment repository version", () => {
    const root = makeRoot();
    const ledger = validLedger();
    ledger.release.status = "ready";
    ledger.release.stopShipConditions[0].status = "met";
    ledger.release.platforms[0].state = "supported";
    for (const claim of ledger.claims) claim.state = "proven";
    writeValidFixture(root, ledger, "0.7.0.0");

    expect(
      verifyReleaseVersionBinding(ledger, root, {
        tag: "v0.7.0-beta",
        requireReady: true,
      }),
    ).toEqual([]);
    expect(
      verifyReleaseVersionBinding(ledger, root, {
        tag: "v0.7.0-beta.1",
        requireReady: true,
      }),
    ).toContain(
      "triggering tag v0.7.0-beta.1 does not match ledger target v0.7.0-beta",
    );
  });

  it("rejects publication when VERSION has not reached the ledger target", () => {
    const root = makeRoot();
    writeValidFixture(root);
    expect(
      verifyReleaseVersionBinding(validLedger(), root, {
        tag: "v0.7.0-beta",
        requireReady: true,
      }),
    ).toContain(
      "ledger target v0.7.0-beta normalizes to repository version 0.7.0.0, but VERSION/package.json contain 0.6.102.0",
    );
  });

  it("requires immutable source hashes and shell-safe allowlisted verification commands", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    write(root, "LICENSE", EVIDENCE);
    const ledger = validLedger();
    delete ledger.claims[0].evidence[0].sha256;
    ledger.claims[0].verification[0].command =
      "pnpm claims:check && echo unsafe";
    const errors = validateLedgerShape(ledger, root);
    expect(
      errors.some((error) =>
        error.includes(".sha256 must be a lowercase SHA-256"),
      ),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("command is not an allowlisted")),
    ).toBe(true);
    expect(isAllowlistedVerificationCommand("pnpm claims:check")).toBe(true);
    expect(isAllowlistedVerificationCommand("pnpm claims:test")).toBe(true);
    expect(
      isAllowlistedVerificationCommand("pnpm test:release-artifacts"),
    ).toBe(true);
    expect(
      isAllowlistedVerificationCommand(
        "pnpm exec vitest run scripts/release-claims/release.artifact-verification.test.mjs",
      ),
    ).toBe(true);
    expect(
      isAllowlistedVerificationCommand(
        "pnpm exec vitest run scripts/release-claims/other.test.mjs",
      ),
    ).toBe(false);
    expect(
      isAllowlistedVerificationCommand(
        "pnpm --filter @skytwin/near-confidential test",
      ),
    ).toBe(true);
    expect(
      isAllowlistedVerificationCommand(
        "pnpm --filter @skytwin/llm-client test",
      ),
    ).toBe(true);
    expect(
      isAllowlistedVerificationCommand('rg -n -- "needle" README.md'),
    ).toBe(true);
    expect(
      isAllowlistedVerificationCommand("rg -n x README.md; rm -rf /"),
    ).toBe(false);
    expect(
      isAllowlistedVerificationCommand("rg -n --pre tool -- x README.md"),
    ).toBe(false);
    expect(
      isAllowlistedVerificationCommand(
        "rg -n --hostname-bin tool -- x README.md",
      ),
    ).toBe(false);
    expect(
      isAllowlistedVerificationCommand("rg -n -- -pattern README.md"),
    ).toBe(false);
    expect(isAllowlistedVerificationCommand("rg -n -- pattern --glob")).toBe(
      false,
    );
    expect(
      isAllowlistedVerificationCommand("rg -n -- pattern ../README.md"),
    ).toBe(false);
  });

  it("keeps post-build evidence out of the source ledger", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    const ledger = validLedger();
    ledger.claims[0].evidence = [
      {
        kind: "ci",
        repository: "owner/repository",
        runId: 123456,
        jobId: 234567,
        jobName: "release-proof",
        artifactId: 345678,
        artifactName: "release-proof",
        artifactSha256: "a".repeat(64),
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        conclusion: "success",
        why: "synthetic validator fixture",
      },
      {
        kind: "machine",
        reportUri: "https://evidence.example/report.json",
        reportSha256: "b".repeat(64),
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        artifactSha256: "a".repeat(64),
        platform: "macos-arm64",
        releaseTag: "v0.7.0-beta",
        why: "synthetic validator fixture",
      },
    ];
    const errors = validateLedgerShape(ledger, root);
    expect(
      errors.some((error) =>
        error.includes("must live in the post-build release evidence manifest"),
      ),
    ).toBe(true);
  });

  it("requires unique stop-ship and approved-statement IDs", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    const ledger = validLedger();
    ledger.release.stopShipConditions.push({
      ...ledger.release.stopShipConditions[0],
    });
    ledger.approvedStatements.push({ ...ledger.approvedStatements[0] });
    const errors = validateLedgerShape(ledger, root);
    expect(errors).toContain("duplicate stop-ship condition id: claims-ci");
    expect(errors).toContain(
      "duplicate approved statement id: readme-release-status",
    );
  });

  it("requires the complete canonical readiness and stop-ship sets", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    const ledger = validLedger();
    writeValidFixture(root, ledger);
    const missingReadiness = ledger.release.readinessClaims.pop().claimId;
    const missingStopShip = ledger.release.stopShipConditions.pop().id;
    const errors = validateLedgerShape(ledger, root);
    expect(errors).toContain(
      `required readiness claim is missing: ${missingReadiness}`,
    );
    expect(errors).toContain(
      `required stop-ship condition is missing: ${missingStopShip}`,
    );
  });

  it("rejects every canonical-ledger weakening independently", () => {
    const root = makeRoot();
    const cases = [
      ["claim deletion", (ledger) => ledger.claims.pop()],
      [
        "readiness evidence swap",
        (ledger) => {
          ledger.release.readinessClaims[0].requiredEvidenceKinds = [
            "source",
            "ci",
          ];
        },
      ],
      ["prohibited rule deletion", (ledger) => ledger.prohibitedClaims.pop()],
      [
        "prohibited rule edit",
        (ledger) => {
          ledger.prohibitedClaims[0].pattern = "never-match-this";
        },
      ],
      [
        "approved statement deletion",
        (ledger) => ledger.approvedStatements.pop(),
      ],
      [
        "approved statement edit",
        (ledger) => {
          ledger.approvedStatements[0].exact = "weaker copy";
        },
      ],
      ["stale asset deletion", (ledger) => ledger.staleAssets.pop()],
      [
        "binary inventory deletion",
        (ledger) => ledger.publicBinaryAssets.pop(),
      ],
      [
        "binary audit deletion",
        (ledger) => {
          delete ledger.binaryAssetAudit;
        },
      ],
      [
        "audit baseline deletion",
        (ledger) => {
          delete ledger.release.auditBaseline;
        },
      ],
      [
        "license deletion",
        (ledger) => {
          ledger.claims = ledger.claims.filter(
            (claim) => claim.id !== "license.apache-2",
          );
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const ledger = validLedger();
      writeValidFixture(root, ledger);
      mutate(ledger);
      expect(validateLedgerShape(ledger, root), name).not.toEqual([]);
    }
  });

  it("does not let a changed binary self-approve by rewriting its ledger hash", () => {
    const root = makeRoot();
    const ledger = validLedger();
    writeValidFixture(root, ledger);
    const asset = ledger.publicBinaryAssets[0];
    const changed = "replacement image bytes";
    write(root, asset.path, changed);
    asset.sha256 = createHash("sha256").update(changed).digest("hex");
    expect(validateLedgerShape(ledger, root)).toContain(
      `${asset.path}: public binary asset digest differs from the audited OCR baseline`,
    );
  });

  it("will not accept ready status while a stop-ship condition is open", () => {
    const root = makeRoot();
    write(root, "evidence.txt", "evidence");
    const ledger = validLedger();
    ledger.release.status = "ready";
    const errors = validateLedgerShape(ledger, root);
    expect(errors).toContain(
      `release cannot be ready with ${REQUIRED_STOP_SHIP_IDS.size} unmet stop-ship condition(s)`,
    );
  });

  it("requires critical readiness claims to accept only proven", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    const ledger = validLedger();
    ledger.release.readinessClaims[0].acceptedStates = ["limited"];
    expect(validateLedgerShape(ledger, root)).toContain(
      "release.readinessClaims[0] is critical and must accept only the proven state",
    );
  });

  it("does not let source-only edits self-declare stop-ship conditions met", () => {
    const root = makeRoot();
    const ledger = validLedger();
    writeValidFixture(root, ledger);
    ledger.release.status = "ready";
    for (const condition of ledger.release.stopShipConditions)
      condition.status = "met";
    ledger.release.platforms[0].state = "supported";
    for (const claim of ledger.claims) claim.state = "proven";
    expect(
      validateLedgerShape(ledger, root).filter((error) =>
        error.includes("must remain open until immutable resolution evidence"),
      ),
    ).toHaveLength(REQUIRED_STOP_SHIP_IDS.size);
  });

  it("does not allow the canonical readiness contract to be weakened", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    const ledger = validLedger();
    ledger.release.status = "ready";
    for (const condition of ledger.release.stopShipConditions)
      condition.status = "met";
    ledger.release.platforms[0].state = "supported";
    for (const claim of ledger.claims) {
      claim.state = "limited";
      claim.limitation = "This individual claim is limited.";
    }
    for (const readiness of ledger.release.readinessClaims) {
      readiness.critical = false;
      readiness.acceptedStates = ["limited"];
      readiness.requiredEvidenceKinds = ["source"];
    }
    expect(
      validateLedgerShape(ledger, root).some((error) =>
        error.includes("readiness contract changed for"),
      ),
    ).toBe(true);
  });

  it.each([
    ["SkyTwin operates fully locally.", "absolute-local-product"],
    ["There is no SkyTwin cloud.", "absolute-no-operated-service"],
    [
      "Nothing is sent to a SkyTwin cloud, because there isn't one.",
      "absolute-no-operated-service",
    ],
    ["No user data ever gets sent to our server.", "absolute-server-transfer"],
    [
      "No Google user data is ever sent to the SkyTwin developers.",
      "absolute-server-transfer",
    ],
    ["Crash reports contain no Google user data.", "absolute-server-transfer"],
    [
      "We cannot sell user data because we do not possess it.",
      "absolute-server-transfer",
    ],
    [
      "The SkyTwin development team has no operational mechanism to read your Google or Microsoft user data.",
      "absolute-server-transfer",
    ],
    ["No data ever leaves the user's machine.", "absolute-device-egress"],
    ["User data stays only on this device.", "absolute-user-data-egress"],
    [
      "Your AI runs privately on this computer.",
      "unverified-private-model-availability",
    ],
    [
      "Packaged artifacts include the account-free sample.",
      "packaged-sample-shipped",
    ],
    [
      "Supported public-beta installer is published.",
      "supported-installer-available",
    ],
    ["Confidential reasoning comes verified.", "unproven-confidential-mode"],
    ["All data stays on your device.", "absolute-user-data-egress"],
    ["SkyTwin is 100% local.", "absolute-percent-local"],
    [
      "The default install uses the embedded llama.cpp runtime.",
      "bundled-default-model",
    ],
    [
      "OAuth credentials are protected with encryption at rest.",
      "oauth-encryption-present-tense",
    ],
    ["Get the supported beta installer now.", "supported-installer-available"],
    [
      "Private on-device AI is included.",
      "unverified-private-model-availability",
    ],
    [
      "Every path through this loop produces an explanation record.",
      "unproven-universal-explanations",
    ],
    ["Every action is explained.", "unproven-universal-explanations"],
    [
      "Each automated decision produces a record.",
      "unproven-universal-explanations",
    ],
  ])("catches prohibited semantic variant: %s", (copy, ruleId) => {
    const root = makeRoot();
    write(root, "README.md", `${copy}\n`);
    const ledger = structuredClone(productionLedger);
    ledger.claimSurfaces = [{ class: "root-public", path: "README.md" }];
    const errors = scanProhibitedClaims(ledger, root);
    expect(errors.some((error) => error.includes(`claim ${ruleId}:`))).toBe(
      true,
    );
  });

  it("does not reject an explicitly scoped local-storage statement", () => {
    const root = makeRoot();
    write(
      root,
      "README.md",
      "The persistent application database is local; connectors and configured hosted providers use the network.\n",
    );
    const ledger = structuredClone(productionLedger);
    ledger.claimSurfaces = [{ class: "root-public", path: "README.md" }];
    expect(scanProhibitedClaims(ledger, root)).toEqual([]);
  });

  it("normalizes markup and whitespace before checking semantic variants", () => {
    const root = makeRoot();
    write(
      root,
      "README.md",
      "<p>All data <strong>stays</strong>\n on your device.</p>\n",
    );
    const ledger = structuredClone(productionLedger);
    ledger.claimSurfaces = [{ class: "root-public", path: "README.md" }];
    expect(
      scanProhibitedClaims(ledger, root).some((error) =>
        error.includes("claim absolute-user-data-egress:"),
      ),
    ).toBe(true);
  });

  it("detects prohibited copy assembled through template interpolation", () => {
    const root = makeRoot();
    write(
      root,
      "copy.js",
      'const copy = `SkyTwin runs ${"entirely"} locally.`;\n',
    );
    const ledger = structuredClone(productionLedger);
    ledger.claimSurfaces = [{ class: "web-public", path: "copy.js" }];
    expect(
      scanProhibitedClaims(ledger, root).some((error) =>
        error.includes("claim absolute-local-product:"),
      ),
    ).toBe(true);
  });

  it("checks encoded HTML attributes, split JavaScript copy, and SVG text", () => {
    const root = makeRoot();
    write(
      root,
      "public/index.html",
      '<img alt="SkyTwin runs&#32;entirely&#32;locally">\n',
    );
    write(
      root,
      "public/copy.js",
      'const claim = "All data " + "stays on your device.";\n',
    );
    write(
      root,
      "public/image.svg",
      "<svg><text>OAuth credentials are protected with encryption at rest.</text></svg>\n",
    );
    const ledger = structuredClone(productionLedger);
    ledger.claimSurfaces = [
      {
        class: "web-public",
        path: "public",
        extensions: [".html", ".js", ".svg"],
      },
    ];
    const errors = scanProhibitedClaims(ledger, root);
    expect(
      errors.some((error) => error.includes("claim absolute-local-product:")),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("claim absolute-user-data-egress:"),
      ),
    ).toBe(true);
    expect(
      errors.some((error) =>
        error.includes("claim oauth-encryption-present-tense:"),
      ),
    ).toBe(true);
  });

  it("rejects external and symlinked approved/evidence/manifest paths", async () => {
    const root = makeRoot();
    const outside = join(root, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, EVIDENCE);
    temporaryRoots.push(outside);
    symlinkSync(outside, join(root, "linked.txt"));

    expect(
      verifyApprovedStatements(
        {
          approvedStatements: [
            { id: "outside", path: outside, exact: "evidence" },
          ],
        },
        root,
      ).some((error) => error.includes("escapes repository root")),
    ).toBe(true);
    expect(
      verifyApprovedStatements(
        {
          approvedStatements: [
            { id: "linked", path: "linked.txt", exact: "evidence" },
          ],
        },
        root,
      ).some((error) => error.includes("non-symlink")),
    ).toBe(true);

    const ledger = validLedger();
    writeValidFixture(root, ledger, "0.7.0.0");
    ledger.claims[0].evidence[0] = {
      path: "linked.txt",
      sha256: EVIDENCE_SHA256,
      why: "must not follow a symlink",
    };
    expect(
      validateLedgerShape(ledger, root).some((error) =>
        error.includes("evidence path must be a real, regular, non-symlink"),
      ),
    ).toBe(true);

    ledger.claims[0].evidence[0] = {
      path: "LICENSE",
      sha256: EVIDENCE_SHA256,
      why: "test evidence",
    };
    ledger.release.status = "ready";
    ledger.release.platforms[0].state = "supported";
    for (const condition of ledger.release.stopShipConditions)
      condition.status = "met";
    for (const claim of ledger.claims) claim.state = "proven";
    writeValidFixture(root, ledger, "0.7.0.0");
    symlinkSync(outside, join(root, "manifest-link.json"));
    const result = await runPublicationChecks({
      root,
      tag: "v0.7.0-beta",
      commit: "0123456789abcdef0123456789abcdef01234567",
      repository: "owner/repository",
      runId: 123,
      ref: "refs/tags/v0.7.0-beta",
      evidenceManifestPath: "manifest-link.json",
    });
    expect(
      result.errors.some((error) =>
        error.includes("must remain open until immutable resolution evidence"),
      ),
    ).toBe(true);
  });

  it("scans the complete changelog even when marker slices are supplied", () => {
    const root = makeRoot();
    const ledger = validLedger();
    ledger.claimSurfaces = [
      {
        class: "root-public",
        path: "CHANGELOG.md",
        startMarker: "<!-- claims:start -->",
        endMarker: "<!-- claims:end -->",
      },
    ];
    write(
      root,
      "CHANGELOG.md",
      "Historical: SkyTwin runs entirely locally.\n<!-- claims:start -->\nCurrent status is blocked.\n<!-- claims:end -->\n",
    );
    expect(scanProhibitedClaims(ledger, root)).toEqual([
      'CHANGELOG.md:1: prohibited release claim absolute-local-product: "SkyTwin runs entirely locally"',
    ]);
    write(
      root,
      "CHANGELOG.md",
      "Historical: SkyTwin runs entirely locally.\n<!-- claims:start -->\nCurrent claim: SkyTwin runs entirely locally.\n<!-- claims:end -->\n",
    );
    expect(scanProhibitedClaims(ledger, root)).toEqual([
      'CHANGELOG.md:1: prohibited release claim absolute-local-product: "SkyTwin runs entirely locally"',
      'CHANGELOG.md:3: prohibited release claim absolute-local-product: "SkyTwin runs entirely locally"',
    ]);
    expect(validateLedgerShape(ledger, root)).toContain(
      "claimSurfaces[0] may not use marker slices; the complete file must be scanned",
    );
  });

  it("fails when a prohibited stale screenshot is referenced or changes", () => {
    const root = makeRoot();
    write(root, "README.md", "![old](docs/screenshots/settings.png)\n");
    write(root, "docs/screenshots/settings.png", "old capture");
    const ledger = validLedger();
    ledger.claimSurfaces = [{ class: "root-public", path: "README.md" }];
    ledger.staleAssets = [
      {
        id: "old-settings",
        path: "docs/screenshots/settings.png",
        state: "prohibited",
        sha256: createHash("sha256").update("old capture").digest("hex"),
        reason: "contains stale copy",
      },
    ];
    expect(scanProhibitedClaims(ledger, root)).toContain(
      "README.md:1: prohibited stale asset reference old-settings: docs/screenshots/settings.png",
    );
    write(
      root,
      "README.md",
      '<img src="docs/screenshots/settings&#46;png" alt="old">\n',
    );
    expect(
      scanProhibitedClaims(ledger, root).some((error) =>
        error.includes("prohibited stale asset reference old-settings"),
      ),
    ).toBe(true);
    write(root, "docs/screenshots/settings.png", "changed capture");
    expect(validateLedgerShape(ledger, root)).toContain(
      "old-settings: stale asset changed: docs/screenshots/settings.png; re-audit or replace it",
    );
  });

  it("cannot publish with fabricated CI and machine evidence records", async () => {
    const root = makeRoot();
    const ledger = validLedger();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    ledger.release.status = "ready";
    ledger.release.platforms[0].state = "supported";
    for (const condition of ledger.release.stopShipConditions)
      condition.status = "met";
    for (const claim of ledger.claims) claim.state = "proven";
    const releaseAssets = makeReleaseAssets(root);
    const manifest = {
      schemaVersion: 1,
      repository: "owner/repository",
      releaseCommit: commit,
      tag: "v0.7.0-beta",
      ref: "refs/tags/v0.7.0-beta",
      runId: 111,
      runAttempt: 1,
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [],
    };
    for (const readiness of ledger.release.readinessClaims) {
      for (const kind of readiness.requiredEvidenceKinds) {
        if (kind === "source") continue;
        manifest.evidence.push(
          kind === "ci"
            ? {
                claimId: readiness.claimId,
                kind,
                checkIds: CANONICAL_CI_EVIDENCE_CHECKS.get(readiness.claimId),
                repository: "owner/repository",
                runId: 111,
                runAttempt: 1,
                ref: "refs/tags/v0.7.0-beta",
                jobId: 222,
                jobName: "release-claim-ci",
                artifactId: 333,
                artifactName: "release-claims-ci",
                artifactSha256: "a".repeat(64),
                reportPath: "artifacts/release-claims-ci/result.json",
                reportSha256: "e".repeat(64),
                commitSha: commit,
                conclusion: "success",
                why: "fabricated record",
              }
            : {
                claimId: readiness.claimId,
                kind,
                checkIds: CANONICAL_MACHINE_EVIDENCE_CHECKS.get(
                  readiness.claimId,
                ),
                repository: "owner/repository",
                runId: 111,
                runAttempt: 1,
                ref: "refs/tags/v0.7.0-beta",
                evidenceArtifactId: 333,
                evidenceArtifactName: "release-evidence",
                evidenceArtifactSha256: "c".repeat(64),
                reportPath: `.release-evidence/reports/${readiness.claimId}.json`,
                reportSha256: "b".repeat(64),
                sourceCommit: commit,
                platform: "macos-arm64",
                releaseTag: "v0.7.0-beta",
                releaseArtifactKind: "desktop-installer",
                releaseArtifactId: 444,
                releaseArtifactName: "SkyTwin-macOS-dmg",
                releaseArtifactSha256: "a".repeat(64),
                subjectName: "SkyTwin.dmg",
                subjectPath: "artifacts/SkyTwin-macOS-dmg/SkyTwin.dmg",
                subjectSha256: "d".repeat(64),
                why: "fabricated record",
              },
        );
      }
    }
    writeValidFixture(root, ledger, "0.7.0.0");
    write(
      root,
      ".release-evidence/manifest.json",
      `${JSON.stringify(manifest)}\n`,
    );
    const result = await runPublicationChecks({
      root,
      tag: "v0.7.0-beta",
      commit,
      repository: "owner/repository",
      runId: 111,
      ref: "refs/tags/v0.7.0-beta",
      evidenceManifestPath: ".release-evidence/manifest.json",
      githubToken: "test-token",
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(
      result.errors.some((error) =>
        error.includes("must remain open until immutable resolution evidence"),
      ),
    ).toBe(true);
  });

  it("rejects arbitrary machine-report URLs without fetching them", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const root = makeRoot();
    const releaseAssets = makeReleaseAssets(root);
    let fetchCalls = 0;
    const errors = await verifyPublicationEvidence(
      {
        release: {
          readinessClaims: [
            {
              claimId: "storage.desktop-crdb",
              requiredEvidenceKinds: ["machine"],
            },
          ],
        },
      },
      {
        schemaVersion: 1,
        repository: "owner/repository",
        releaseCommit: commit,
        tag: "v0.7.0-beta",
        ref: "refs/tags/v0.7.0-beta",
        runId: 1,
        runAttempt: 1,
        runAttemptStartedAt: ATTEMPT_STARTED_AT,
        releaseAssets,
        verificationAssets: makeVerificationAssets(root, releaseAssets),
        evidence: [
          {
            claimId: "storage.desktop-crdb",
            kind: "machine",
            checkIds: CANONICAL_MACHINE_EVIDENCE_CHECKS.get(
              "storage.desktop-crdb",
            ),
            repository: "owner/repository",
            runId: 1,
            runAttempt: 1,
            runAttemptStartedAt: ATTEMPT_STARTED_AT,
            ref: "refs/tags/v0.7.0-beta",
            evidenceArtifactId: 2,
            evidenceArtifactName: "release-evidence",
            evidenceArtifactSha256: "c".repeat(64),
            reportUri: "https://127.0.0.1/private-report.json",
            reportSha256: "b".repeat(64),
            sourceCommit: commit,
            platform: "macos",
            releaseTag: "v0.7.0-beta",
            producerJobRunAttempt: 1,
            releaseArtifactKind: "desktop-installer",
            releaseArtifactId: 3,
            releaseArtifactName: "SkyTwin-macOS-dmg",
            releaseArtifactSha256: "a".repeat(64),
            subjectName: "SkyTwin.dmg",
            subjectPath: "artifacts/SkyTwin-macOS-dmg/SkyTwin.dmg",
            subjectSha256: "d".repeat(64),
          },
        ],
      },
      {
        root,
        repository: "owner/repository",
        releaseCommit: commit,
        tag: "v0.7.0-beta",
        runId: 1,
        triggerRef: "refs/tags/v0.7.0-beta",
        githubToken: "test-token",
        fetchImpl: async () => {
          fetchCalls += 1;
          return { ok: false, status: 500 };
        },
      },
    );
    expect(
      errors.some((error) => error.includes("reportPath must be a safe")),
    ).toBe(true);
    expect(
      errors.some((error) => error.includes("reportUri is not valid")),
    ).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it("binds machine proof to the current tag-push run and exact release artifact", async () => {
    const root = makeRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const tag = "v0.7.0-beta";
    const ref = `refs/tags/${tag}`;
    const runId = 101;
    const claimId = "storage.desktop-crdb";
    const releaseAssets = makeReleaseAssets(root, 303);
    const releaseAsset = releaseAssets.find(
      (asset) => asset.artifactName === "SkyTwin-macOS-zip",
    );
    const subject = releaseAsset.subjects[0];
    const checkIds = CANONICAL_MACHINE_EVIDENCE_CHECKS.get(claimId);
    const producerJobId = 404;
    const producerJobName = machineProducerJobName(claimId, "macos");
    const verifierPath = machineVerifierPath(claimId);
    const verifierCommand = machineVerifierCommand(claimId, "macos");
    const verifierSource = "// reviewed fixture verifier\n";
    const verifierSha256 = createHash("sha256")
      .update(verifierSource)
      .digest("hex");
    write(root, verifierPath, verifierSource);
    const report = {
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      result: "pass",
      checks: [
        {
          id: checkIds[0],
          testId: checkIds[0],
          result: "pass",
          observed: {
            assertion: "packaged persistence survived a restart",
            measurement: "one write/read round trip",
            exitCode: 0,
          },
        },
      ],
      claimId,
      repository: "owner/repository",
      sourceCommit: commit,
      releaseTag: tag,
      ref,
      runId,
      runAttempt: 1,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      platform: "macos",
      runnerPlatform: "darwin-arm64",
      producerJobName,
      verifierPath,
      verifierCommand,
      verifierSha256,
      releaseArtifactKind: "desktop-archive",
      releaseArtifactId: releaseAsset.artifactId,
      releaseArtifactName: releaseAsset.artifactName,
      releaseArtifactSha256: releaseAsset.artifactSha256,
      subjectName: subject.name,
      subjectPath: subject.path,
      subjectSha256: subject.sha256,
      executedBinary: {
        name: "SkyTwin",
        sizeBytes: 1_000,
        sha256: "e".repeat(64),
        device: 10,
        inode: 20,
        identityResult: "pass",
        derivationMethod: "zip-ditto",
        derivationPath: "SkyTwin.app/Contents/MacOS/SkyTwin",
      },
      databaseBinary: {
        name: "cockroach",
        sizeBytes: 2_000,
        sha256: "f".repeat(64),
        identityResult: "pass",
        derivationPath:
          "SkyTwin.app/Contents/Resources/cockroach/darwin-arm64/cockroach",
      },
      storageObservation: {
        userDataRelativePath: "electron",
        storeRelativePath: "electron/crdb-data",
        sqlListener: { host: "127.0.0.1", port: 26257 },
        httpListener: { host: "127.0.0.1", port: 26258 },
        processOwnership: "descendant",
        launchCount: 2,
        markerWriteResult: "pass",
        markerReadAfterRestartResult: "pass",
        markerSha256: "1".repeat(64),
        sameStoreIdentity: true,
        storeNonEmpty: true,
        unexpectedStoreCount: 0,
        gracefulShutdownCount: 2,
        listenersReleased: true,
      },
    };
    const reportPath = `.release-evidence/reports/${claimId}.json`;
    write(root, reportPath, `${JSON.stringify(report)}\n`);
    const manifest = {
      schemaVersion: 1,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      ref,
      runId,
      runAttempt: 1,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [
        {
          claimId,
          kind: "machine",
          checkIds,
          repository: "owner/repository",
          runId,
          runAttempt: 1,
          runAttemptStartedAt: ATTEMPT_STARTED_AT,
          ref,
          evidenceArtifactId: 202,
          evidenceArtifactName: "release-evidence",
          evidenceArtifactSha256: "c".repeat(64),
          reportPath,
          reportSha256: createHash("sha256")
            .update(`${JSON.stringify(report)}\n`)
            .digest("hex"),
          sourceCommit: commit,
          releaseTag: tag,
          platform: report.platform,
          producerJobId,
          producerJobName,
          producerJobRunAttempt: 1,
          producerJobConclusion: "success",
          verifierPath,
          verifierCommand,
          verifierSha256,
          releaseArtifactKind: report.releaseArtifactKind,
          releaseArtifactId: report.releaseArtifactId,
          releaseArtifactName: report.releaseArtifactName,
          releaseArtifactSha256: report.releaseArtifactSha256,
          subjectName: report.subjectName,
          subjectPath: report.subjectPath,
          subjectSha256: report.subjectSha256,
          why: "fixture",
        },
      ],
    };
    const ledger = {
      release: {
        readinessClaims: [
          { claimId, requiredEvidenceKinds: ["source", "machine"] },
        ],
      },
    };
    let runEvent = "push";
    const fetchImpl = async (url) => {
      const text = String(url);
      const id = Number(text.split("/").at(-1));
      let body;
      if (text.includes("/attempts/1/jobs")) {
        const job = {
          id: producerJobId,
          run_id: runId,
          name: producerJobName,
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
          started_at: "2026-09-15T01:01:00Z",
          completed_at: "2026-09-15T01:10:00Z",
          head_sha: commit,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
          steps: [
            {
              name: CANONICAL_MACHINE_VERIFIER_STEP,
              conclusion: "success",
            },
          ],
        };
        body = { total_count: 1, jobs: [job] };
      } else if (text.endsWith("/attempts/1")) {
        body = {
          id: runId,
          run_attempt: 1,
          run_started_at: ATTEMPT_STARTED_AT,
          event: runEvent,
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      } else if (text.endsWith(`/runs/${runId}`)) {
        body = {
          id: runId,
          run_attempt: 1,
          event: runEvent,
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      } else if (String(url).includes("/jobs/")) {
        body = {
          id: producerJobId,
          name: producerJobName,
          status: "completed",
          conclusion: "success",
          run_attempt: 1,
          started_at: "2026-09-15T01:01:00Z",
          completed_at: "2026-09-15T01:10:00Z",
          head_sha: commit,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
          steps: [
            {
              name: CANONICAL_MACHINE_VERIFIER_STEP,
              conclusion: "success",
            },
          ],
        };
      } else if (id === 202) {
        body = {
          id,
          name: "release-evidence",
          expired: false,
          digest: `sha256:${"c".repeat(64)}`,
          workflow_run: { id: runId, head_sha: commit },
        };
      } else {
        const asset = releaseAssets.find(
          (candidate) => candidate.artifactId === id,
        );
        body = releaseAssetApiBody(asset, runId, commit);
      }
      return { ok: true, json: async () => body };
    };
    const options = {
      root,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      runId,
      triggerRef: ref,
      githubToken: "token",
      fetchImpl,
    };
    expect(await verifyPublicationEvidence(ledger, manifest, options)).toEqual(
      [],
    );

    report.checks[0].observed = "an arbitrary passing sentence";
    write(root, reportPath, `${JSON.stringify(report)}\n`);
    manifest.evidence[0].reportSha256 = createHash("sha256")
      .update(`${JSON.stringify(report)}\n`)
      .digest("hex");
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("report is not a passing result"),
      ),
    ).toBe(true);
    report.checks[0].observed = {
      assertion: "packaged persistence survived a restart",
      measurement: "one write/read round trip",
      exitCode: 0,
    };
    write(root, reportPath, `${JSON.stringify(report)}\n`);
    manifest.evidence[0].reportSha256 = createHash("sha256")
      .update(`${JSON.stringify(report)}\n`)
      .digest("hex");

    write(root, verifierPath, "// changed fixture verifier\n");
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) =>
          error.includes("verifier source is missing or does not match"),
      ),
    ).toBe(true);
    write(root, verifierPath, verifierSource);

    manifest.evidence[0].releaseArtifactSha256 = "f".repeat(64);
    report.releaseArtifactSha256 = "f".repeat(64);
    write(root, reportPath, `${JSON.stringify(report)}\n`);
    manifest.evidence[0].reportSha256 = createHash("sha256")
      .update(`${JSON.stringify(report)}\n`)
      .digest("hex");
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("release artifact is not the unexpired"),
      ),
    ).toBe(true);

    runEvent = "workflow_dispatch";
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("not the tag-push build.yml run"),
      ),
    ).toBe(true);
    runEvent = "push";
    manifest.evidence[0].runId = 999;
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("not from the current workflow run"),
      ),
    ).toBe(true);
  });

  it("binds signing publication to the source report artifact and run attempt", async () => {
    const root = makeRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const tag = "v0.7.0-beta";
    const ref = `refs/tags/${tag}`;
    const runId = 801;
    const runAttempt = 2;
    const releaseAssets = makeReleaseAssets(root, 900);
    const releaseAsset = releaseAssets.find(
      ({ artifactName }) => artifactName === "SkyTwin-Windows-installer",
    );
    const subject = releaseAsset.subjects[0];
    const producerJobId = 850;
    const verifierPath = machineVerifierPath("release.signing");
    const verifierCommand = machineVerifierCommand(
      "release.signing",
      "windows",
    );
    const verifierSource = "// signing verifier fixture\n";
    const verifierSha256 = createHash("sha256")
      .update(verifierSource)
      .digest("hex");
    write(root, verifierPath, verifierSource);
    const signature = {
      signatureResult: "pass",
      verificationMethod:
        "Get-AuthenticodeSignature(Status=Valid)+pinned-signer-certificate",
      authenticodeStatus: "Valid",
      authenticodeSignatureType: "Authenticode",
      signer: "CN=SkyTwin Publisher",
      signerIssuer: "CN=Public Code Signing CA",
      signerCertificateSha256: "b".repeat(64),
      signerCertificatePinned: true,
      codeSigningEku: true,
      timestampCertificatePresent: true,
      timestampSignerCertificateSha256: "d".repeat(64),
      timestampCertificateValidation:
        "presence-and-fingerprint-recorded-not-independently-validated",
    };
    const report = {
      schemaVersion: 1,
      generatedBy: "release-machine-verifier",
      result: "pass",
      checks: [
        {
          id: "release.platform-signature-validation",
          testId: "release.platform-signature-validation",
          result: "pass",
          observed: { assertion: "signed", measurement: "one", exitCode: 0 },
        },
      ],
      claimId: "release.signing",
      repository: "owner/repository",
      sourceCommit: commit,
      releaseTag: tag,
      ref,
      runId,
      platform: "windows",
      runnerPlatform: "win32-x64",
      producerJobName: machineProducerJobName("release.signing", "windows"),
      verifierPath,
      verifierCommand,
      verifierSha256,
      releaseArtifactKind: releaseAsset.kind,
      releaseArtifactId: releaseAsset.artifactId,
      releaseArtifactName: releaseAsset.artifactName,
      releaseArtifactSha256: releaseAsset.artifactSha256,
      subjectName: subject.name,
      subjectPath: subject.path,
      subjectSha256: subject.sha256,
      coveredSubjects: [
        {
          artifactId: releaseAsset.artifactId,
          artifactName: releaseAsset.artifactName,
          artifactSha256: releaseAsset.artifactSha256,
          kind: releaseAsset.kind,
          path: subject.path,
          name: subject.name,
          sha256: subject.sha256,
          sizeBytes: subject.sizeBytes,
          platform: "windows-x64",
          ...signature,
          productVersion: "0.7.0.0",
          fileVersionMajor: 0,
          fileVersionMinor: 7,
          fileVersionBuild: 0,
          fileVersionPrivate: 0,
          containedExecutable: {
            derivationMethod: "nsis-7zip",
            derivationPath: "app-64.7z!/SkyTwin.exe",
            name: "SkyTwin.exe",
            sha256: "e".repeat(64),
            sizeBytes: 128,
            architecture: "AMD64",
            productVersion: "0.7.0.0",
            fileVersionMajor: 0,
            fileVersionMinor: 7,
            fileVersionBuild: 0,
            fileVersionPrivate: 0,
            ...signature,
          },
        },
      ],
    };
    const reportPath = ".release-evidence/reports/release.signing.windows.json";
    const sourceReportArtifactId = 880;
    const sourceReportArtifactName = "release-signing-report-windows-attempt-2";
    const sourceReportArtifactSha256 = "f".repeat(64);
    const releaseArtifactCreatedAt = "2026-09-15T01:06:01Z";
    const sourceReportArtifactCreatedAt = "2026-09-15T01:04:01Z";
    const artifactProducers = [
      {
        artifactId: releaseAsset.artifactId,
        artifactName: releaseAsset.artifactName,
        ...signingProducerFields(
          releaseAsset.artifactId,
          releaseAsset.artifactName,
          "windows",
        ),
        artifactCreatedAt: releaseArtifactCreatedAt,
        artifactUpdatedAt: releaseArtifactCreatedAt,
      },
    ];
    Object.assign(report, {
      runAttempt,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      artifactProducers,
    });
    Object.assign(report.coveredSubjects[0], artifactProducers[0]);
    const updatedReportBytes = `${JSON.stringify(report)}\n`;
    const updatedReportSha256 = createHash("sha256")
      .update(updatedReportBytes)
      .digest("hex");
    write(root, reportPath, updatedReportBytes);
    write(
      root,
      ".release-evidence/upload-bindings/release.signing.windows.json.binding.json",
      `${JSON.stringify({
        schemaVersion: 1,
        generatedBy: "release-signing-upload-verifier",
        claimId: "release.signing",
        platform: "windows",
        repository: "owner/repository",
        sourceCommit: commit,
        releaseTag: tag,
        ref,
        runId,
        runAttempt,
        runAttemptStartedAt: ATTEMPT_STARTED_AT,
        artifactProducers,
        reportName: "release.signing.windows.json",
        reportSha256: updatedReportSha256,
        sourceArtifactId: sourceReportArtifactId,
        sourceArtifactName: sourceReportArtifactName,
        sourceArtifactSha256: sourceReportArtifactSha256,
      })}\n`,
    );
    const evidence = {
      claimId: "release.signing",
      kind: "machine",
      checkIds: ["release.platform-signature-validation"],
      repository: "owner/repository",
      runId,
      runAttempt,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      ref,
      evidenceArtifactId: 870,
      evidenceArtifactName: "release-evidence",
      evidenceArtifactSha256: "c".repeat(64),
      reportPath,
      reportSha256: updatedReportSha256,
      artifactProducers,
      sourceReportArtifactId,
      sourceReportArtifactName,
      sourceReportArtifactSha256,
      sourceReportArtifactCreatedAt,
      sourceReportArtifactUpdatedAt: sourceReportArtifactCreatedAt,
      sourceCommit: commit,
      releaseTag: tag,
      platform: "windows",
      producerJobId,
      producerJobName: report.producerJobName,
      producerJobRunAttempt: runAttempt,
      producerJobConclusion: "success",
      verifierPath,
      verifierCommand,
      verifierSha256,
      releaseArtifactKind: releaseAsset.kind,
      releaseArtifactId: releaseAsset.artifactId,
      releaseArtifactName: releaseAsset.artifactName,
      releaseArtifactSha256: releaseAsset.artifactSha256,
      subjectName: subject.name,
      subjectPath: subject.path,
      subjectSha256: subject.sha256,
      why: "fixture",
    };
    const manifest = {
      schemaVersion: 1,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      ref,
      runId,
      runAttempt,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [evidence],
    };
    const fetchImpl = async (url) => {
      const text = String(url);
      const id = Number(text.split("/").at(-1));
      let body;
      if (text.includes(`/attempts/${runAttempt}/jobs`)) {
        const machineJob = {
          id: producerJobId,
          run_id: runId,
          name: report.producerJobName,
          status: "completed",
          conclusion: "success",
          run_attempt: runAttempt,
          started_at: "2026-09-15T01:01:00Z",
          completed_at: "2026-09-15T01:10:00Z",
          head_sha: commit,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
          steps: [
            { name: CANONICAL_MACHINE_VERIFIER_STEP, conclusion: "success" },
            {
              name: "Upload machine evidence report",
              status: "completed",
              conclusion: "success",
              started_at: "2026-09-15T01:02:00Z",
              completed_at: "2026-09-15T01:04:00Z",
            },
            {
              name: "Verify exact uploaded signing report binding",
              conclusion: "success",
            },
          ],
        };
        const desktopJob = {
          id: 500,
          run_id: runId,
          name: "Desktop — Windows (NSIS installer)",
          status: "completed",
          conclusion: "success",
          run_attempt: runAttempt,
          started_at: "2026-09-15T01:01:00Z",
          completed_at: "2026-09-15T01:10:00Z",
          head_sha: commit,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
          steps: [
            {
              name: "Upload Windows installer",
              status: "completed",
              conclusion: "success",
              started_at: "2026-09-15T01:04:00Z",
              completed_at: "2026-09-15T01:06:00Z",
            },
          ],
        };
        body = { total_count: 2, jobs: [machineJob, desktopJob] };
      } else if (text.endsWith(`/attempts/${runAttempt}`))
        body = {
          id: runId,
          run_attempt: runAttempt,
          run_started_at: ATTEMPT_STARTED_AT,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      else if (text.endsWith(`/runs/${runId}`))
        body = {
          id: runId,
          run_attempt: runAttempt,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      else if (text.includes("/jobs/"))
        body = {
          id: producerJobId,
          name: report.producerJobName,
          status: "completed",
          conclusion: "success",
          run_attempt: runAttempt,
          started_at: "2026-09-15T01:01:00Z",
          completed_at: "2026-09-15T01:10:00Z",
          head_sha: commit,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
          steps: [
            { name: CANONICAL_MACHINE_VERIFIER_STEP, conclusion: "success" },
            {
              name: "Upload machine evidence report",
              status: "completed",
              conclusion: "success",
              started_at: "2026-09-15T01:02:00Z",
              completed_at: "2026-09-15T01:04:00Z",
            },
            {
              name: "Verify exact uploaded signing report binding",
              conclusion: "success",
            },
          ],
        };
      else if (id === 870)
        body = {
          id,
          name: "release-evidence",
          expired: false,
          digest: `sha256:${"c".repeat(64)}`,
          workflow_run: { id: runId, head_sha: commit },
        };
      else if (id === sourceReportArtifactId)
        body = {
          id,
          name: sourceReportArtifactName,
          expired: false,
          digest: `sha256:${sourceReportArtifactSha256}`,
          created_at: sourceReportArtifactCreatedAt,
          updated_at: sourceReportArtifactCreatedAt,
          workflow_run: { id: runId, head_sha: commit },
        };
      else {
        const asset = releaseAssets.find(({ artifactId }) => artifactId === id);
        body = releaseAssetApiBody(asset, runId, commit);
        if (asset?.artifactName === "SkyTwin-Windows-installer")
          Object.assign(body, {
            created_at: releaseArtifactCreatedAt,
            updated_at: releaseArtifactCreatedAt,
          });
      }
      return { ok: true, json: async () => body };
    };
    const options = {
      root,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      runId,
      triggerRef: ref,
      githubToken: "token",
      fetchImpl,
    };
    const binding = JSON.parse(
      readFileSync(
        join(
          root,
          ".release-evidence/upload-bindings/release.signing.windows.json.binding.json",
        ),
        "utf8",
      ),
    );
    expect(
      isValidSigningUploadBinding(binding, evidence, {
        repository: "owner/repository",
        releaseCommit: commit,
        tag,
        triggerRef: ref,
        runId,
        runAttempt,
      }),
    ).toBe(true);
    expect(
      isValidSigningUploadBinding(
        { ...binding, runAttempt: runAttempt - 1 },
        evidence,
        {
          repository: "owner/repository",
          releaseCommit: commit,
          tag,
          triggerRef: ref,
          runId,
          runAttempt,
        },
      ),
    ).toBe(false);
    expect(
      isValidSigningSourceReportArtifact(
        {
          id: sourceReportArtifactId,
          name: sourceReportArtifactName,
          expired: false,
          digest: `sha256:${sourceReportArtifactSha256}`,
          created_at: sourceReportArtifactCreatedAt,
          updated_at: sourceReportArtifactCreatedAt,
          workflow_run: { id: runId, head_sha: commit },
        },
        evidence,
        runId,
        commit,
      ),
    ).toBe(true);
    expect(
      isValidSigningSourceReportArtifact(
        {
          id: sourceReportArtifactId,
          name: sourceReportArtifactName,
          expired: false,
          digest: `sha256:${"0".repeat(64)}`,
          created_at: "2026-09-15T01:03:00Z",
          updated_at: "2026-09-15T01:03:00Z",
          workflow_run: { id: runId, head_sha: commit },
        },
        evidence,
        runId,
        commit,
      ),
    ).toBe(false);
    expect(
      await verifyPublicationEvidence(
        {
          release: {
            readinessClaims: [
              {
                claimId: "release.signing",
                requiredEvidenceKinds: ["machine"],
              },
            ],
          },
        },
        manifest,
        options,
      ),
    ).toEqual([
      "release evidence manifest is missing required evidence: release.signing:machine:macos",
      "release evidence manifest is missing required evidence: release.signing:machine:linux",
    ]);

    expect(
      isArtifactCreationWithinProducerWindow(
        "2026-09-15T01:04:01Z",
        "2026-09-15T01:02:00Z",
        "2026-09-15T01:10:00Z",
      ),
    ).toBe(true);
    expect(
      isArtifactCreationWithinProducerWindow(
        "2026-09-15T01:10:01Z",
        "2026-09-15T01:02:00Z",
        "2026-09-15T01:10:00Z",
      ),
    ).toBe(false);
    expect(
      isArtifactCreationWithinProducerWindow(
        "2026-09-15T00:59:59Z",
        "2026-09-15T01:02:00Z",
        "2026-09-15T01:10:00Z",
      ),
    ).toBe(false);
  });

  it("requires CI job/run URL and artifact proof from the current run", async () => {
    const root = makeRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const tag = "v0.7.0-beta";
    const ref = `refs/tags/${tag}`;
    const runId = 901;
    const releaseAssets = makeReleaseAssets(root);
    write(root, RELEASE_CLAIM_CI_LEDGER_PATH, "fixture ledger\n");
    write(root, RELEASE_CLAIM_CI_CONSTANTS_PATH, "fixture constants\n");
    write(root, RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH, "fixture capture\n");
    write(root, RELEASE_CLAIM_CI_HARNESS_PATH, "fixture harness\n");
    for (const path of RELEASE_CLAIM_CI_SOURCE_PATHS.slice(4))
      write(root, path, "fixture safety source\n");
    const ciResult = `${JSON.stringify({
      schemaVersion: 1,
      generatedBy: "release-claim-ci-harness",
      result: "pass",
      repository: "owner/repository",
      runId,
      runAttempt: 1,
      sourceCommit: commit,
      ref,
      event: "push",
      runtime: {
        nodePath: "/opt/hostedtoolcache/node/bin/node",
        nodeSha256: "b".repeat(64),
        pnpmEntryPath:
          "/home/runner/_temp/.skytwin-release-pnpm-set_output_123.cjs",
        pnpmEntrySha256: "c".repeat(64),
      },
      sourceDigests: RELEASE_CLAIM_CI_SOURCE_PATHS.map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex"),
      })),
      claims: [...CANONICAL_CI_EVIDENCE_CHECKS].map(([claimId, checkIds]) => ({
        claimId,
        checks: checkIds.map((id) => ({
          id,
          testId: id,
          result: "pass",
          exitCode: 0,
          command: {
            executable: "/opt/hostedtoolcache/node/bin/node",
            args: [
              "/home/runner/_temp/.skytwin-release-pnpm-set_output_123.cjs",
              ...CANONICAL_CI_EVIDENCE_COMMANDS.get(id).args,
            ],
          },
          observed: `fixture result for ${id}`,
        })),
      })),
    })}\n`;
    write(root, "artifacts/release-claims-ci/result.json", ciResult);
    const adversarialReport = '{"fixture":"adversarial"}\n';
    const adversarialSha256 = createHash("sha256")
      .update(adversarialReport)
      .digest("hex");
    const adversarialChecksum = `${adversarialSha256}  adversarial-evidence.json\n`;
    const safetyReport = '{"fixture":"release-safety"}\n';
    write(
      root,
      "artifacts/release-claims-ci/adversarial-evidence.json",
      adversarialReport,
    );
    write(
      root,
      "artifacts/release-claims-ci/adversarial-evidence.json.sha256",
      adversarialChecksum,
    );
    write(
      root,
      "artifacts/release-claims-ci/release-safety-evidence.json",
      safetyReport,
    );
    const ciContents = new Map([
      ["claim-result", ciResult],
      ["adversarial-report", adversarialReport],
      ["adversarial-checksum", adversarialChecksum],
      ["release-safety-report", safetyReport],
    ]);
    const ciFiles = RELEASE_CLAIM_CI_ARTIFACT_FILES.map(
      ({ role, downloadedPath }) => ({
        role,
        path: downloadedPath,
        sha256: createHash("sha256").update(ciContents.get(role)).digest("hex"),
        sizeBytes: Buffer.byteLength(ciContents.get(role)),
      }),
    );
    const evidence = {
      claimId: "encryption.oauth-default",
      kind: "ci",
      checkIds: CANONICAL_CI_EVIDENCE_CHECKS.get("encryption.oauth-default"),
      repository: "owner/repository",
      runId,
      runAttempt: 1,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      ref,
      jobId: 902,
      jobName: "release-claim-ci",
      artifactId: 903,
      artifactName: "release-claims-ci",
      artifactSha256: "a".repeat(64),
      reportPath: "artifacts/release-claims-ci/result.json",
      reportSha256: createHash("sha256").update(ciResult).digest("hex"),
      commitSha: commit,
      conclusion: "success",
      why: "fixture",
    };
    const ledger = {
      release: {
        readinessClaims: [
          {
            claimId: evidence.claimId,
            requiredEvidenceKinds: ["source", "ci"],
          },
        ],
      },
    };
    const manifest = {
      schemaVersion: 1,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      ref,
      runId,
      runAttempt: 1,
      runAttemptStartedAt: ATTEMPT_STARTED_AT,
      ciEvidenceArtifact: {
        artifactId: 903,
        artifactName: "release-claims-ci",
        artifactSha256: "a".repeat(64),
        artifactCreatedAt: "2026-09-15T01:06:00Z",
        artifactUpdatedAt: "2026-09-15T01:06:00Z",
        repository: "owner/repository",
        sourceCommit: commit,
        ref,
        runId,
        runAttempt: 1,
        runAttemptStartedAt: ATTEMPT_STARTED_AT,
        producerJobId: 902,
        producerJobName: "release-claim-ci",
        producerJobStatus: "completed",
        producerJobConclusion: "success",
        producerJobStartedAt: "2026-09-15T01:01:00Z",
        producerJobCompletedAt: "2026-09-15T01:10:00Z",
        uploadStepName: RELEASE_CLAIM_CI_UPLOAD_STEP,
        uploadStepStatus: "completed",
        uploadStepConclusion: "success",
        uploadStepStartedAt: "2026-09-15T01:05:00Z",
        uploadStepCompletedAt: "2026-09-15T01:07:00Z",
        files: ciFiles,
      },
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [evidence],
    };
    let jobRunId = runId;
    let jobHeadSha = commit;
    let jobsTotalCount = 1;
    let jobConclusion = "success";
    let producerStepConclusion = "success";
    let producerStepCount = 1;
    let uploadStepConclusion = "success";
    let readinessStepConclusion = "success";
    const fetchImpl = async (url) => {
      const text = String(url);
      let body;
      if (text.includes("/attempts/1/jobs")) {
        body = {
          total_count: jobsTotalCount,
          jobs: [
            {
              id: 902,
              run_id: runId,
              name: "release-claim-ci",
              status: "completed",
              conclusion: jobConclusion,
              run_attempt: 1,
              started_at: "2026-09-15T01:01:00Z",
              completed_at: "2026-09-15T01:10:00Z",
              head_sha: jobHeadSha,
              run_url: `https://api.github.com/repos/owner/repository/actions/runs/${runId}`,
            },
          ],
        };
      } else if (text.endsWith("/attempts/1")) {
        body = {
          id: runId,
          run_attempt: 1,
          run_started_at: ATTEMPT_STARTED_AT,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      } else if (text.endsWith(`/runs/${runId}`)) {
        body = {
          id: runId,
          run_attempt: 1,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      } else if (text.includes("/jobs/")) {
        body = {
          id: 902,
          run_id: runId,
          name: "release-claim-ci",
          status: "completed",
          conclusion: jobConclusion,
          run_attempt: 1,
          started_at: "2026-09-15T01:01:00Z",
          completed_at: "2026-09-15T01:10:00Z",
          head_sha: jobHeadSha,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${jobRunId}`,
          steps: [
            {
              name: RELEASE_SAFETY_EVIDENCE_STEP,
              status: "completed",
              conclusion: "success",
            },
            ...Array.from({ length: producerStepCount }, () => ({
              name: RELEASE_CLAIM_CI_PRODUCER_STEP,
              status: "completed",
              conclusion: producerStepConclusion,
            })),
            {
              name: RELEASE_CLAIM_CI_UPLOAD_STEP,
              status: "completed",
              conclusion: uploadStepConclusion,
              started_at: "2026-09-15T01:05:00Z",
              completed_at: "2026-09-15T01:07:00Z",
            },
            {
              name: RELEASE_CLAIM_CI_READINESS_STEP,
              status: "completed",
              conclusion: readinessStepConclusion,
            },
          ],
        };
      } else if (text.endsWith("/903")) {
        body = {
          id: 903,
          name: "release-claims-ci",
          expired: false,
          digest: `sha256:${"a".repeat(64)}`,
          created_at: "2026-09-15T01:06:00Z",
          updated_at: "2026-09-15T01:06:00Z",
          workflow_run: { id: runId, head_sha: commit },
        };
      } else {
        const id = Number(text.split("/").at(-1));
        body = releaseAssetApiBody(
          releaseAssets.find((asset) => asset.artifactId === id),
          runId,
          commit,
        );
      }
      return { ok: true, json: async () => body };
    };
    const adversarialEvidenceVerifier = vi.fn(() => ({ scenarioCount: 10 }));
    const releaseSafetyEvidenceVerifier = vi.fn(() => ({
      status: "limited",
    }));
    const options = {
      root,
      repository: "owner/repository",
      releaseCommit: commit,
      tag,
      runId,
      triggerRef: ref,
      githubToken: "token",
      fetchImpl,
      adversarialEvidenceVerifier,
      releaseSafetyEvidenceVerifier,
    };
    expect(await verifyPublicationEvidence(ledger, manifest, options)).toEqual(
      [],
    );
    expect(adversarialEvidenceVerifier).toHaveBeenCalledWith(
      join(root, "artifacts/release-claims-ci/adversarial-evidence.json"),
      join(
        root,
        "scripts/release-evidence/adversarial-source-checkout-baseline.json",
      ),
      expect.objectContaining({
        expectedCommit: commit,
        trackedExactCheckout: true,
      }),
    );
    expect(releaseSafetyEvidenceVerifier).toHaveBeenCalledWith(
      expect.objectContaining({
        requireComplete: false,
        trackedExactCheckout: true,
        expected: expect.objectContaining({
          sourceCommit: commit,
          runId,
          runAttempt: 1,
        }),
      }),
    );

    const canonicalCiEvidenceArtifact = manifest.ciEvidenceArtifact;
    delete manifest.ciEvidenceArtifact;
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("ciEvidenceArtifact has unexpected"),
      ),
    ).toBe(true);
    manifest.ciEvidenceArtifact = canonicalCiEvidenceArtifact;

    const checksumPath =
      "artifacts/release-claims-ci/adversarial-evidence.json.sha256";
    const checksumBinding = manifest.ciEvidenceArtifact.files.find(
      ({ role }) => role === "adversarial-checksum",
    );
    const originalChecksum = readFileSync(join(root, checksumPath), "utf8");
    const changedChecksum = `${"0".repeat(64)}  adversarial-evidence.json\n`;
    write(root, checksumPath, changedChecksum);
    checksumBinding.sha256 = createHash("sha256")
      .update(changedChecksum)
      .digest("hex");
    checksumBinding.sizeBytes = Buffer.byteLength(changedChecksum);
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("checksum is not canonical"),
      ),
    ).toBe(true);
    write(root, checksumPath, originalChecksum);
    checksumBinding.sha256 = createHash("sha256")
      .update(originalChecksum)
      .digest("hex");
    checksumBinding.sizeBytes = Buffer.byteLength(originalChecksum);

    write(root, "artifacts/release-claims-ci/unexpected.json", "{}\n");
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("member inventory does not exactly equal"),
      ),
    ).toBe(true);
    rmSync(join(root, "artifacts/release-claims-ci/unexpected.json"));

    const safetyPath =
      "artifacts/release-claims-ci/release-safety-evidence.json";
    const outsideSafety = join(root, "outside-safety-evidence.json");
    writeFileSync(outsideSafety, safetyReport);
    rmSync(join(root, safetyPath));
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("member inventory does not exactly equal"),
      ),
    ).toBe(true);
    symlinkSync(outsideSafety, join(root, safetyPath));
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("contains a symlink"),
      ),
    ).toBe(true);
    rmSync(join(root, safetyPath));
    linkSync(outsideSafety, join(root, safetyPath));
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("is not single-link"),
      ),
    ).toBe(true);
    rmSync(join(root, safetyPath));
    rmSync(outsideSafety);
    write(root, safetyPath, safetyReport);

    options.releaseSafetyEvidenceVerifier = vi.fn(() => ({ status: "pass" }));
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("must remain limited"),
      ),
    ).toBe(true);
    options.releaseSafetyEvidenceVerifier = releaseSafetyEvidenceVerifier;

    manifest.ciEvidenceArtifact.artifactCreatedAt = "2026-09-15T01:04:59Z";
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("producer/upload timeline"),
      ),
    ).toBe(true);
    manifest.ciEvidenceArtifact.artifactCreatedAt = "2026-09-15T01:06:00Z";
    const tamperedReport = JSON.parse(ciResult);
    tamperedReport.sourceDigests[0].sha256 = "f".repeat(64);
    const tamperedReportBytes = `${JSON.stringify(tamperedReport)}\n`;
    write(root, "artifacts/release-claims-ci/result.json", tamperedReportBytes);
    evidence.reportSha256 = createHash("sha256")
      .update(tamperedReportBytes)
      .digest("hex");
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("canonical test IDs for the current tag run"),
      ),
    ).toBe(true);
    const oversizedReport = JSON.parse(ciResult);
    oversizedReport.claims[0].checks[0].observed = "x".repeat(
      MAX_RELEASE_CLAIM_OBSERVED_CODE_UNITS + 1,
    );
    const oversizedReportBytes = `${JSON.stringify(oversizedReport)}\n`;
    write(
      root,
      "artifacts/release-claims-ci/result.json",
      oversizedReportBytes,
    );
    evidence.reportSha256 = createHash("sha256")
      .update(oversizedReportBytes)
      .digest("hex");
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("canonical test IDs for the current tag run"),
      ),
    ).toBe(true);
    write(root, "artifacts/release-claims-ci/result.json", ciResult);
    evidence.reportSha256 = createHash("sha256").update(ciResult).digest("hex");
    jobHeadSha = undefined;
    expect(
      await verifyPublicationEvidence(ledger, manifest, options),
    ).toContain(
      "current workflow attempt job inventory has an invalid, wrong-run, or duplicate job identity",
    );
    jobHeadSha = commit;
    jobsTotalCount = 101;
    expect(
      await verifyPublicationEvidence(ledger, manifest, options),
    ).toContain(
      "current workflow attempt job inventory is malformed, ambiguous, or paginated",
    );
    jobsTotalCount = 2;
    expect(
      await verifyPublicationEvidence(ledger, manifest, options),
    ).toContain(
      "current workflow attempt job inventory is malformed, ambiguous, or paginated",
    );
    jobsTotalCount = 1;
    jobRunId = 1;
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("canonical readiness outcome"),
      ),
    ).toBe(true);
    jobRunId = runId;
    for (const conclusion of ["failure", "skipped"]) {
      producerStepConclusion = conclusion;
      expect(
        (await verifyPublicationEvidence(ledger, manifest, options)).some(
          (error) => error.includes("successful producer/upload steps"),
        ),
      ).toBe(true);
    }
    producerStepConclusion = "success";
    for (const count of [0, 2]) {
      producerStepCount = count;
      expect(
        (await verifyPublicationEvidence(ledger, manifest, options)).some(
          (error) => error.includes("successful producer/upload steps"),
        ),
      ).toBe(true);
    }
    producerStepCount = 1;
    uploadStepConclusion = "failure";
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("successful producer/upload steps"),
      ),
    ).toBe(true);
    uploadStepConclusion = "success";
    readinessStepConclusion = "failure";
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("canonical readiness outcome"),
      ),
    ).toBe(true);
  });

  it("shares the blocked-readiness CI job contract with the manifest generator", () => {
    const blockedJob = {
      conclusion: "failure",
      steps: [
        { name: RELEASE_SAFETY_EVIDENCE_STEP, conclusion: "success" },
        { name: RELEASE_CLAIM_CI_PRODUCER_STEP, conclusion: "success" },
        { name: RELEASE_CLAIM_CI_UPLOAD_STEP, conclusion: "success" },
        { name: RELEASE_CLAIM_CI_READINESS_STEP, conclusion: "failure" },
      ],
    };
    expect(canonicalReleaseClaimCiJobSteps(blockedJob).producerStep).toEqual(
      blockedJob.steps[1],
    );
    expect(canonicalReleaseClaimCiJobSteps(blockedJob).safetyStep).toEqual(
      blockedJob.steps[0],
    );
    const passingJob = structuredClone(blockedJob);
    passingJob.conclusion = "success";
    passingJob.steps[3].conclusion = "success";
    expect(() => canonicalReleaseClaimCiJobSteps(passingJob)).not.toThrow();

    for (const conclusion of ["failure", "skipped"]) {
      const job = structuredClone(blockedJob);
      job.steps[1].conclusion = conclusion;
      expect(() => canonicalReleaseClaimCiJobSteps(job)).toThrow(
        "Produce release claim CI result must occur exactly once and succeed",
      );
    }
    for (const conclusion of ["failure", "skipped"]) {
      const job = structuredClone(blockedJob);
      job.steps[0].conclusion = conclusion;
      expect(() => canonicalReleaseClaimCiJobSteps(job)).toThrow(
        "Produce and verify release safety evidence must occur exactly once and succeed",
      );
    }
    for (const producerCount of [0, 2]) {
      const job = structuredClone(blockedJob);
      job.steps = job.steps.filter(
        (step) => step.name !== RELEASE_CLAIM_CI_PRODUCER_STEP,
      );
      job.steps.push(
        ...Array.from({ length: producerCount }, () => ({
          name: RELEASE_CLAIM_CI_PRODUCER_STEP,
          conclusion: "success",
        })),
      );
      expect(() => canonicalReleaseClaimCiJobSteps(job)).toThrow(
        "Produce release claim CI result must occur exactly once and succeed",
      );
    }
    const wrongFailure = structuredClone(blockedJob);
    wrongFailure.steps[3].conclusion = "success";
    expect(() => canonicalReleaseClaimCiJobSteps(wrongFailure)).toThrow(
      "failure is admissible only when the canonical readiness step also failed",
    );
  });

  it("scans every required shipped/public surface class", () => {
    const root = makeRoot();
    const claimSurfaces = [...REQUIRED_SURFACE_CLASSES].map(
      (surfaceClass, index) => ({
        class: surfaceClass,
        path: `surface/${index}-${surfaceClass}.txt`,
      }),
    );
    for (const surface of claimSurfaces)
      write(root, surface.path, "Forbidden release assertion.\n");
    const errors = scanProhibitedClaims(
      {
        claimSurfaces,
        prohibitedClaims: [
          {
            id: "surface-coverage",
            pattern: "Forbidden release assertion",
            flags: "i",
            reason: "surface fixture",
          },
        ],
      },
      root,
    );
    expect(errors).toHaveLength(REQUIRED_SURFACE_CLASSES.size);
    for (const surfaceClass of REQUIRED_SURFACE_CLASSES) {
      expect(errors.some((error) => error.includes(surfaceClass))).toBe(true);
    }
  });

  it("rejects a ledger that omits a required surface class", () => {
    const root = makeRoot();
    write(root, "evidence.txt", EVIDENCE);
    const ledger = validLedger();
    ledger.claimSurfaces = ledger.claimSurfaces.filter(
      (surface) => surface.class !== "mobile-public",
    );
    expect(validateLedgerShape(ledger, root)).toContain(
      "required claim surface class is missing: mobile-public",
    );
  });

  it("blocks publication mode until the ledger is ready", () => {
    const root = makeRoot();
    writeValidFixture(root);
    expect(runChecks({ root, requireReady: true }).errors).toContain(
      "release publication requires ledger status ready; found blocked",
    );
  });

  it("separates source preflight from mandatory post-build evidence", async () => {
    const root = makeRoot();
    const ledger = validLedger();
    ledger.release.status = "ready";
    ledger.release.platforms[0].state = "supported";
    for (const condition of ledger.release.stopShipConditions)
      condition.status = "met";
    for (const claim of ledger.claims) claim.state = "proven";
    writeValidFixture(root, ledger, "0.7.0.0");
    const options = {
      root,
      tag: "v0.7.0-beta",
      commit: "0123456789abcdef0123456789abcdef01234567",
      repository: "owner/repository",
      runId: 123,
      ref: "refs/tags/v0.7.0-beta",
    };
    expect(
      runPublicationPreflight(options).errors.some((error) =>
        error.includes("must remain open until immutable resolution evidence"),
      ),
    ).toBe(true);
    expect(
      (await runPublicationChecks(options)).errors.some((error) =>
        error.includes("must remain open until immutable resolution evidence"),
      ),
    ).toBe(true);
  });
});
