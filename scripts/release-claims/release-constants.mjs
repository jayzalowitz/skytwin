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
  ["connectors.direct-provider-access", ["connectors.direct-egress-only"]],
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

export const CANONICAL_ARTIFACT_VERIFICATION_ASSETS = Object.freeze([
  ["SHA256SUMS", "checksums"],
  ["release.spdx.json", "sbom"],
  ["VERIFY.md", "verification-instructions"],
]);

export const ARTIFACT_VERIFICATION_RELEASE_PATTERN = `${ARTIFACT_VERIFICATION_DIRECTORY}/*`;

export const CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS = Object.freeze([
  "artifacts/release-claims-ci/result.json",
  ".release-evidence/reports/storage.desktop-crdb.json",
  ".release-evidence/reports/inference.on-device-availability.json",
  ".release-evidence/reports/inference.confidential-verification.json",
  ".release-evidence/reports/network.explicit-boundaries.json",
  ".release-evidence/reports/sample.packaged-account-free.macos.json",
  ".release-evidence/reports/sample.packaged-account-free.windows.json",
  ".release-evidence/reports/sample.packaged-account-free.linux.json",
  ".release-evidence/reports/models.verified-delivery.json",
  ".release-evidence/reports/release.signing.json",
  ".release-evidence/reports/release.artifact-verification.json",
]);

export const SAMPLE_EVIDENCE_PLATFORMS = new Set(["macos", "windows", "linux"]);

export const CANONICAL_MACHINE_VERIFIER_STEP = "Run canonical machine verifier";

export function machineEvidencePlatformFamily(platform) {
  return [...SAMPLE_EVIDENCE_PLATFORMS].find(
    (family) =>
      platform === family || String(platform ?? "").startsWith(`${family}-`),
  );
}

export function machineProducerJobName(claimId, platform) {
  const family = machineEvidencePlatformFamily(platform);
  return family ? `release-machine-evidence / ${claimId} / ${family}` : null;
}

export function machineVerifierPath(claimId) {
  return CANONICAL_MACHINE_EVIDENCE_CHECKS.has(claimId)
    ? `scripts/release-claims/verifiers/${claimId}.mjs`
    : null;
}

export function machineVerifierCommand(claimId, platform) {
  const path = machineVerifierPath(claimId);
  const family = machineEvidencePlatformFamily(platform);
  return path && family ? `node ${path} --platform ${family}` : null;
}

export function machineReportNamesForClaim(claimId) {
  return claimId === "sample.packaged-account-free"
    ? [...SAMPLE_EVIDENCE_PLATFORMS].map(
        (platform) => `${claimId}.${platform}.json`,
      )
    : [`${claimId}.json`];
}
