export const CANONICAL_CI_EVIDENCE_CHECKS = new Map([
  ["encryption.oauth-default", ["oauth-default.at-rest-roundtrip"]],
  ["encryption.twin-state-default", ["twin-state.at-rest-roundtrip"]],
  [
    "inference.confidential-verification",
    [
      "confidential-inference.attestation-chain",
      "confidential-inference.response-signature",
    ],
  ],
  [
    "connectors.account-free-boundary",
    [
      "connectors.account-free-api-disabled",
      "connectors.account-free-worker-disabled",
      "connectors.account-free-shared-classifier",
      "connectors.account-free-router-disabled",
      "connectors.account-free-desktop-disabled",
    ],
  ],
  [
    "safety.policy-and-provenance",
    ["policy.provenance-fail-safe", "router.provenance-backstop"],
  ],
  [
    "safety.explanation-coverage",
    ["explanations.action-path", "explanations.non-action-path"],
  ],
]);

export const RELEASE_CLAIM_CI_LEDGER_PATH = "docs/beta-claim-ledger.json";
export const RELEASE_CLAIM_CI_CONSTANTS_PATH =
  "scripts/release-claims/release-constants.mjs";
export const RELEASE_CLAIM_CI_HARNESS_PATH =
  "scripts/release-claims/run-release-claim-ci.mjs";
export const RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH =
  "scripts/release-claims/capture-release-claim-ci-runtime.mjs";
export const RELEASE_CLAIM_CI_RESULT_PATH = "release-claims-ci/result.json";
export const RELEASE_CLAIM_CI_ARTIFACT_FILES = Object.freeze([
  Object.freeze({
    role: "claim-result",
    artifactPath: RELEASE_CLAIM_CI_RESULT_PATH,
    downloadedPath: "artifacts/release-claims-ci/result.json",
  }),
  Object.freeze({
    role: "adversarial-report",
    artifactPath: "release-claims-ci/adversarial-evidence.json",
    downloadedPath: "artifacts/release-claims-ci/adversarial-evidence.json",
  }),
  Object.freeze({
    role: "adversarial-checksum",
    artifactPath: "release-claims-ci/adversarial-evidence.json.sha256",
    downloadedPath:
      "artifacts/release-claims-ci/adversarial-evidence.json.sha256",
  }),
  Object.freeze({
    role: "release-safety-report",
    artifactPath: "release-claims-ci/release-safety-evidence.json",
    downloadedPath: "artifacts/release-claims-ci/release-safety-evidence.json",
  }),
]);
export const CANONICAL_RELEASE_SAFETY_ASSET_PATHS = Object.freeze(
  RELEASE_CLAIM_CI_ARTIFACT_FILES.slice(1).map(
    ({ downloadedPath }) => downloadedPath,
  ),
);
export const MAX_RELEASE_CLAIM_OBSERVED_CODE_UNITS = 4096;
export const RELEASE_CLAIM_CI_PRODUCER_STEP = "Produce release claim CI result";
export const RELEASE_CLAIM_CI_UPLOAD_STEP = "Upload release claim CI result";
export const RELEASE_CLAIM_CI_READINESS_STEP = "Enforce beta release readiness";
export const RELEASE_SAFETY_EVIDENCE_STEP =
  "Produce and verify release safety evidence";

