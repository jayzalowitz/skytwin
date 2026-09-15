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
  ["connectors.account-free-boundary", ["connectors.account-free-disabled"]],
  [
    "safety.policy-and-provenance",
    ["policy.provenance-fail-safe", "router.provenance-backstop"],
  ],
  [
    "safety.explanation-coverage",
    ["explanations.action-path", "explanations.non-action-path"],
  ],
]);

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
