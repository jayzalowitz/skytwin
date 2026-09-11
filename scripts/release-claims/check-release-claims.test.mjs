import { createHash } from "node:crypto";
import {
  existsSync,
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
  CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  CANONICAL_MACHINE_EVIDENCE_CHECKS,
  CANONICAL_MACHINE_EVIDENCE_MATRIX,
  CANONICAL_MACHINE_VERIFIER_STEP,
  CANONICAL_RELEASE_ASSETS,
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
  isAllowlistedVerificationCommand,
  isValidSpdx23Document,
  normalizeReleaseTagToRepositoryVersion,
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
  ["connectors.direct-provider-access", "connectors"],
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
        ],
        verification: [
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
  const workflow = `env:
  ${identityLine}
permissions:
  contents: read
concurrency:
  group: build-\${{ github.ref }}
  cancel-in-progress: \${{ !startsWith(github.ref, 'refs/tags/v') }}
jobs:
  release-machine-evidence:
    name: release-machine-evidence / \${{ matrix.claimId }} / \${{ matrix.platform }}
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [desktop-mac, desktop-windows, desktop-linux]
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
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          path: artifacts
      - name: Run canonical machine verifier
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/release-claims/verifiers/\${{ matrix.claimId }}.mjs --platform \${{ matrix.platform }} --output .release-evidence/reports/\${{ matrix.reportName }}
      - name: Upload machine evidence report
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-machine-evidence-\${{ matrix.claimId }}-\${{ matrix.platform }}
          path: .release-evidence/reports/\${{ matrix.reportName }}
          if-no-files-found: error
          compression-level: 0
  aggregate-release-evidence:
    name: Aggregate release machine evidence
    if: startsWith(github.ref, 'refs/tags/v')
    needs: release-machine-evidence
    runs-on: ubuntu-24.04
    steps:
      - name: Download machine evidence reports
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          pattern: release-machine-evidence-*
          path: .release-evidence/reports
          merge-multiple: true
      - name: Upload aggregated release evidence
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release-evidence
          path: .release-evidence
          if-no-files-found: error
          compression-level: 0
  release:
    name: Create GitHub Release
    if: startsWith(github.ref, 'refs/tags/v')
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
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
        with:
          node-version: \${{ env.NODE_VERSION }}
      - name: Install release claim checker
        run: corepack pnpm@9.1.0 install --frozen-lockfile --ignore-scripts --filter skytwin
      - name: Download all artifacts
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          path: artifacts
      - name: Verify post-build release evidence
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
            ${ARTIFACT_VERIFICATION_RELEASE_PATTERN}
            .release-evidence/manifest.json
      - name: Verify exact draft assets and publish
        env:
          GITHUB_TOKEN: \${{ github.token }}
          RELEASE_ID: \${{ steps.create-release-draft.outputs.id }}
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
  });

  it("accepts a complete blocked release contract", () => {
    const root = makeRoot();
    writeValidFixture(root);
    expect(runChecks({ root }).errors).toEqual([]);
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
      "only the canonical machine producer may upload artifacts matching the release-machine-evidence prefix",
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

  it("requires the canonical tag-only release job identity", () => {
    const root = makeRoot();
    writeValidFixture(root);
    const path = join(root, ".github/workflows/build.yml");
    writeFileSync(
      path,
      replaceLast(
        readFileSync(path, "utf8"),
        "    if: startsWith(github.ref, 'refs/tags/v')\n",
        "    if: always()\n",
      ),
    );
    expect(verifyCanonicalReleasePublisher(root)).toContain(
      "canonical release job identity and dependencies must be exact",
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
        kind: "desktop-installer",
        artifactName: "SkyTwin-macOS-dmg",
        subjects: [{ path: "a.dmg", sha256: "a".repeat(64) }],
      },
      {
        kind: "desktop-archive",
        artifactName: "SkyTwin-macOS-zip",
        subjects: [{ path: "a.zip", sha256: "b".repeat(64) }],
      },
      {
        kind: "update-manifest",
        subjects: [{ path: "latest.yml", sha256: "c".repeat(64) }],
      },
    ];
    const report = {
      platform: "macos",
      coveredSubjects: [
        {
          path: "a.dmg",
          sha256: "a".repeat(64),
          platform: "macos-arm64",
          signatureResult: "pass",
          notarizationResult: "pass",
        },
      ],
    };
    expect(
      verifyMachineEvidenceApplicability("release.signing", report, assets),
    ).toHaveLength(1);
    report.coveredSubjects.push({
      path: "a.zip",
      sha256: "b".repeat(64),
      platform: "macos-arm64",
      signatureResult: "pass",
      notarizationResult: "pass",
    });
    expect(
      verifyMachineEvidenceApplicability("release.signing", report, assets),
    ).toEqual([]);
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
      modelArtifacts: [
        {
          name: "model.gguf",
          source: "https://models.example/model.gguf",
          license: "Apache-2.0",
          sha256: "d".repeat(64),
          digestVerificationResult: "pass",
          deletionResult: "pass",
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
          runnerPlatform: "darwin-x64",
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
        runnerPlatform: "darwin-x64",
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
        verifyMachineEvidenceApplicability("sample.packaged-account-free", report, []),
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
            ref: "refs/tags/v0.7.0-beta",
            evidenceArtifactId: 2,
            evidenceArtifactName: "release-evidence",
            evidenceArtifactSha256: "c".repeat(64),
            reportUri: "https://127.0.0.1/private-report.json",
            reportSha256: "b".repeat(64),
            sourceCommit: commit,
            platform: "macos",
            releaseTag: "v0.7.0-beta",
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
    const releaseAsset = releaseAssets[0];
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
      platform: "macos",
      producerJobName,
      verifierPath,
      verifierCommand,
      verifierSha256,
      releaseArtifactKind: "desktop-installer",
      releaseArtifactId: releaseAsset.artifactId,
      releaseArtifactName: releaseAsset.artifactName,
      releaseArtifactSha256: releaseAsset.artifactSha256,
      subjectName: subject.name,
      subjectPath: subject.path,
      subjectSha256: subject.sha256,
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
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [
        {
          claimId,
          kind: "machine",
          checkIds,
          repository: "owner/repository",
          runId,
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
      const id = Number(String(url).split("/").at(-1));
      let body;
      if (String(url).includes("/runs/")) {
        body = {
          id: runId,
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
          conclusion: "success",
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

  it("requires CI job/run URL and artifact proof from the current run", async () => {
    const root = makeRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const tag = "v0.7.0-beta";
    const ref = `refs/tags/${tag}`;
    const runId = 901;
    const releaseAssets = makeReleaseAssets(root);
    const ciResult = `${JSON.stringify({
      schemaVersion: 1,
      generatedBy: "release-claim-ci-harness",
      result: "pass",
      runId,
      sourceCommit: commit,
      ref,
      claims: [...CANONICAL_CI_EVIDENCE_CHECKS].map(([claimId, checkIds]) => ({
        claimId,
        checks: checkIds.map((id) => ({
          id,
          testId: id,
          result: "pass",
          observed: `fixture result for ${id}`,
        })),
      })),
    })}\n`;
    write(root, "artifacts/release-claims-ci/result.json", ciResult);
    const evidence = {
      claimId: "encryption.oauth-default",
      kind: "ci",
      checkIds: CANONICAL_CI_EVIDENCE_CHECKS.get("encryption.oauth-default"),
      repository: "owner/repository",
      runId,
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
      releaseAssets,
      verificationAssets: makeVerificationAssets(root, releaseAssets),
      evidence: [evidence],
    };
    let jobRunId = runId;
    const fetchImpl = async (url) => {
      let body;
      if (String(url).includes("/runs/")) {
        body = {
          id: runId,
          event: "push",
          head_branch: tag,
          head_sha: commit,
          path: ".github/workflows/build.yml",
          repository: { full_name: "owner/repository" },
        };
      } else if (String(url).includes("/jobs/")) {
        body = {
          id: 902,
          name: "release-claim-ci",
          conclusion: "success",
          head_sha: commit,
          run_url: `https://api.github.com/repos/owner/repository/actions/runs/${jobRunId}`,
        };
      } else if (String(url).endsWith("/903")) {
        body = {
          id: 903,
          name: "release-claims-ci",
          expired: false,
          digest: `sha256:${"a".repeat(64)}`,
          workflow_run: { id: runId, head_sha: commit },
        };
      } else {
        const id = Number(String(url).split("/").at(-1));
        body = releaseAssetApiBody(
          releaseAssets.find((asset) => asset.artifactId === id),
          runId,
          commit,
        );
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
    jobRunId = 1;
    expect(
      (await verifyPublicationEvidence(ledger, manifest, options)).some(
        (error) => error.includes("job is not a successful job"),
      ),
    ).toBe(true);
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