export function canonicalReleaseClaimCiJobSteps(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const exactlyOneSuccessful = (name) => {
    const matches = steps.filter((step) => step?.name === name);
    if (matches.length !== 1 || matches[0]?.conclusion !== "success")
      throw new Error(`${name} must occur exactly once and succeed`);
    return matches[0];
  };
  const producerStep = exactlyOneSuccessful(RELEASE_CLAIM_CI_PRODUCER_STEP);
  const safetyStep = exactlyOneSuccessful(RELEASE_SAFETY_EVIDENCE_STEP);
  const uploadStep = exactlyOneSuccessful(RELEASE_CLAIM_CI_UPLOAD_STEP);
  const readinessSteps = steps.filter(
    (step) => step?.name === RELEASE_CLAIM_CI_READINESS_STEP,
  );
  if (
    readinessSteps.length !== 1 ||
    !(
      (job?.conclusion === "success" &&
        readinessSteps[0]?.conclusion === "success") ||
      (job?.conclusion === "failure" &&
        readinessSteps[0]?.conclusion === "failure")
    )
  )
    throw new Error(
      "release claim CI job failure is admissible only when the canonical readiness step also failed",
    );
  return {
    producerStep,
    safetyStep,
    uploadStep,
    readinessStep: readinessSteps[0],
  };
}
export const RELEASE_CLAIM_CI_SOURCE_PATHS = Object.freeze([
  RELEASE_CLAIM_CI_LEDGER_PATH,
  RELEASE_CLAIM_CI_CONSTANTS_PATH,
  RELEASE_CLAIM_CI_RUNTIME_CAPTURE_PATH,
  RELEASE_CLAIM_CI_HARNESS_PATH,
  "scripts/release-evidence/release-safety-entry-paths.json",
  "scripts/release-evidence/generate-release-safety-evidence.mjs",
  "scripts/release-evidence/verify-release-safety-evidence.mjs",
]);

export const CANONICAL_CI_EVIDENCE_COMMANDS = new Map(
  [
    [
      "oauth-default.at-rest-roundtrip",
      "@skytwin/connectors",
      "src/__tests__/db-token-store-vault.test.ts",
    ],
    [
      "twin-state.at-rest-roundtrip",
      "@skytwin/db",
      "src/__tests__/preferences-vault.test.ts",
    ],
    [
      "confidential-inference.attestation-chain",
      "@skytwin/llm-client",
      "src/__tests__/inference-receipt-emission.test.ts",
    ],
    [
      "confidential-inference.response-signature",
      "@skytwin/shared-types",
      "src/__tests__/inference-receipt.test.ts",
    ],
    [
      "connectors.account-free-api-disabled",
      "@skytwin/api",
      [
        "src/__tests__/oauth-google-disabled.test.ts",
        "src/__tests__/oauth-microsoft.test.ts",
        "src/__tests__/credentials-routes.test.ts",
        "src/__tests__/capabilities-routes.test.ts",
        "src/__tests__/execution-setup.test.ts",
      ],
    ],
    [
      "connectors.account-free-worker-disabled",
      "@skytwin/worker",
      [
        "src/__tests__/connector-discovery.test.ts",
        "src/__tests__/execution-account-boundary.test.ts",
        "src/__tests__/changelog-poll.test.ts",
        "src/__tests__/federation-sync.test.ts",
        "src/__tests__/briefing-generator.test.ts",
        "src/__tests__/briefing-generator-adaptive.test.ts",
        "src/__tests__/promotion-eligibility-check.test.ts",
      ],
    ],
    [
      "connectors.account-free-shared-classifier",
      "@skytwin/shared-types",
      ["src/__tests__/google-preview-boundary.test.ts"],
    ],
    [
      "connectors.account-free-router-disabled",
      "@skytwin/execution-router",
      [
        "src/__tests__/adapter-discovery.test.ts",
        "src/__tests__/execution-router.test.ts",
      ],
    ],
    [
      "connectors.account-free-desktop-disabled",
      "skytwin-desktop",
      ["src/__tests__/service-manager-env.test.ts"],
    ],
    [
      "policy.provenance-fail-safe",
      "@skytwin/policy-engine",
      "src/__tests__/injection-guard.test.ts",
    ],
    [
      "router.provenance-backstop",
      "@skytwin/execution-router",
      "src/__tests__/injection-guard-backstop.test.ts",
    ],
    [
      "explanations.action-path",
      "@skytwin/explanations",
      "src/__tests__/explanation-generator.test.ts",
    ],
    [
      "explanations.non-action-path",
      "@skytwin/explanations",
      "src/__tests__/explanation-generator.test.ts",
    ],
  ].map(([id, workspace, testPaths]) => [
    id,
    Object.freeze({
      executable: "pnpm",
      args: Object.freeze(
        testPaths
          ? [
              "--filter",
              workspace,
              "test",
              "--",
              ...(Array.isArray(testPaths) ? testPaths : [testPaths]),
            ]
          : ["--filter", workspace, "test"],
      ),
    }),
  ]),
);

export const CANONICAL_MACHINE_EVIDENCE_CHECKS = new Map([
  ["storage.desktop-crdb", ["storage.packaged-crdb-persistence"]],
  ["inference.on-device-availability", ["inference.packaged-on-device"]],
  [
    "inference.confidential-verification",
    [
      "confidential-inference.live-attestation",
      "confidential-inference.live-response-signature",
    ],
  ],
  ["network.explicit-boundaries", ["network.clean-machine-egress-capture"]],
  ["sample.packaged-account-free", ["sample.packaged-account-free-loop"]],
  [
    "models.verified-delivery",
    [
      "models.delivery-digest",
      "models.delivery-license",
      "models.delivery-delete",
    ],
  ],
  ["release.signing", ["release.platform-signature-validation"]],
  [
    "release.artifact-verification",
    [
      "release.asset-set",
      "release.checksums",
      "release.sbom",
      "release.provenance",
      "release.verification-instructions",
    ],
  ],
]);

export const CANONICAL_RELEASE_ASSETS = Object.freeze([
  ["SkyTwin-macOS-dmg", "desktop-installer"],
  ["SkyTwin-macOS-zip", "desktop-archive"],
  ["SkyTwin-macOS-update-manifest", "update-manifest"],
  ["SkyTwin-Windows-installer", "desktop-installer"],
  ["SkyTwin-Windows-update-manifest", "update-manifest"],
  ["SkyTwin-Linux-AppImage", "desktop-installer"],
  ["SkyTwin-Linux-deb", "desktop-installer"],
  ["SkyTwin-Linux-rpm", "desktop-installer"],
  ["SkyTwin-Linux-update-manifest", "update-manifest"],
]);

export const ARTIFACT_VERIFICATION_DIRECTORY =
  ".release-evidence/artifact-verification";

export const RELEASE_ARTIFACT_MATERIALS_JOB = "release-artifact-materials";
export const RELEASE_ARTIFACT_MATERIALS_ARTIFACT = "release-artifact-materials";
export const RELEASE_ARTIFACT_STAGING_DIRECTORY = ".release-artifacts";
export const RELEASE_ARTIFACT_MATERIALS_DIRECTORY = `${RELEASE_ARTIFACT_STAGING_DIRECTORY}/artifact-verification`;
export const RELEASE_ARTIFACT_MANIFEST_PATH = `${RELEASE_ARTIFACT_STAGING_DIRECTORY}/release-artifact-manifest.json`;
export const RELEASE_ARTIFACT_GENERATOR_PATH =
  "scripts/release-artifacts/generate-release-manifest.mjs";
export const RELEASE_ARTIFACT_VALIDATOR_PATH =
  "scripts/release-artifacts/verify-release-manifest.mjs";
export const RELEASE_ATTESTATION_MATERIALIZER_PATH =
  "scripts/release-artifacts/materialize-attestation-bundles.mjs";

export const PINNED_RELEASE_WORKFLOW_ACTIONS = Object.freeze({
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  downloadArtifact:
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  attest: "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  uploadArtifact:
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
});

export const CANONICAL_ARTIFACT_VERIFICATION_ASSETS = Object.freeze([
  ["SHA256SUMS", "checksums"],
  ["release.spdx.json", "sbom"],
  ["VERIFY.md", "verification-instructions"],
]);

export const ARTIFACT_VERIFICATION_RELEASE_PATTERN = `${ARTIFACT_VERIFICATION_DIRECTORY}/*`;

export const SAMPLE_EVIDENCE_PLATFORMS = new Set(["macos", "windows", "linux"]);

export const CANONICAL_MACHINE_EVIDENCE_MATRIX = Object.freeze(
  [
    ["storage.desktop-crdb", "macos", "macos-15"],
    ["inference.on-device-availability", "macos", "macos-15"],
    ["inference.confidential-verification", "linux", "ubuntu-24.04"],
    ["network.explicit-boundaries", "macos", "macos-15"],
    ["sample.packaged-account-free", "macos", "macos-15"],
    ["sample.packaged-account-free", "windows", "windows-2025"],
    ["sample.packaged-account-free", "linux", "ubuntu-24.04"],
    ["models.verified-delivery", "linux", "ubuntu-24.04"],
    ["release.signing", "macos", "macos-15"],
    ["release.signing", "windows", "windows-2025"],
    ["release.signing", "linux", "ubuntu-24.04"],
    ["release.artifact-verification", "linux", "ubuntu-24.04"],
  ].map(([claimId, platform, runner]) =>
    Object.freeze({
      claimId,
      platform,
      runner,
      reportName: ["sample.packaged-account-free", "release.signing"].includes(
        claimId,
      )
        ? `${claimId}.${platform}.json`
        : `${claimId}.json`,
    }),
  ),
);

export const CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS = Object.freeze([
  "artifacts/release-claims-ci/result.json",
  ...CANONICAL_MACHINE_EVIDENCE_MATRIX.map(
    ({ reportName }) => `.release-evidence/reports/${reportName}`,
  ),
]);

export const CANONICAL_MACHINE_VERIFIER_STEP = "Run canonical machine verifier";

export const CANONICAL_DESKTOP_PRODUCER_JOBS = new Map([
  ["macos", "Desktop — macOS (DMG + ZIP)"],
  ["windows", "Desktop — Windows (NSIS installer)"],
  ["linux", "Desktop — Linux (AppImage + deb + rpm)"],
]);

export const CANONICAL_DESKTOP_ARTIFACT_UPLOAD_STEPS = new Map([
  ["SkyTwin-macOS-dmg", "Upload macOS DMG"],
  ["SkyTwin-macOS-zip", "Upload macOS ZIP"],
  ["SkyTwin-Windows-installer", "Upload Windows installer"],
  ["SkyTwin-Linux-AppImage", "Upload Linux AppImage"],
  ["SkyTwin-Linux-deb", "Upload Linux deb"],
  ["SkyTwin-Linux-rpm", "Upload Linux rpm"],
]);

export function desktopProducerJobName(platform) {
  return CANONICAL_DESKTOP_PRODUCER_JOBS.get(
    machineEvidencePlatformFamily(platform),
  );
}

export function desktopArtifactUploadStepName(artifactName) {
  return CANONICAL_DESKTOP_ARTIFACT_UPLOAD_STEPS.get(artifactName);
}

export function machineEvidencePlatformFamily(platform) {
  return [...SAMPLE_EVIDENCE_PLATFORMS].find(
    (family) =>
      platform === family || String(platform ?? "").startsWith(`${family}-`),
  );
}

export function machineProducerJobName(claimId, platform) {
  const family = machineEvidencePlatformFamily(platform);
  return CANONICAL_MACHINE_EVIDENCE_MATRIX.some(
    (entry) => entry.claimId === claimId && entry.platform === family,
  )
    ? `release-machine-evidence / ${claimId} / ${family}`
    : null;
}

export function machineVerifierPath(claimId) {
  return CANONICAL_MACHINE_EVIDENCE_CHECKS.has(claimId)
    ? `scripts/release-claims/verifiers/${claimId}.mjs`
    : null;
}

export function machineVerifierCommand(claimId, platform) {
  const path = machineVerifierPath(claimId);
  const family = machineEvidencePlatformFamily(platform);
  const reportName = CANONICAL_MACHINE_EVIDENCE_MATRIX.find(
    (entry) => entry.claimId === claimId && entry.platform === family,
  )?.reportName;
  if (!path || !family || !reportName) return null;
  if (claimId === "sample.packaged-account-free") {
    return `node ${path} --verify --platform ${family} --descriptor .release-evidence/provenance/${reportName} --output .release-evidence/reports/${reportName}`;
  }
  return `node ${path} --platform ${family} --output .release-evidence/reports/${reportName}`;
}

export function machineReportNamesForClaim(claimId) {
  return CANONICAL_MACHINE_EVIDENCE_MATRIX.filter(
    (entry) => entry.claimId === claimId,
  ).map((entry) => entry.reportName);
}
