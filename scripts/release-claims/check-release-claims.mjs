#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
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
  PINNED_RELEASE_WORKFLOW_ACTIONS,
  RELEASE_ARTIFACT_GENERATOR_PATH,
  RELEASE_ARTIFACT_MANIFEST_PATH,
  RELEASE_ARTIFACT_MATERIALS_ARTIFACT,
  RELEASE_ARTIFACT_MATERIALS_DIRECTORY,
  RELEASE_ARTIFACT_MATERIALS_JOB,
  RELEASE_ARTIFACT_STAGING_DIRECTORY,
  RELEASE_ARTIFACT_VALIDATOR_PATH,
  RELEASE_ATTESTATION_MATERIALIZER_PATH,
  SAMPLE_EVIDENCE_PLATFORMS,
  desktopArtifactUploadStepName,
  desktopProducerJobName,
  machineEvidencePlatformFamily,
  machineProducerJobName,
  machineReportNamesForClaim,
  machineVerifierCommand,
  machineVerifierPath,
} from "./release-constants.mjs";

export {
  ARTIFACT_VERIFICATION_DIRECTORY,
  ARTIFACT_VERIFICATION_RELEASE_PATTERN,
  CANONICAL_ARTIFACT_VERIFICATION_ASSETS,
  CANONICAL_CI_EVIDENCE_CHECKS,
  CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  CANONICAL_MACHINE_EVIDENCE_CHECKS,
  CANONICAL_MACHINE_EVIDENCE_MATRIX,
  CANONICAL_MACHINE_VERIFIER_STEP,
  CANONICAL_RELEASE_ASSETS,
  PINNED_RELEASE_WORKFLOW_ACTIONS,
  RELEASE_ARTIFACT_GENERATOR_PATH,
  RELEASE_ARTIFACT_MANIFEST_PATH,
  RELEASE_ARTIFACT_MATERIALS_ARTIFACT,
  RELEASE_ARTIFACT_MATERIALS_DIRECTORY,
  RELEASE_ARTIFACT_MATERIALS_JOB,
  RELEASE_ARTIFACT_STAGING_DIRECTORY,
  RELEASE_ARTIFACT_VALIDATOR_PATH,
  RELEASE_ATTESTATION_MATERIALIZER_PATH,
  machineEvidencePlatformFamily,
  machineProducerJobName,
  machineReportNamesForClaim,
  machineVerifierCommand,
  machineVerifierPath,
} from "./release-constants.mjs";

export const CLAIM_STATES = new Set([
  "proven",
  "limited",
  "deferred",
  "prohibited",
]);

export const REQUIRED_CATEGORIES = new Set([
  "open-source",
  "local-storage",
  "encryption",
  "inference",
  "network-use",
  "sample-mode",
  "connectors",
  "signing",
  "model-delivery",
  "action-safety",
  "artifact-verification",
]);

export const DEFAULT_LEDGER_PATH = "docs/beta-claim-ledger.json";

export const REQUIRED_SURFACE_CLASSES = new Set([
  "root-public",
  "docs-public",
  "web-public",
  "desktop-public",
  "mobile-public",
  "release-metadata",
  "release-templates",
]);

export const REQUIRED_READINESS_CLAIM_IDS = new Set([
  "storage.desktop-crdb",
  "encryption.oauth-default",
  "encryption.twin-state-default",
  "inference.on-device-availability",
  "inference.confidential-verification",
  "network.explicit-boundaries",
  "sample.packaged-account-free",
  "connectors.account-free-boundary",
  "models.verified-delivery",
  "safety.policy-and-provenance",
  "safety.explanation-coverage",
  "release.signing",
  "release.artifact-verification",
]);

export const CANONICAL_CLAIM_CATEGORIES = new Map([
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

const CANONICAL_MODEL_DELIVERY_ARTIFACT = Object.freeze({
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
  metadataLicenseSiblingBlobId: "6634c8cc3133b3848ec74b9f275acaaa1ea618ab",
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
  sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
  digestVerificationResult: "pass",
  stableFileIdentityResult: "pass",
  deletionResult: "pass",
});
const CANONICAL_MODEL_DELIVERY_CHECKS = Object.freeze([
  Object.freeze({
    id: "models.delivery-digest",
    testId: "models.delivery-digest",
    result: "pass",
    observed: Object.freeze({
      assertion:
        "The delivered model bytes match the reviewed immutable source pin",
      measurement:
        "qwen2.5-1.5b-instruct-q4_k_m.gguf 1117320736 bytes sha256:6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
      exitCode: 0,
    }),
  }),
  Object.freeze({
    id: "models.delivery-license",
    testId: "models.delivery-license",
    result: "pass",
    observed: Object.freeze({
      assertion:
        "The model metadata and license bytes are observed at the same immutable source revision",
      measurement:
        "Qwen/Qwen2.5-1.5B-Instruct-GGUF@91cad51170dc346986eccefdc2dd33a9da36ead9 card=apache-2.0; LICENSE 11343 bytes sha256:832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e",
      exitCode: 0,
    }),
  }),
  Object.freeze({
    id: "models.delivery-delete",
    testId: "models.delivery-delete",
    result: "pass",
    observed: Object.freeze({
      assertion:
        "The verified candidate was removed from the isolated verifier workspace",
      measurement: "stable inode quarantined and deleted after verification",
      exitCode: 0,
    }),
  }),
]);
const MODEL_DELIVERY_REPORT_FIELDS = Object.freeze([
  "releaseTag",
  "runId",
  "runAttempt",
  "repository",
  "ref",
  "releaseArtifactKind",
  "releaseArtifactId",
  "releaseArtifactName",
  "releaseArtifactSha256",
  "releaseArtifactCreatedAt",
  "releaseArtifactAttemptBindingResult",
  "subjectName",
  "subjectPath",
  "subjectSha256",
  "producerJobName",
  "desktopProducerJobId",
  "desktopProducerJobName",
  "desktopProducerJobRunAttempt",
  "desktopProducerJobConclusion",
  "desktopUploadStartedAt",
  "desktopUploadCompletedAt",
  "verifierJobId",
  "verifierJobName",
  "verifierJobRunAttempt",
  "verifierJobStatus",
  "verifierPath",
  "verifierCommand",
  "verifierSha256",
  "schemaVersion",
  "generatedBy",
  "claimId",
  "result",
  "sourceCommit",
  "platform",
  "runnerPlatform",
  "modelArtifacts",
  "checks",
]);

const CANONICAL_READINESS_CLAIM_DIGESTS = new Map([
  [
    "storage.desktop-crdb",
    "60cd42fdd7dc7a28889c76ef605c007e2f0cd917b5308110aa261246e0a09311",
  ],
  [
    "encryption.oauth-default",
    "6680cc06febcf4edd2df1886ed206e7d462098f71be0e07769610578450384b2",
  ],
  [
    "encryption.twin-state-default",
    "b9cef65321bd6695d4f97a2dd47e726a4d243378c2eb7d812a5056c44a59ebca",
  ],
  [
    "inference.on-device-availability",
    "aa50cfc127466c896417a4d1e47e1807a78e236d93ff52016e4324dbb6e2e3c5",
  ],
  [
    "inference.confidential-verification",
    "3747194142a1e6870b9dc244bb42171aaf9dddd3f51e46cb850f1cfbacc784c9",
  ],
  [
    "network.explicit-boundaries",
    "df3e5bc679f498545535f43a6956c1c94a047de346bf2dd1a5e581916fcae55d",
  ],
  [
    "sample.packaged-account-free",
    "594ea72f3bb8815d3dff2adb69da57cd53be3be76164858b0d475c90df03d560",
  ],
  [
    "connectors.account-free-boundary",
    "e3f0588457c718052eafe53d42aa3f094412b1d6a1325bf90625a9870ec3835b",
  ],
  [
    "models.verified-delivery",
    "933c06e9d7e0d33db05e1ab474f74d4ed3d62bc8eaf0f6dd0ccf374542b8cd3a",
  ],
  [
    "safety.policy-and-provenance",
    "b475c6e3b8d92be5da61743f2eeb11ced1239ca881d4b63a249d465194685267",
  ],
  [
    "safety.explanation-coverage",
    "4e5edb062f9344a1735df7483c207082dd699ab6a8b06721189fc63632dd0325",
  ],
  [
    "release.signing",
    "1adf5347b841b1ddb4711c5098c7e3dbfbcd38327301b75806130f4dc02e72c3",
  ],
  [
    "release.artifact-verification",
    "f6afd120ba5f210d46f0799036a4a3f4f1b5782a8e349ca6fd7c9d868b2b6b2c",
  ],
]);

export const CANONICAL_READINESS_EVIDENCE_KINDS = new Map([
  ["storage.desktop-crdb", ["source", "machine"]],
  ["encryption.oauth-default", ["source", "ci"]],
  ["encryption.twin-state-default", ["source", "ci"]],
  ["inference.on-device-availability", ["source", "machine"]],
  ["inference.confidential-verification", ["source", "ci", "machine"]],
  ["network.explicit-boundaries", ["source", "machine"]],
  ["sample.packaged-account-free", ["source", "machine"]],
  ["connectors.account-free-boundary", ["source", "ci"]],
  ["models.verified-delivery", ["source", "machine"]],
  ["safety.policy-and-provenance", ["source", "ci"]],
  ["safety.explanation-coverage", ["source", "ci"]],
  ["release.signing", ["source", "machine"]],
  ["release.artifact-verification", ["source", "machine"]],
]);

export const REQUIRED_STOP_SHIP_IDS = new Set([
  "claims-ci",
  "minimum-hardware",
  "packaged-sample",
  "production-key-management",
  "verified-model-delivery",
  "reasoning-mode-proof",
  "signed-artifacts",
  "artifact-evidence",
  "release-artifact-scope",
  "release-evals",
  "beta-bake",
]);

const CANONICAL_STOP_SHIP_CONDITIONS = new Map([
  [
    "claims-ci",
    {
      owner: "release-engineering",
      condition:
        "The claim ledger and deterministic stale/prohibited-claim check pass on the release commit in CI with an immutable run identifier",
    },
  ],
  [
    "minimum-hardware",
    {
      owner: "desktop-inference",
      condition:
        "Minimum supported OS, RAM, free-disk, architecture, and sample-loop latency are proven on the final artifact",
    },
  ],
  [
    "packaged-sample",
    {
      owner: "desktop-product",
      condition:
        "A production build initializes an isolated account-free sample and completes the documented loop without the development auth bypass",
    },
  ],
  [
    "production-key-management",
    {
      owner: "security",
      condition:
        "The agreed encryption boundary and production key lifecycle are implemented, migrated, tested, and disclosed",
    },
  ],
  [
    "verified-model-delivery",
    {
      owner: "desktop-inference",
      condition:
        "The recommended model has a real digest, source, license, size, compatibility metadata, resilient download, and deletion controls",
    },
  ],
  [
    "reasoning-mode-proof",
    {
      owner: "inference-security",
      condition:
        "On-device, verified-private, and conventional provider modes are explicit; verified-private admission remains unavailable until a production attestation-backed provider and verifier persist independently verifiable receipts",
    },
  ],
  [
    "signed-artifacts",
    {
      owner: "release-engineering",
      condition:
        "Every supported platform artifact satisfies its signing and notarization requirements on a clean machine",
    },
  ],
  [
    "artifact-evidence",
    {
      owner: "release-engineering",
      condition:
        "Every distributed artifact has SHA-256 checksums, an SBOM, build provenance/attestation, and independent verification instructions",
    },
  ],
  [
    "release-artifact-scope",
    {
      owner: "release-engineering",
      condition:
        "The v-tag release job distributes only platforms included in the supported beta matrix; Android and iOS simulator outputs remain excluded or separately gated",
    },
  ],
  [
    "release-evals",
    {
      owner: "safety-evals",
      condition:
        "A release-SHA-bound adversarial evaluation pack proves the public safety thresholds and discloses denominators, failures, and limitations",
    },
  ],
  [
    "beta-bake",
    {
      owner: "release-owner",
      condition:
        "The release candidate completes the invited-tester bake and all release-blocking defects are closed or explicitly mitigated",
    },
  ],
]);

export const RELEASE_PUBLISHER_ACTION =
  "softprops/action-gh-release@efb35369e0ad2afab669f228072c1b0d510eae64";

const CANONICAL_RELEASE_JOB_ACTIONS = new Set([
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  RELEASE_PUBLISHER_ACTION,
]);

const AUDITED_NON_RELEASE_SECRET_NAMES = new Set();

export const CANONICAL_UPDATE_FEED_RUN = `curl -fsSL --max-time 10 --retry 3 --retry-delay 2 \\
  "https://github.com/\${{ github.repository }}/releases/latest" \\
  -o /dev/null`;

export const CANONICAL_RELEASE_EVIDENCE_RUN = `cp -R artifacts/release-evidence .release-evidence
node scripts/release-claims/generate-evidence-manifest.mjs \\
  docs/beta-claim-ledger.json \\
  .release-evidence/reports \\
  .release-evidence/manifest.json
node scripts/release-claims/check-release-claims.mjs \\
  --require-ready \\
  --tag "\${GITHUB_REF_NAME}" \\
  --commit "\${GITHUB_SHA}" \\
  --repository "\${GITHUB_REPOSITORY}" \\
  --run-id "\${GITHUB_RUN_ID}" \\
  --ref "\${GITHUB_REF}" \\
  --evidence-manifest .release-evidence/manifest.json`;

const CANONICAL_RELEASE_FILE_PATTERNS = new Set([
  ...CANONICAL_RELEASE_ASSETS.map(([name]) => `artifacts/${name}/*`),
  ...CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  ARTIFACT_VERIFICATION_RELEASE_PATTERN,
  ".release-evidence/manifest.json",
]);

const READY_ACCEPTED_STATES = new Set(["proven", "limited"]);
const SOURCE_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SPDX_ELEMENT_ID = /^SPDXRef-[A-Za-z0-9.-]+$/;
const SPDX_UTC_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SPDX_23_CHECKSUM_ALGORITHMS = new Set([
  "ADLER32",
  "BLAKE2b-256",
  "BLAKE2b-384",
  "BLAKE2b-512",
  "BLAKE3",
  "MD2",
  "MD4",
  "MD5",
  "MD6",
  "SHA1",
  "SHA224",
  "SHA256",
  "SHA3-256",
  "SHA3-384",
  "SHA3-512",
  "SHA384",
  "SHA512",
]);
const SPDX_23_RELATIONSHIP_TYPES = new Set([
  "AMENDS",
  "ANCESTOR_OF",
  "BUILD_DEPENDENCY_OF",
  "BUILD_TOOL_OF",
  "CONTAINED_BY",
  "CONTAINS",
  "COPY_OF",
  "DATA_FILE_OF",
  "DEPENDENCY_MANIFEST_OF",
  "DEPENDENCY_OF",
  "DEPENDS_ON",
  "DESCENDANT_OF",
  "DESCRIBED_BY",
  "DESCRIBES",
  "DEV_DEPENDENCY_OF",
  "DEV_TOOL_OF",
  "DISTRIBUTION_ARTIFACT",
  "DOCUMENTATION_OF",
  "DYNAMIC_LINK",
  "EXAMPLE_OF",
  "EXPANDED_FROM_ARCHIVE",
  "FILE_ADDED",
  "FILE_DELETED",
  "FILE_MODIFIED",
  "GENERATED_FROM",
  "GENERATES",
  "HAS_PREREQUISITE",
  "METAFILE_OF",
  "OPTIONAL_COMPONENT_OF",
  "OPTIONAL_DEPENDENCY_OF",
  "OTHER",
  "PACKAGE_OF",
  "PATCH_APPLIED",
  "PATCH_FOR",
  "PREREQUISITE_FOR",
  "PROVIDED_DEPENDENCY_OF",
  "REQUIREMENT_DESCRIPTION_FOR",
  "RUNTIME_DEPENDENCY_OF",
  "SPECIFICATION_FOR",
  "STATIC_LINK",
  "TEST_CASE_OF",
  "TEST_DEPENDENCY_OF",
  "TEST_OF",
  "TEST_TOOL_OF",
  "VARIANT_OF",
]);
const RELEASE_EVIDENCE_WORKFLOW_PATH = ".github/workflows/build.yml";
const CI_EVIDENCE_JOB_NAME = "release-claim-ci";
const CI_EVIDENCE_ARTIFACT_NAME = "release-claims-ci";
const MACHINE_EVIDENCE_ARTIFACT_NAME = "release-evidence";
const CANONICAL_AUDIT_BASELINE = Object.freeze({
  ref: "origin/main",
  commit: "563c60f43e461910a16f30423cbab4ce8092fb61",
  auditedOn: "2026-09-14",
});
const PUBLIC_DOCUMENT_EXTENSIONS = Object.freeze([
  ".adoc",
  ".css",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".plist",
  ".rst",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml",
]);
const HISTORICAL_CHANGELOG_EXCEPTIONS = Object.freeze([
  {
    ruleId: "stale-launch-ready",
    exact: "launch-ready on the engineering side",
  },
  {
    ruleId: "stale-all-code-shipped",
    exact: "every code-writable launch criterion has shipped",
  },
  {
    ruleId: "unverified-private-model-availability",
    exact: "your AI runs privately on this computer",
  },
]);
const HISTORICAL_STALE_ASSET_EXCEPTIONS = Object.freeze([
  {
    assetId: "briefing-pre-claim-audit",
    exact: "briefing.png",
  },
]);
const PUBLIC_BINARY_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const PUBLIC_BINARY_ROOTS = [
  "docs",
  "apps/web/public",
  "apps/desktop/assets",
  "apps/mobile/assets",
];

const CANONICAL_STALE_ASSETS = new Map([
  ["approvals-pre-claim-audit", "docs/screenshots/approvals.png"],
  ["briefing-pre-claim-audit", "docs/screenshots/briefing.png"],
  ["dashboard-pre-claim-audit", "docs/screenshots/dashboard.png"],
  ["decisions-pre-claim-audit", "docs/screenshots/decisions.png"],
  ["onboarding-pre-claim-audit", "docs/screenshots/onboarding.png"],
  ["settings-pre-claim-audit", "docs/screenshots/settings.png"],
  ["setup-pre-claim-audit", "docs/screenshots/setup.png"],
  ["twin-pre-claim-audit", "docs/screenshots/twin.png"],
]);

const CANONICAL_PUBLIC_BINARY_ASSETS = new Map([
  ["apps/desktop/assets/icon.icns", "reviewed-no-text"],
  ["apps/desktop/assets/icon.ico", "reviewed-no-text"],
  ["apps/desktop/assets/icons/256x256.png", "reviewed-no-text"],
  ["apps/desktop/assets/icons/512x512.png", "reviewed-no-text"],
  ["apps/mobile/assets/adaptive-icon.png", "reviewed-no-text"],
  ["apps/mobile/assets/icon.png", "reviewed-no-text"],
  ["apps/mobile/assets/notification-icon.png", "reviewed-no-text"],
  ["apps/mobile/assets/splash.png", "reviewed-no-text"],
  ["docs/screenshots/approvals.png", "prohibited-stale"],
  ["docs/screenshots/briefing.png", "prohibited-stale"],
  ["docs/screenshots/dashboard.png", "prohibited-stale"],
  ["docs/screenshots/decisions.png", "prohibited-stale"],
  ["docs/screenshots/onboarding.png", "prohibited-stale"],
  ["docs/screenshots/settings.png", "prohibited-stale"],
  ["docs/screenshots/setup.png", "prohibited-stale"],
  ["docs/screenshots/twin.png", "prohibited-stale"],
]);
const CANONICAL_PUBLIC_BINARY_DIGESTS = new Map([
  [
    "apps/desktop/assets/icon.icns",
    "d3717bc93cd429ed28562365b214157673a55f83f755b444b6e1e3dd47e83982",
  ],
  [
    "apps/desktop/assets/icon.ico",
    "55874d598e2ea907ac644a450a9f1a1083806857fc1b8cbca5a3cf00a5a35790",
  ],
  [
    "apps/desktop/assets/icons/256x256.png",
    "10b6dcc147d91f72bd6cfae0026f7c8c710b2a7a746e3be23e982eb52a561480",
  ],
  [
    "apps/desktop/assets/icons/512x512.png",
    "0f16c2f036885e9b38a68cc8fbb9b3918af1133ceffb572b260ad89fcdb48e65",
  ],
  [
    "apps/mobile/assets/adaptive-icon.png",
    "a4d4d3fe96557ad8dc6208e0cef6d6369aa3337f82c62186d7cdf6419218418b",
  ],
  [
    "apps/mobile/assets/icon.png",
    "a4d4d3fe96557ad8dc6208e0cef6d6369aa3337f82c62186d7cdf6419218418b",
  ],
  [
    "apps/mobile/assets/notification-icon.png",
    "a4d4d3fe96557ad8dc6208e0cef6d6369aa3337f82c62186d7cdf6419218418b",
  ],
  [
    "apps/mobile/assets/splash.png",
    "5588814424f5655372944a711bb59e5a58e18ef8adef5571372ee407115e3c5a",
  ],
  [
    "docs/screenshots/approvals.png",
    "39d97b021f527b1b8aed3e444c1c43b134369db021d3bc1acfcb19ee7c0260a1",
  ],
  [
    "docs/screenshots/briefing.png",
    "591f9145a8be3f5c3fab27386ad70e0da6c75019f6458e8377bf70c32a9f6931",
  ],
  [
    "docs/screenshots/dashboard.png",
    "ac3c68686e4d223eed38c31a5b99c158e88bdcbd7e19f77878de83fc2a8d254b",
  ],
  [
    "docs/screenshots/decisions.png",
    "67a0d595da153bd7f1effe86c5147a2af7fd9a61f0378f6adad30a7e285c378e",
  ],
  [
    "docs/screenshots/onboarding.png",
    "25081687e85f30dc71e14a8ad530e8e819ba072698ab304503125a3fad5b713b",
  ],
  [
    "docs/screenshots/settings.png",
    "93e2d66e98c268f81865abff379531dcc484dd4f6a80ea3c8c51f438ca58b212",
  ],
  [
    "docs/screenshots/setup.png",
    "51216f50224c7f01d6acd8d6cdfc9203e5a39fccba5855a6c901c9a840a1cc4d",
  ],
  [
    "docs/screenshots/twin.png",
    "e53fd86bf5d74c397866dfd8ba70c0a085294402ce186477cacdc260539d9dfb",
  ],
]);

const CANONICAL_PROHIBITED_RULE_DIGESTS = new Map([
  [
    "absolute-local-product",
    "a96c20071c9a19b28ee05b03c2806a7cf7c35d4915adc7a6a1abc833df1fa06e",
  ],
  [
    "absolute-no-operated-service",
    "eeee704f35b03432116fadeccc2a4803235cb6a54ea12a7eea017981a622d424",
  ],
  [
    "absolute-server-transfer",
    "70804030d2208b9f006bede6c3a7cafba7e81b9fe1b20797cd3979b01234cd6a",
  ],
  [
    "nothing-to-install",
    "a58a57dec0dd300ff01aa9b98933492781fd325a81f26487091a760cd3ef9249",
  ],
  [
    "absolute-device-egress",
    "e7c715e76ed86d6dab93fe739ec6ee6a6075d5ab8812565a234f1251b96b8d0c",
  ],
  [
    "absolute-user-data-egress",
    "8e8be895f666dd9b2b0bcd3d006fc555739a068fc7400df4691eff8ce30ae8fe",
  ],
  [
    "absolute-percent-local",
    "680631b3e0c2a5a697f863f0a7523b0455d32c3c18dc359f254b98d2294e3a74",
  ],
  [
    "oauth-encryption-present-tense",
    "a593ce039ec470a982e17a5d0eb98a72fe0c30dbd75ac80265b49ffd32b49961",
  ],
  [
    "credential-save-encrypted",
    "13c2d0fa82ebce33e93f6171b1442aca1e7b70cb9757be24e99e6e8b4c3718ea",
  ],
  [
    "bundled-default-model",
    "23b727d4be5a65df002cf3d4e8cc9df0607b4c00074f8df027dfc24c9e5b451b",
  ],
  [
    "stale-launch-ready",
    "72033cf451a0ea0eee88b0ac8bd73a8459c929ff3b554b7167af2ed8997f2ec4",
  ],
  [
    "stale-all-code-shipped",
    "e523d88f9f2f7befdf46975d405352a6fef21d638376c02fd742bd3ed050c25e",
  ],
  [
    "absolute-no-server-path",
    "ca7a565f487cceefc83e56bfd48770fb03ecc5aa21ea29c521360902bcf8829a",
  ],
  [
    "packaged-sample-shipped",
    "71fd7ff7daa64343ec23a8ce04931db465e174998f52f6d132869f9031238334",
  ],
  [
    "supported-installer-available",
    "838c5a3dc924f0fe31e07c241c3e4bc1cf9c41f438963588b35be06245e3ae10",
  ],
  [
    "desktop-beta-download",
    "2d61bf4fa0c182f6653c6628930b4ec48f09890fae594afd8bfbded197be534e",
  ],
  [
    "packaged-sample-account-free",
    "73baba64f6b23f47ec869c2dfb3c4f2673ec3811fdeacaea54a3d92653623995",
  ],
  [
    "unverified-self-update",
    "b41359ba45ac24d6a6f836564cabde452ef96c2ac99bd366dee5cc1a0eafc02a",
  ],
  [
    "local-mode-availability",
    "b9b65abc7e2c53a04e1e396d922655924137924bb9af9b9fa6be1bf38fd6b0bf",
  ],
  [
    "offline-mode-availability",
    "a2a2e1c39cc49516fbf96a4a733464ae8507590456022ee76033e4b3117488fb",
  ],
  [
    "implicit-local-model",
    "2b1de0f1649875f6f6ae9f660bf80a4ad1907c6d116c7d57828177ec04e7c870",
  ],
  [
    "unverified-private-model-availability",
    "690c3a5e51ee02be353d633c3a039f8d354fd720984d5bb6851a202128d01f4e",
  ],
  [
    "idle-miner-zero-egress",
    "a1fb3d2afccec489b35586d6e203188940aba4ee5a1c1aa20d3d0baf2e4a1be9",
  ],
  [
    "unproven-confidential-mode",
    "1f3b71b3f78deb753d5e4a61fc1dfaa56c503751154821b251a3fb9075a65a47",
  ],
  [
    "unproven-universal-explanations",
    "eb50709b3b331295993f4f22905ca5276f2a1bf5ee2aefb910ac9f75ac2a6490",
  ],
]);

const CANONICAL_APPROVED_STATEMENT_DIGESTS = new Map([
  [
    "readme-release-status",
    "34d49f5e5686768c9e35366fd49fbac6cac670940e2e03a9cf6bc2c14ffd6c89",
  ],
  [
    "privacy-storage-boundary",
    "c349858ccc9402b7a191137eb30db256fc3b7125dfe18cc67a0d530580bc2693",
  ],
  [
    "privacy-encryption-boundary",
    "52282febb8d701d818daa292292e76b1ae01fc1966d38e9da80466e47504da35",
  ],
  [
    "onboarding-reasoning-boundary",
    "0eeb5555602b98190fce76ced7cd246b582659b1e798f6299f669c9af9c8a11a",
  ],
  [
    "onboarding-idle-miner-boundary",
    "1644541ffcb82216a4ce7e459c4837fcbc4d8638792700ed0497c56ec426d768",
  ],
  [
    "settings-memory-boundary",
    "574b7592a0b266785dbe2c2598565041158581cbbc56f41c98ee697a3b03ed6c",
  ],
  [
    "settings-model-availability-boundary",
    "14abf7c5c200cf7196f2d5efa68107eef4e6dcb95cbc083304e4a519e80d567e",
  ],
  [
    "gmail-credential-boundary",
    "d3701a980c4a12a22762c7e3ece971e79e4d19a1da045490ba9e98b0a83ea6c9",
  ],
  [
    "dashboard-reasoning-boundary",
    "6df0e2b2c052caab3eb1b665896e26bc51e01f29be6e8c3ae22f3e4b565c8602",
  ],
  [
    "landing-artifact-boundary",
    "102d952a9aaf31af869e40cfe4eca127b7ac47c224ec8f50f8ded9c525762afb",
  ],
  [
    "landing-sample-boundary",
    "031b068eb9ec1158fe3ee885888a44e957ddfffcdcdf5503d1a2571d4c8f3708",
  ],
  [
    "landing-update-boundary",
    "597c96c9099a28ddcf56b35ae73c37417d2941e7e8c81d496ea2ee1bf54020e2",
  ],
  [
    "artifact-signing-boundary",
    "9f6c521c26306a7e51ba56770be9f3a56bfdaa04bf0c45cd69be4565aa2c25cf",
  ],
  [
    "all-release-tags-gated",
    "ed0749e46e8d899689df10019ccb2b0e4b513d68c9ec667acb35de6ce9e60038",
  ],
  [
    "all-release-tag-condition",
    "76bf2712ba8db560a444e3888c6b16074129e03c6181c3ed57d0ecaae784d9ca",
  ],
  [
    "post-build-release-evidence-gate",
    "bfa9e0dc764d49ba87129c9fce599c4d6d97164956357db979ce55d008f48b52",
  ],
  [
    "external-release-evidence-manifest",
    "3a3b21a49764c0fd54800d32dcfe33ed4eb5eb07ea3fa15af35ca05275c22561",
  ],
]);
const VERIFICATION_PACKAGE_FILTERS = new Set([
  "skytwin-desktop",
  "@skytwin/api",
  "@skytwin/connectors",
  "@skytwin/db",
  "@skytwin/embedded-llm",
  "@skytwin/execution-router",
  "@skytwin/explanations",
  "@skytwin/policy-engine",
]);
const VERSION_SEGMENT = "(?:0|[1-9][0-9]{0,8})";
const FOUR_SEGMENT_TAG = new RegExp(
  `^v(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})$`,
);
const BETA_TAG = new RegExp(
  `^v(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})\\.(${VERSION_SEGMENT})-beta(?:\\.([1-9][0-9]{0,8}))?$`,
);
const FOUR_SEGMENT_VERSION = new RegExp(
  `^${VERSION_SEGMENT}\\.${VERSION_SEGMENT}\\.${VERSION_SEGMENT}\\.${VERSION_SEGMENT}$`,
);
const MACOS_SIGNING_METHODS = new Map([
  [
    "SkyTwin-macOS-dmg",
    "dmg-codesign+gatekeeper+stapler+dmg-contained-app-codesign",
  ],
  [
    "SkyTwin-macOS-zip",
    "bounded-volume+ditto-contained-app+codesign+gatekeeper+stapler",
  ],
]);
const WINDOWS_SIGNING_METHOD =
  "Get-AuthenticodeSignature(Status=Valid)+pinned-signer-certificate";
const WINDOWS_TIMESTAMP_VALIDATION =
  "presence-and-fingerprint-recorded-not-independently-validated";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactRecordKeys(value, expectedKeys) {
  return (
    isPlainRecord(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function addError(errors, message) {
  errors.push(message);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function relativePath(root, path) {
  return relative(root, path).split("\\").join("/");
}

function lineAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function decodeHtmlEntities(content) {
  const named = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["gt", ">"],
    ["lt", "<"],
    ["mdash", "—"],
    ["nbsp", " "],
    ["ndash", "–"],
    ["quot", '"'],
  ]);
  return content.replace(
    /&(?:#(x[0-9a-f]+|[0-9]+)|([a-z][a-z0-9]+));/gi,
    (entity, numeric, name) => {
      if (numeric) {
        const base = numeric[0].toLowerCase() === "x" ? 16 : 10;
        const digits = base === 16 ? numeric.slice(1) : numeric;
        const codePoint = Number.parseInt(digits, base);
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff
        )
          return entity;
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }
      return named.get(name.toLowerCase()) ?? entity;
    },
  );
}

function normalizeClaimText(content) {
  return (
    decodeHtmlEntities(content)
      // Preserve quoted attribute values while dropping element names. Removing
      // the whole tag would hide alt/title/meta claims; retaining the whole tag
      // would insert element names between adjacent visible words.
      .replace(/<[^>]*>/g, (tag) =>
        [...tag.matchAll(/["']([^"']+)["']/g)]
          .map((match) => match[1])
          .join(" "),
      )
      .replace(/\\(?:n|r|t)/g, " ")
      .replace(/["'`]/g, " ")
      .replace(/\s*\+\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function stripCodeComments(content) {
  let output = "";
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        blockComment = false;
      } else output += character === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      lineComment = true;
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockComment = true;
    } else output += character;
  }
  return output;
}

function nonCommentContent(content, extension) {
  let result = content.replace(/<!--[\s\S]*?-->/g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  if ([".css", ".js", ".mjs", ".ts", ".tsx"].includes(extension))
    result = stripCodeComments(result);
  if ([".sh", ".yaml", ".yml"].includes(extension))
    result = result.replace(/^[ \t]*#.*$/gm, "");
  return result;
}

function extractComposedLiteralText(content) {
  const literals = [];
  const uncommented = stripCodeComments(content);
  let quote = null;
  let escaped = false;
  let literal = "";
  for (const character of uncommented) {
    if (!quote) {
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        literal = "";
      }
      continue;
    }
    if (escaped) {
      literal += character;
      escaped = false;
    } else if (character === "\\") {
      literal += character;
      escaped = true;
    } else if (character === quote) {
      literals.push(
        literal
          // Keep literal words inside template interpolation visible. This is
          // deliberately conservative: identifiers may create false positives,
          // but deleting the expression lets public claims evade the audit.
          .replace(/\$\{/g, " ")
          .replace(/[{}]/g, " ")
          .replace(/\\(?:n|r|t)/g, " ")
          .replace(/\\(['"`\\])/g, "$1"),
      );
      quote = null;
      literal = "";
    } else {
      literal += character;
    }
  }
  return normalizeClaimText(literals.join("\n"));
}

function isInsideRoot(root, path) {
  const relativeToRoot = relative(root, path);
  return (
    relativeToRoot === "" ||
    (!relativeToRoot.startsWith("..") && !relativeToRoot.startsWith("/"))
  );
}

function hasSymlinkComponent(root, absolute) {
  const relativeToRoot = relative(root, absolute);
  if (
    relativeToRoot === "" ||
    relativeToRoot.startsWith("..") ||
    relativeToRoot.startsWith(sep)
  )
    return relativeToRoot !== "";
  let cursor = root;
  for (const component of relativeToRoot.split(sep)) {
    cursor = join(cursor, component);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) return true;
  }
  return false;
}

function resolveContainedRegularFile(root, candidate) {
  const absoluteRoot = realpathSync(resolve(root));
  const absolute = resolve(absoluteRoot, candidate);
  if (!isInsideRoot(absoluteRoot, absolute) || !existsSync(absolute))
    return null;
  if (hasSymlinkComponent(absoluteRoot, absolute)) return null;
  const resolved = realpathSync(absolute);
  if (!isInsideRoot(absoluteRoot, resolved)) return null;
  const stat = lstatSync(absolute);
  return stat.isFile() && !stat.isSymbolicLink() ? absolute : null;
}

export function normalizeReleaseTagToRepositoryVersion(tag) {
  if (!isNonEmptyString(tag)) return null;

  const stable = FOUR_SEGMENT_TAG.exec(tag);
  if (stable) return stable.slice(1, 5).join(".");

  const beta = BETA_TAG.exec(tag);
  if (!beta) return null;
  const [, major, minor, patch, build] = beta;
  return `${major}.${minor}.${patch}.${build ?? "0"}`;
}

function normalizeReleaseTagToAppVersion(tag) {
  if (!isNonEmptyString(tag)) return null;
  const match = FOUR_SEGMENT_TAG.exec(tag) ?? BETA_TAG.exec(tag);
  if (!match) return null;
  const [, major, minor, patch, rawBuild] = match;
  const build = rawBuild ?? "0";
  if (Number(build) >= 100 || Number(patch) > 999999) return null;
  return `${major}.${minor}.${Number(patch) * 100 + Number(build)}`;
}

function tokenizeVerificationCommand(command) {
  if (!isNonEmptyString(command) || command.length > 1000) return null;
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;

  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "`" || character === "$" || character === "\n")
        return null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    if (";|&<>`$".includes(character)) return null;
    token += character;
  }
  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

export function isAllowlistedVerificationCommand(command) {
  const tokens = tokenizeVerificationCommand(command);
  if (!tokens) return false;

  if (
    tokens.length === 2 &&
    tokens[0] === "pnpm" &&
    ["claims:check", "claims:test", "test:release-artifacts"].includes(
      tokens[1],
    )
  )
    return true;

  if (
    tokens.length === 5 &&
    tokens[0] === "pnpm" &&
    tokens[1] === "exec" &&
    tokens[2] === "vitest" &&
    tokens[3] === "run" &&
    tokens[4] ===
      "scripts/release-claims/release.artifact-verification.test.mjs"
  )
    return true;

  if (
    tokens.length >= 4 &&
    tokens[0] === "pnpm" &&
    tokens[1] === "--filter" &&
    VERIFICATION_PACKAGE_FILTERS.has(tokens[2]) &&
    tokens[3] === "test" &&
    tokens.slice(4).every((token) => /^[-A-Za-z0-9_@.*\/]+$/.test(token))
  ) {
    return true;
  }

  if (
    tokens.length < 5 ||
    tokens[0] !== "rg" ||
    tokens[1] !== "-n" ||
    tokens[2] !== "--"
  ) {
    return false;
  }
  const pattern = tokens[3];
  const paths = tokens.slice(4);
  return (
    !pattern.startsWith("-") &&
    /^[ A-Za-z0-9_@.*\/:'"|(){}\[\].,+?^$\\=-]+$/.test(pattern) &&
    paths.every(
      (path) =>
        !path.startsWith("-") &&
        !path.split("/").includes("..") &&
        /^[A-Za-z0-9_@.*\/.-]+$/.test(path),
    )
  );
}

function collectSurfaceFiles(root, surface, errors) {
  root = realpathSync(resolve(root));
  const absolute = resolve(root, surface.path);
  if (!isInsideRoot(root, absolute)) {
    addError(errors, `claim surface escapes repository root: ${surface.path}`);
    return [];
  }
  if (!existsSync(absolute)) {
    addError(errors, `claim surface does not exist: ${surface.path}`);
    return [];
  }

  if (hasSymlinkComponent(realpathSync(resolve(root)), absolute)) {
    addError(
      errors,
      `claim surface may not traverse symlinks: ${surface.path}`,
    );
    return [];
  }

  const stat = lstatSync(absolute);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) {
    addError(
      errors,
      `claim surface is neither a file nor directory: ${surface.path}`,
    );
    return [];
  }

  const extensions = new Set(asArray(surface.extensions));
  const excluded = new Set();
  for (const excludedPath of asArray(surface.exclude)) {
    const absoluteExcluded = resolve(root, excludedPath);
    if (!isInsideRoot(root, absoluteExcluded)) {
      addError(
        errors,
        `claim surface exclusion escapes repository root: ${excludedPath}`,
      );
      continue;
    }
    excluded.add(absoluteExcluded);
  }
  const files = [];
  const ignoredDirectoryNames = new Set([
    "node_modules",
    "dist",
    "coverage",
    "__tests__",
    "__mocks__",
  ]);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (excluded.has(path)) continue;
      if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name))
        continue;
      if (entry.isSymbolicLink()) {
        addError(
          errors,
          `claim surface contains a symlink: ${relativePath(root, path)}`,
        );
        continue;
      }
      if (entry.isDirectory()) visit(path);
      if (
        entry.isFile() &&
        (extensions.size === 0 || extensions.has(extname(entry.name)))
      ) {
        files.push(path);
      }
    }
  };
  visit(absolute);
  return files;
}

function requiredSurfaceSpecs(root) {
  const rootDocumentExtensions = new Set([
    ".adoc",
    ".htm",
    ".html",
    ".md",
    ".mdx",
    ".rst",
    ".txt",
  ]);
  const specs = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        rootDocumentExtensions.has(extname(entry.name).toLowerCase()),
    )
    .map((entry) => ({ class: "root-public", path: entry.name }));
  const optionalSpecs = [
    {
      class: "docs-public",
      path: "docs",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
      exclude: ["docs/beta-claim-ledger.json"],
    },
    {
      class: "web-public",
      path: "apps/web/public",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "desktop-public",
      path: "apps/desktop/src",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
      exclude: ["apps/desktop/src/__mocks__", "apps/desktop/src/__tests__"],
    },
    { class: "desktop-public", path: "apps/desktop/package.json" },
    {
      class: "desktop-public",
      path: "apps/desktop/scripts",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "desktop-public",
      path: "apps/api/src",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "desktop-public",
      path: "apps/worker/src",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "desktop-public",
      path: "packages",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "desktop-public",
      path: "bin",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "mobile-public",
      path: "apps/mobile/src",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
      exclude: ["apps/mobile/src/__tests__"],
    },
    { class: "mobile-public", path: "apps/mobile/app.json" },
    { class: "mobile-public", path: "apps/mobile/package.json" },
    { class: "release-metadata", path: "package.json" },
    { class: "release-metadata", path: "VERSION" },
    { class: "release-metadata", path: "pnpm-workspace.yaml" },
    { class: "release-metadata", path: "turbo.json" },
    {
      class: "release-metadata",
      path: ".github/workflows",
      extensions: [".yaml", ".yml"],
    },
    {
      class: "release-metadata",
      path: ".github/scripts",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    { class: "release-metadata", path: ".github/dependabot.yml" },
    {
      class: "release-templates",
      path: ".github/ISSUE_TEMPLATE",
      extensions: PUBLIC_DOCUMENT_EXTENSIONS,
    },
    {
      class: "release-templates",
      path: ".github/PULL_REQUEST_TEMPLATE.md",
    },
  ];
  return specs.concat(
    optionalSpecs.filter((spec) => existsSync(resolve(root, spec.path))),
  );
}

function collectPublicBinaryAssetPaths(root, errors) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        addError(
          errors,
          `public asset inventory contains a symlink: ${relativePath(root, absolute)}`,
        );
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        entry.isFile() &&
        PUBLIC_BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())
      ) {
        paths.push(relativePath(root, absolute));
      }
    }
  };
  for (const path of PUBLIC_BINARY_ROOTS) {
    const absolute = resolve(root, path);
    if (existsSync(absolute) && lstatSync(absolute).isDirectory())
      visit(absolute);
  }
  return paths.sort();
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    Array.isArray(expected) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function canonicalGithubTimestampMs(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
}

export function isArtifactCreationWithinProducerWindow(
  artifactCreatedAt,
  uploadStartedAt,
  producerCompletedAt,
) {
  const createdMs = canonicalGithubTimestampMs(artifactCreatedAt);
  const uploadStartedMs = canonicalGithubTimestampMs(uploadStartedAt);
  const producerCompletedMs = canonicalGithubTimestampMs(producerCompletedAt);
  return (
    createdMs !== null &&
    uploadStartedMs !== null &&
    producerCompletedMs !== null &&
    uploadStartedMs <= createdMs &&
    createdMs <= producerCompletedMs
  );
}

function validSigningArtifactProducers(
  producers,
  platform,
  runAttempt,
  attemptStartedAt,
) {
  const expectedNames =
    platform === "macos"
      ? ["SkyTwin-macOS-dmg", "SkyTwin-macOS-zip"]
      : platform === "windows"
        ? ["SkyTwin-Windows-installer"]
        : platform === "linux"
          ? ["SkyTwin-Linux-AppImage", "SkyTwin-Linux-deb", "SkyTwin-Linux-rpm"]
          : [];
  const attemptStartedMs = canonicalGithubTimestampMs(attemptStartedAt);
  if (
    attemptStartedMs === null ||
    !Array.isArray(producers) ||
    producers.length !== expectedNames.length ||
    !sameStringSet(
      producers.map((producer) => producer?.artifactName),
      expectedNames,
    ) ||
    new Set(producers.map((producer) => producer?.artifactId)).size !==
      producers.length
  )
    return false;
  const expectedKeys = [
    "artifactId",
    "artifactName",
    "artifactCreatedAt",
    "artifactUpdatedAt",
    "artifactProducerJobId",
    "artifactProducerJobName",
    "artifactProducerRunAttempt",
    "artifactProducerJobConclusion",
    "artifactProducerJobStartedAt",
    "artifactProducerJobCompletedAt",
    "artifactUploadStepName",
    "artifactUploadStepStartedAt",
    "artifactUploadStepCompletedAt",
  ];
  return producers.every((producer) => {
    if (!isPlainRecord(producer)) return false;
    const createdMs = canonicalGithubTimestampMs(producer.artifactCreatedAt);
    const updatedMs = canonicalGithubTimestampMs(producer.artifactUpdatedAt);
    const jobStartedMs = canonicalGithubTimestampMs(
      producer.artifactProducerJobStartedAt,
    );
    const jobCompletedMs = canonicalGithubTimestampMs(
      producer.artifactProducerJobCompletedAt,
    );
    const uploadStartedMs = canonicalGithubTimestampMs(
      producer.artifactUploadStepStartedAt,
    );
    const uploadCompletedMs = canonicalGithubTimestampMs(
      producer.artifactUploadStepCompletedAt,
    );
    return (
      sameStringSet(Object.keys(producer), expectedKeys) &&
      Number.isSafeInteger(producer.artifactId) &&
      producer.artifactId > 0 &&
      Number.isSafeInteger(producer.artifactProducerJobId) &&
      producer.artifactProducerJobId > 0 &&
      producer.artifactProducerJobName === desktopProducerJobName(platform) &&
      producer.artifactProducerRunAttempt === runAttempt &&
      producer.artifactProducerJobConclusion === "success" &&
      producer.artifactUploadStepName ===
        desktopArtifactUploadStepName(producer.artifactName) &&
      [
        createdMs,
        updatedMs,
        jobStartedMs,
        jobCompletedMs,
        uploadStartedMs,
        uploadCompletedMs,
      ].every((value) => value !== null) &&
      attemptStartedMs <= jobStartedMs &&
      jobStartedMs <= uploadStartedMs &&
      isArtifactCreationWithinProducerWindow(
        producer.artifactCreatedAt,
        producer.artifactUploadStepStartedAt,
        producer.artifactProducerJobCompletedAt,
      ) &&
      uploadStartedMs <= uploadCompletedMs &&
      uploadCompletedMs <= jobCompletedMs &&
      createdMs <= updatedMs
    );
  });
}

function canonicalEvidenceChecks(claimId, kind) {
  return (
    kind === "ci"
      ? CANONICAL_CI_EVIDENCE_CHECKS
      : CANONICAL_MACHINE_EVIDENCE_CHECKS
  ).get(claimId);
}

function validateExternalEvidenceShape(evidence, prefix, errors) {
  if (!isNonEmptyString(evidence.why))
    addError(errors, `${prefix}.why is required`);
  if (!GITHUB_REPOSITORY.test(evidence.repository ?? ""))
    addError(errors, `${prefix}.repository must be an owner/repository name`);
  if (!Number.isSafeInteger(evidence.runId) || evidence.runId <= 0)
    addError(errors, `${prefix}.runId must be a positive integer`);
  if (!Number.isSafeInteger(evidence.runAttempt) || evidence.runAttempt <= 0)
    addError(errors, `${prefix}.runAttempt must be a positive integer`);
  if (canonicalGithubTimestampMs(evidence.runAttemptStartedAt) === null)
    addError(
      errors,
      `${prefix}.runAttemptStartedAt must be a canonical GitHub timestamp`,
    );
  if (!isNonEmptyString(evidence.ref))
    addError(errors, `${prefix}.ref is required`);
  const expectedCheckIds = canonicalEvidenceChecks(
    evidence.claimId,
    evidence.kind,
  );
  if (!expectedCheckIds) {
    addError(
      errors,
      `${prefix} has no canonical semantic proof contract for ${evidence.claimId}:${evidence.kind}`,
    );
  } else if (!sameStringSet(evidence.checkIds, expectedCheckIds)) {
    addError(
      errors,
      `${prefix}.checkIds must equal the canonical claim-specific check IDs: ${expectedCheckIds.join(", ")}`,
    );
  }
  if (evidence.kind === "ci") {
    if (!Number.isSafeInteger(evidence.artifactId) || evidence.artifactId <= 0)
      addError(errors, `${prefix}.artifactId must be a positive integer`);
    if (!isNonEmptyString(evidence.artifactName))
      addError(errors, `${prefix}.artifactName is required`);
    if (!Number.isSafeInteger(evidence.jobId) || evidence.jobId <= 0)
      addError(errors, `${prefix}.jobId must be a positive integer`);
    if (!isNonEmptyString(evidence.jobName))
      addError(errors, `${prefix}.jobName is required`);
    else if (evidence.jobName !== CI_EVIDENCE_JOB_NAME)
      addError(errors, `${prefix}.jobName must be ${CI_EVIDENCE_JOB_NAME}`);
    if (evidence.artifactName !== CI_EVIDENCE_ARTIFACT_NAME)
      addError(
        errors,
        `${prefix}.artifactName must be ${CI_EVIDENCE_ARTIFACT_NAME}`,
      );
    if (!COMMIT_SHA.test(evidence.commitSha ?? ""))
      addError(
        errors,
        `${prefix}.commitSha must be a lowercase 40-character commit SHA`,
      );
    if (!SOURCE_DIGEST.test(evidence.artifactSha256 ?? ""))
      addError(
        errors,
        `${prefix}.artifactSha256 must be a lowercase SHA-256 digest`,
      );
    if (evidence.reportPath !== "artifacts/release-claims-ci/result.json")
      addError(
        errors,
        `${prefix}.reportPath must identify the downloaded CI result`,
      );
    if (!SOURCE_DIGEST.test(evidence.reportSha256 ?? ""))
      addError(
        errors,
        `${prefix}.reportSha256 must be a lowercase SHA-256 digest`,
      );
    if (evidence.conclusion !== "success")
      addError(errors, `${prefix}.conclusion must be success`);
  } else {
    if (
      evidence.artifactId !== undefined ||
      evidence.artifactName !== undefined
    )
      addError(
        errors,
        `${prefix} must use explicit evidenceArtifact* and releaseArtifact* fields`,
      );
    const expectedReportPath = [
      "sample.packaged-account-free",
      "release.signing",
    ].includes(evidence.claimId)
      ? `.release-evidence/reports/${evidence.claimId}.${evidence.platform}.json`
      : `.release-evidence/reports/${evidence.claimId}.json`;
    if (evidence.reportPath !== expectedReportPath)
      addError(
        errors,
        `${prefix}.reportPath must be a safe .release-evidence/reports/*.json path`,
      );
    if (evidence.evidenceArtifactName !== MACHINE_EVIDENCE_ARTIFACT_NAME)
      addError(
        errors,
        `${prefix}.evidenceArtifactName must be ${MACHINE_EVIDENCE_ARTIFACT_NAME}`,
      );
    for (const field of [
      "platform",
      "releaseTag",
      "releaseArtifactKind",
      "releaseArtifactName",
      "subjectName",
    ]) {
      if (!isNonEmptyString(evidence[field]))
        addError(errors, `${prefix}.${field} is required`);
    }
    for (const field of ["releaseArtifactName", "subjectName"]) {
      if (
        isNonEmptyString(evidence[field]) &&
        !/^[A-Za-z0-9][A-Za-z0-9_.+() -]{0,240}$/.test(evidence[field])
      )
        addError(errors, `${prefix}.${field} must be a plain filename/name`);
    }
    if (
      evidence.subjectPath !==
      `artifacts/${evidence.releaseArtifactName}/${evidence.subjectName}`
    )
      addError(
        errors,
        `${prefix}.subjectPath must identify the downloaded release artifact subject`,
      );
    for (const field of ["evidenceArtifactId", "releaseArtifactId"]) {
      if (!Number.isSafeInteger(evidence[field]) || evidence[field] <= 0)
        addError(errors, `${prefix}.${field} must be a positive integer`);
    }
    const sourceReportFields = [
      "sourceReportArtifactId",
      "sourceReportArtifactName",
      "sourceReportArtifactSha256",
      "sourceReportArtifactCreatedAt",
      "sourceReportArtifactUpdatedAt",
      "artifactProducers",
    ];
    if (evidence.claimId === "release.signing") {
      if (
        !Number.isSafeInteger(evidence.sourceReportArtifactId) ||
        evidence.sourceReportArtifactId <= 0
      )
        addError(
          errors,
          `${prefix}.sourceReportArtifactId must be a positive integer`,
        );
      if (
        evidence.sourceReportArtifactName !==
        `release-signing-report-${evidence.platform}-attempt-${evidence.runAttempt}`
      )
        addError(
          errors,
          `${prefix}.sourceReportArtifactName must bind the platform and run attempt`,
        );
      if (!SOURCE_DIGEST.test(evidence.sourceReportArtifactSha256 ?? ""))
        addError(
          errors,
          `${prefix}.sourceReportArtifactSha256 must be the Actions archive SHA-256 digest`,
        );
      if (
        canonicalGithubTimestampMs(evidence.sourceReportArtifactCreatedAt) ===
          null ||
        canonicalGithubTimestampMs(evidence.sourceReportArtifactUpdatedAt) ===
          null
      )
        addError(
          errors,
          `${prefix}.sourceReportArtifactCreatedAt and sourceReportArtifactUpdatedAt must be canonical GitHub timestamps`,
        );
      if (!Array.isArray(evidence.artifactProducers))
        addError(
          errors,
          `${prefix}.artifactProducers must bind every signed artifact to its desktop upload job and step`,
        );
    } else if (
      sourceReportFields.some((field) => evidence[field] !== undefined)
    )
      addError(
        errors,
        `${prefix} may carry source report artifact fields only for release.signing`,
      );
    if (
      !Number.isSafeInteger(evidence.producerJobId) ||
      evidence.producerJobId <= 0
    )
      addError(errors, `${prefix}.producerJobId must be a positive integer`);
    const expectedProducerJobName = machineProducerJobName(
      evidence.claimId,
      evidence.platform,
    );
    if (evidence.producerJobName !== expectedProducerJobName)
      addError(
        errors,
        `${prefix}.producerJobName must identify the canonical claim/platform producer job`,
      );
    if (evidence.producerJobConclusion !== "success")
      addError(errors, `${prefix}.producerJobConclusion must be success`);
    if (evidence.producerJobRunAttempt !== evidence.runAttempt)
      addError(
        errors,
        `${prefix}.producerJobRunAttempt must equal the evidence runAttempt`,
      );
    const expectedVerifierPath = machineVerifierPath(evidence.claimId);
    const expectedVerifierCommand = machineVerifierCommand(
      evidence.claimId,
      evidence.platform,
    );
    if (evidence.verifierPath !== expectedVerifierPath)
      addError(errors, `${prefix}.verifierPath must be the canonical verifier`);
    if (evidence.verifierCommand !== expectedVerifierCommand)
      addError(
        errors,
        `${prefix}.verifierCommand must invoke the canonical verifier exactly`,
      );
    if (!SOURCE_DIGEST.test(evidence.verifierSha256 ?? ""))
      addError(
        errors,
        `${prefix}.verifierSha256 must be a lowercase SHA-256 digest`,
      );
    if (
      ![
        "desktop-archive",
        "desktop-installer",
        "mobile-package",
        "update-manifest",
      ].includes(evidence.releaseArtifactKind)
    )
      addError(errors, `${prefix}.releaseArtifactKind is unsupported`);
    if (!COMMIT_SHA.test(evidence.sourceCommit ?? ""))
      addError(
        errors,
        `${prefix}.sourceCommit must be a lowercase 40-character commit SHA`,
      );
    for (const field of [
      "evidenceArtifactSha256",
      "releaseArtifactSha256",
      "reportSha256",
      "subjectSha256",
    ]) {
      if (!SOURCE_DIGEST.test(evidence[field] ?? ""))
        addError(
          errors,
          `${prefix}.${field} must be a lowercase SHA-256 digest`,
        );
    }
  }
  for (const forbidden of ["immutableId", "path", "sha256", "reportUri"]) {
    if (evidence[forbidden] !== undefined)
      addError(
        errors,
        `${prefix}.${forbidden} is not valid for ${evidence.kind} evidence`,
      );
  }
}

function validateReleaseAssetManifest(manifest, errors) {
  const expected = new Map(CANONICAL_RELEASE_ASSETS);
  const seen = new Set();
  const seenIds = new Set();
  for (const [index, asset] of asArray(manifest?.releaseAssets).entries()) {
    const prefix = `release evidence manifest releaseAssets[${index}]`;
    if (!isNonEmptyString(asset?.artifactName)) {
      addError(errors, `${prefix}.artifactName is required`);
      continue;
    }
    if (seen.has(asset.artifactName))
      addError(errors, `${prefix} duplicates ${asset.artifactName}`);
    seen.add(asset.artifactName);
    const expectedKind = expected.get(asset.artifactName);
    if (!expectedKind)
      addError(errors, `${prefix} is not in the canonical published asset set`);
    else if (asset.kind !== expectedKind)
      addError(errors, `${prefix}.kind must be ${expectedKind}`);
    if (!Number.isSafeInteger(asset.artifactId) || asset.artifactId <= 0)
      addError(errors, `${prefix}.artifactId must be a positive integer`);
    else if (seenIds.has(asset.artifactId))
      addError(errors, `${prefix}.artifactId is duplicated`);
    else seenIds.add(asset.artifactId);
    if (!SOURCE_DIGEST.test(asset.artifactSha256 ?? ""))
      addError(errors, `${prefix}.artifactSha256 must be a SHA-256 digest`);
    const subjectPaths = new Set();
    if (asArray(asset.subjects).length === 0)
      addError(errors, `${prefix}.subjects must be non-empty`);
    for (const [subjectIndex, subject] of asArray(asset.subjects).entries()) {
      const subjectPrefix = `${prefix}.subjects[${subjectIndex}]`;
      if (
        !isNonEmptyString(subject?.name) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.+() -]{0,240}$/.test(subject.name)
      )
        addError(errors, `${subjectPrefix}.name must be a plain filename`);
      const expectedPath = `artifacts/${asset.artifactName}/${subject?.name}`;
      if (subject?.path !== expectedPath)
        addError(errors, `${subjectPrefix}.path must equal ${expectedPath}`);
      if (subjectPaths.has(subject?.path))
        addError(errors, `${subjectPrefix}.path is duplicated`);
      subjectPaths.add(subject?.path);
      if (!SOURCE_DIGEST.test(subject?.sha256 ?? ""))
        addError(errors, `${subjectPrefix}.sha256 must be a SHA-256 digest`);
      if (!Number.isSafeInteger(subject?.sizeBytes) || subject.sizeBytes <= 0)
        addError(
          errors,
          `${subjectPrefix}.sizeBytes must be a positive integer`,
        );
    }
  }
  for (const [name] of expected) {
    if (!seen.has(name))
      addError(
        errors,
        `release evidence manifest is missing release asset: ${name}`,
      );
  }
  for (const name of seen) {
    if (!expected.has(name))
      addError(
        errors,
        `release evidence manifest has unexpected release asset: ${name}`,
      );
  }
}

function validateArtifactVerificationAssetManifest(manifest, errors) {
  const canonical = new Map(CANONICAL_ARTIFACT_VERIFICATION_ASSETS);
  const seenNames = new Set();
  const seenPaths = new Set();
  const seenCanonical = new Set();
  let provenanceBundleCount = 0;
  for (const [index, asset] of asArray(
    manifest?.verificationAssets,
  ).entries()) {
    const prefix = `release evidence manifest verificationAssets[${index}]`;
    const canonicalKind = canonical.get(asset?.name);
    const expectedKind =
      canonicalKind ??
      (/^[a-f0-9]{64}\.attestation\.jsonl$/.test(asset?.name ?? "")
        ? "provenance-bundle"
        : null);
    if (!expectedKind) {
      addError(errors, `${prefix}.name is not canonical`);
      continue;
    }
    if (asset.kind !== expectedKind)
      addError(errors, `${prefix}.kind must be ${expectedKind}`);
    if (asset.path !== `${ARTIFACT_VERIFICATION_DIRECTORY}/${asset.name}`)
      addError(errors, `${prefix}.path is not canonical`);
    if (!SOURCE_DIGEST.test(asset.sha256 ?? ""))
      addError(errors, `${prefix}.sha256 must be a SHA-256 digest`);
    if (seenNames.has(asset.name))
      addError(errors, `${prefix}.name is duplicated`);
    if (seenPaths.has(asset.path))
      addError(errors, `${prefix}.path is duplicated`);
    seenNames.add(asset.name);
    seenPaths.add(asset.path);
    if (canonicalKind) seenCanonical.add(asset.name);
    else provenanceBundleCount += 1;
  }
  for (const [name] of canonical) {
    if (!seenCanonical.has(name))
      addError(
        errors,
        `release evidence manifest is missing artifact-verification asset: ${name}`,
      );
  }
  if (provenanceBundleCount === 0)
    addError(
      errors,
      "release evidence manifest is missing artifact-verification provenance bundles",
    );
}

function collectDownloadedArtifactSubjects(root, artifactName, errors) {
  const directory = resolve(root, "artifacts", artifactName);
  if (
    !isInsideRoot(root, directory) ||
    !existsSync(directory) ||
    hasSymlinkComponent(root, directory) ||
    !lstatSync(directory).isDirectory()
  ) {
    addError(
      errors,
      `downloaded release artifact directory is missing or unsafe: artifacts/${artifactName}`,
    );
    return [];
  }
  const subjects = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        addError(
          errors,
          `downloaded release artifact contains a symlink: ${relativePath(root, absolute)}`,
        );
      } else if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) subjects.push(relativePath(root, absolute));
      else
        addError(
          errors,
          `downloaded release artifact contains a non-regular entry: ${relativePath(root, absolute)}`,
        );
    }
  };
  visit(directory);
  return subjects.sort();
}

export function verifyRequiredSurfaceCoverage(ledger, root) {
  root = realpathSync(resolve(root));
  const errors = [];
  const configuredByClass = new Map();
  for (const surface of asArray(ledger?.claimSurfaces)) {
    if (!REQUIRED_SURFACE_CLASSES.has(surface?.class)) continue;
    if (!configuredByClass.has(surface.class))
      configuredByClass.set(surface.class, new Set());
    for (const file of collectSurfaceFiles(root, surface, errors))
      configuredByClass.get(surface.class).add(file);
  }

  for (const required of requiredSurfaceSpecs(root)) {
    const requiredFiles = collectSurfaceFiles(root, required, errors);
    const configured = configuredByClass.get(required.class) ?? new Set();
    for (const file of requiredFiles) {
      if (!configured.has(file)) {
        addError(
          errors,
          `${required.class} claim surfaces do not cover required file: ${relativePath(root, file)}`,
        );
      }
    }
  }
  return errors;
}

export function verifyCanonicalReleasePublisher(root) {
  root = realpathSync(resolve(root));
  const errors = [];
  const workflowPath = resolveContainedRegularFile(
    root,
    RELEASE_EVIDENCE_WORKFLOW_PATH,
  );
  if (!workflowPath) {
    addError(errors, "canonical release workflow is missing or unsafe");
    return errors;
  }
  const publicationSources = [];
  const workflowSources = [];
  const workflowDirectory = resolve(root, ".github/workflows");
  if (existsSync(workflowDirectory)) {
    for (const entry of readdirSync(workflowDirectory, {
      withFileTypes: true,
    })) {
      if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        const path = resolve(workflowDirectory, entry.name);
        publicationSources.push(path);
        workflowSources.push(path);
      }
    }
  }
  for (const directoryName of [".github/scripts", "scripts"]) {
    const directory = resolve(root, directoryName);
    if (!existsSync(directory)) continue;
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && !/\.test\.[^.]+$/i.test(entry.name))
          publicationSources.push(path);
      }
    };
    visit(directory);
  }
  const allPublicationSource = publicationSources
    .map((path) =>
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*#.*$/, ""))
        .join("\n"),
    )
    .join("\n");
  const isRecord = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const parsedWorkflows = new Map();
  for (const path of workflowSources) {
    const document = parseDocument(readFileSync(path, "utf8"), {
      merge: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      for (const error of document.errors)
        addError(
          errors,
          `workflow YAML is invalid (${relativePath(root, path)}): ${error.message}`,
        );
      continue;
    }
    const workflow = document.toJS();
    if (!isRecord(workflow)) {
      addError(
        errors,
        `workflow YAML must be a mapping: ${relativePath(root, path)}`,
      );
      continue;
    }
    parsedWorkflows.set(path, workflow);
  }
  const containsWritePermission = (permissions) =>
    permissions === "write-all" ||
    (isRecord(permissions) &&
      Object.values(permissions).some((value) => value === "write"));
  const hasContentsWrite = (permissions) =>
    permissions === "write-all" ||
    (isRecord(permissions) && permissions.contents === "write");
  const contentsWriteJobs = [];
  for (const [path, workflow] of parsedWorkflows) {
    if (
      !isRecord(workflow.permissions) ||
      Object.keys(workflow.permissions).length !== 1 ||
      workflow.permissions.contents !== "read"
    )
      addError(
        errors,
        `workflow must declare the exact read-only default permissions: ${relativePath(root, path)}`,
      );
    if (containsWritePermission(workflow.permissions))
      addError(
        errors,
        `workflow-level write permissions are prohibited: ${relativePath(root, path)}`,
      );
    if (!isRecord(workflow.jobs)) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job)) continue;
      const isCanonicalMachineProducerPermissions =
        path === workflowPath &&
        jobName === "release-machine-evidence" &&
        isRecord(job.permissions) &&
        Object.keys(job.permissions).length === 2 &&
        job.permissions.contents === "read" &&
        job.permissions.actions === "read";
      const isCanonicalArtifactMaterialsPermissions =
        path === workflowPath &&
        jobName === RELEASE_ARTIFACT_MATERIALS_JOB &&
        isRecord(job.permissions) &&
        Object.keys(job.permissions).length === 5 &&
        job.permissions.contents === "read" &&
        job.permissions.actions === "read" &&
        job.permissions["id-token"] === "write" &&
        job.permissions.attestations === "write" &&
        job.permissions["artifact-metadata"] === "write";
      if (
        job.permissions !== undefined &&
        (path !== workflowPath || jobName !== "release") &&
        !isCanonicalMachineProducerPermissions &&
        !isCanonicalArtifactMaterialsPermissions
      )
        addError(
          errors,
          `non-release job permissions must inherit the exact read-only workflow default: ${relativePath(root, path)} jobs.${jobName}`,
        );
      if (hasContentsWrite(job.permissions))
        contentsWriteJobs.push({ path, jobName });
      if (
        containsWritePermission(job.permissions) &&
        (path !== workflowPath ||
          !["release", RELEASE_ARTIFACT_MATERIALS_JOB].includes(jobName))
      )
        addError(
          errors,
          `write-capable workflow job is outside the canonical publisher: ${relativePath(root, path)} jobs.${jobName}`,
        );
    }
  }
  const credentialViolations = new Set();
  const inspectNonReleaseCredentials = (value, location, key = "") => {
    if (typeof value === "string") {
      for (const expression of value.matchAll(/\$\{\{[\s\S]*?\}\}/g)) {
        if (!/\bsecrets\b/.test(expression[0])) continue;
        const secretNames = [
          ...expression[0].matchAll(
            /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/g,
          ),
        ].map((match) => match[1] ?? match[3]);
        if (
          secretNames.length === 0 ||
          secretNames.some(
            (name) => !AUDITED_NON_RELEASE_SECRET_NAMES.has(name),
          )
        )
          credentialViolations.add(
            `${location} references a non-allowlisted secrets context`,
          );
      }
      const tokenKey =
        key !== "id-token" && /(?:^|[-_])(?:pat|token)(?:$|[-_])/i.test(key);
      if (tokenKey && value !== "${{ github.token }}")
        credentialViolations.add(`${location} supplies ${key}`);
      if (key === "secrets" && value === "inherit")
        credentialViolations.add(`${location} inherits all secrets`);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries())
        inspectNonReleaseCredentials(item, `${location}[${index}]`);
      return;
    }
    if (!isRecord(value)) return;
    for (const [childKey, childValue] of Object.entries(value))
      inspectNonReleaseCredentials(
        childValue,
        `${location}.${childKey}`,
        childKey,
      );
  };
  for (const [path, workflow] of parsedWorkflows) {
    const workflowLocation = relativePath(root, path);
    const workflowControls = Object.fromEntries(
      Object.entries(workflow).filter(([key]) => key !== "jobs"),
    );
    inspectNonReleaseCredentials(workflowControls, workflowLocation);
    if (!isRecord(workflow.jobs)) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (path === workflowPath && jobName === "release") continue;
      inspectNonReleaseCredentials(job, `${workflowLocation} jobs.${jobName}`);
    }
  }
  for (const violation of credentialViolations)
    addError(
      errors,
      `non-release workflow credentials are not allowlisted: ${violation}`,
    );
  if (
    contentsWriteJobs.length !== 1 ||
    contentsWriteJobs[0]?.path !== workflowPath ||
    contentsWriteJobs[0]?.jobName !== "release"
  )
    addError(
      errors,
      "exactly one job must have contents:write, and it must be build.yml jobs.release",
    );
  const publisherActions = [];
  for (const [path, workflow] of parsedWorkflows) {
    if (!isRecord(workflow.jobs)) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue;
      for (const [stepIndex, step] of job.steps.entries()) {
        if (
          isRecord(step) &&
          typeof step.uses === "string" &&
          step.uses.startsWith("softprops/action-gh-release@")
        ) {
          publisherActions.push({ path, jobName, stepIndex, step });
        }
      }
    }
  }
  if (publisherActions.length !== 1)
    addError(
      errors,
      `all workflows must contain exactly one GitHub release action; found ${publisherActions.length}`,
    );
  const canonicalWorkflow = parsedWorkflows.get(workflowPath);
  if (!isRecord(canonicalWorkflow)) return errors;
  const mutableCanonicalActionLocations = [];
  const isImmutableActionReference = (reference) =>
    typeof reference === "string" &&
    (reference.startsWith("./") ||
      /^[^@\s]+@[a-f0-9]{40}$/.test(reference) ||
      /^docker:\/\/[^\s]+@sha256:[a-f0-9]{64}$/.test(reference));
  for (const [jobName, job] of Object.entries(canonicalWorkflow.jobs ?? {})) {
    if (!isRecord(job)) continue;
    if (job.uses !== undefined && !isImmutableActionReference(job.uses))
      mutableCanonicalActionLocations.push(`jobs.${jobName}.uses`);
    for (const [stepIndex, step] of asArray(job.steps).entries()) {
      if (
        isRecord(step) &&
        step.uses !== undefined &&
        !isImmutableActionReference(step.uses)
      )
        mutableCanonicalActionLocations.push(
          `jobs.${jobName}.steps[${stepIndex}].uses`,
        );
    }
  }
  if (mutableCanonicalActionLocations.length > 0)
    addError(
      errors,
      `canonical build workflow actions must use immutable full commit SHAs: ${mutableCanonicalActionLocations.join(", ")}`,
    );
  const releaseJob = isRecord(canonicalWorkflow.jobs)
    ? canonicalWorkflow.jobs.release
    : undefined;
  if (!isRecord(releaseJob) || !Array.isArray(releaseJob.steps)) {
    addError(errors, "canonical release job is missing");
    return errors;
  }
  const releaseSteps = releaseJob.steps;
  const hasExactKeys = (value, expectedKeys) =>
    isRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
  const machineProducerJob =
    canonicalWorkflow.jobs?.["release-machine-evidence"];
  const desktopLinuxJob = canonicalWorkflow.jobs?.["desktop-linux"];
  const evidenceAggregatorJob =
    canonicalWorkflow.jobs?.["aggregate-release-evidence"];
  const artifactMaterialsJob =
    canonicalWorkflow.jobs?.[RELEASE_ARTIFACT_MATERIALS_JOB];
  const artifactMaterialSources = [
    RELEASE_ARTIFACT_GENERATOR_PATH,
    RELEASE_ARTIFACT_VALIDATOR_PATH,
    RELEASE_ATTESTATION_MATERIALIZER_PATH,
    "scripts/release-claims/verifiers/release.artifact-verification.mjs",
  ];
  const desktopLinuxAppImageUpload = asArray(desktopLinuxJob?.steps).filter(
    (step) => step?.name === "Upload Linux AppImage",
  );
  if (
    !isRecord(desktopLinuxJob?.outputs) ||
    !hasExactKeys(desktopLinuxJob.outputs, [
      "appimage-artifact-id",
      "appimage-artifact-digest",
    ]) ||
    desktopLinuxJob.outputs["appimage-artifact-id"] !==
      "${{ steps.upload-linux-appimage.outputs.artifact-id }}" ||
    desktopLinuxJob.outputs["appimage-artifact-digest"] !==
      "${{ steps.upload-linux-appimage.outputs.artifact-digest }}" ||
    desktopLinuxAppImageUpload.length !== 1 ||
    desktopLinuxAppImageUpload[0].id !== "upload-linux-appimage" ||
    desktopLinuxAppImageUpload[0].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.uploadArtifact
  )
    addError(
      errors,
      "Linux AppImage upload must expose its immutable current-attempt artifact ID and digest",
    );
  for (const sourcePath of artifactMaterialSources) {
    if (!resolveContainedRegularFile(root, sourcePath))
      addError(
        errors,
        `release artifact material source is missing or unsafe: ${sourcePath}`,
      );
  }
  const artifactMaterialSteps = isRecord(artifactMaterialsJob)
    ? artifactMaterialsJob.steps
    : null;
  const canonicalArtifactDownloads = CANONICAL_RELEASE_ASSETS.map(
    ([artifactName]) => ({
      name: `Download ${artifactName}`,
      uses: PINNED_RELEASE_WORKFLOW_ACTIONS.downloadArtifact,
      with: {
        name: artifactName,
        path: `artifacts/${artifactName}`,
      },
    }),
  );
  const expectedIdentityRun =
    'bash .github/scripts/derive-app-version.sh\nCREATED_UTC="$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')"\nprintf \'CREATED_UTC=%s\\n\' "$CREATED_UTC" >> "$GITHUB_ENV"\n';
  const expectedGeneratorRun = `node ${RELEASE_ARTIFACT_GENERATOR_PATH} --root artifacts --output ${RELEASE_ARTIFACT_STAGING_DIRECTORY} --repository \"$GITHUB_REPOSITORY\" --commit \"$GITHUB_SHA\" --ref \"$GITHUB_REF\" --releaseTag \"$GITHUB_REF_NAME\" --appVersion \"$APP_VERSION\" --runId \"$GITHUB_RUN_ID\" --created \"$CREATED_UTC\"`;
  const expectedValidatorRun = `node ${RELEASE_ARTIFACT_VALIDATOR_PATH} --root ${RELEASE_ARTIFACT_STAGING_DIRECTORY} --manifest ${RELEASE_ARTIFACT_MANIFEST_PATH} --repository "$GITHUB_REPOSITORY" --commit "$GITHUB_SHA" --ref "$GITHUB_REF" --releaseTag "$GITHUB_REF_NAME" --appVersion "$APP_VERSION" --runId "$GITHUB_RUN_ID" --created "$CREATED_UTC"`;
  const expectedMaterializerRun = `node ${RELEASE_ATTESTATION_MATERIALIZER_PATH} --manifest ${RELEASE_ARTIFACT_MANIFEST_PATH} --bundle \"\${{ steps.attest-release-artifacts.outputs.bundle-path }}\" --output ${RELEASE_ARTIFACT_MATERIALS_DIRECTORY}`;
  const canonicalJobNames = Object.keys(canonicalWorkflow.jobs ?? {});
  const artifactMaterialsJobIndex = canonicalJobNames.indexOf(
    RELEASE_ARTIFACT_MATERIALS_JOB,
  );
  const desktopJobIndexes = [
    "desktop-mac",
    "desktop-windows",
    "desktop-linux",
  ].map((jobName) => canonicalJobNames.indexOf(jobName));
  const desktopArtifactOutputContracts = [
    {
      jobName: "desktop-mac",
      uploads: [
        ["Upload macOS DMG", "upload-macos-dmg", "dmg"],
        ["Upload macOS ZIP", "upload-macos-zip", "zip"],
      ],
    },
    {
      jobName: "desktop-windows",
      uploads: [
        ["Upload Windows installer", "upload-windows-installer", "installer"],
      ],
    },
    {
      jobName: "desktop-linux",
      uploads: [
        ["Upload Linux AppImage", "upload-linux-appimage", "appimage"],
        ["Upload Linux deb", "upload-linux-deb", "deb"],
        ["Upload Linux rpm", "upload-linux-rpm", "rpm"],
      ],
    },
  ];
  for (const { jobName, uploads } of desktopArtifactOutputContracts) {
    const job = canonicalWorkflow.jobs?.[jobName];
    const expectedOutputNames = uploads.flatMap(([, , outputPrefix]) => [
      `${outputPrefix}-artifact-id`,
      `${outputPrefix}-artifact-digest`,
    ]);
    const outputsValid =
      isRecord(job?.outputs) &&
      hasExactKeys(job.outputs, expectedOutputNames) &&
      uploads.every(([, stepId, outputPrefix]) =>
        ["id", "digest"].every(
          (field) =>
            job.outputs[`${outputPrefix}-artifact-${field}`] ===
            `\${{ steps.${stepId}.outputs.artifact-${field} }}`,
        ),
      );
    const uploadStepsValid = uploads.every(([stepName, stepId]) => {
      const matches = asArray(job?.steps).filter(
        (step) => step?.name === stepName,
      );
      return (
        matches.length === 1 &&
        matches[0].id === stepId &&
        matches[0].uses === PINNED_RELEASE_WORKFLOW_ACTIONS.uploadArtifact
      );
    });
    if (!outputsValid || !uploadStepsValid)
      addError(
        errors,
        `${jobName} must expose exact pinned upload-artifact ID and digest outputs for signing provenance`,
      );
  }
  if (
    !isRecord(artifactMaterialsJob) ||
    !hasExactKeys(artifactMaterialsJob, [
      "name",
      "if",
      "needs",
      "runs-on",
      "permissions",
      "steps",
    ]) ||
    artifactMaterialsJob.name !==
      "Produce release artifact verification materials" ||
    artifactMaterialsJob.if !== "startsWith(github.ref, 'refs/tags/v')" ||
    JSON.stringify(artifactMaterialsJob.needs) !==
      JSON.stringify(["desktop-mac", "desktop-windows", "desktop-linux"]) ||
    artifactMaterialsJob["runs-on"] !== "ubuntu-24.04" ||
    !hasExactKeys(artifactMaterialsJob.permissions, [
      "contents",
      "actions",
      "id-token",
      "attestations",
      "artifact-metadata",
    ]) ||
    artifactMaterialsJob.permissions.contents !== "read" ||
    artifactMaterialsJob.permissions.actions !== "read" ||
    artifactMaterialsJob.permissions["id-token"] !== "write" ||
    artifactMaterialsJob.permissions.attestations !== "write" ||
    artifactMaterialsJob.permissions["artifact-metadata"] !== "write" ||
    desktopJobIndexes.some((index) => index < 0) ||
    artifactMaterialsJobIndex <= Math.max(...desktopJobIndexes) ||
    !Array.isArray(artifactMaterialSteps) ||
    artifactMaterialSteps.length !== 16 ||
    !isRecord(artifactMaterialSteps[0]) ||
    !hasExactKeys(artifactMaterialSteps[0], ["uses", "with"]) ||
    artifactMaterialSteps[0].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.checkout ||
    !hasExactKeys(artifactMaterialSteps[0].with, ["persist-credentials"]) ||
    artifactMaterialSteps[0].with["persist-credentials"] !== false ||
    !isRecord(artifactMaterialSteps[1]) ||
    !hasExactKeys(artifactMaterialSteps[1], ["name", "shell", "run"]) ||
    artifactMaterialSteps[1].name !== "Derive release artifact identity" ||
    artifactMaterialSteps[1].shell !== "bash" ||
    artifactMaterialSteps[1].run !== expectedIdentityRun ||
    JSON.stringify(artifactMaterialSteps.slice(2, 11)) !==
      JSON.stringify(canonicalArtifactDownloads) ||
    !isRecord(artifactMaterialSteps[11]) ||
    !hasExactKeys(artifactMaterialSteps[11], ["name", "shell", "run"]) ||
    artifactMaterialSteps[11].name !==
      "Generate exact release artifact materials" ||
    artifactMaterialSteps[11].shell !== "bash" ||
    artifactMaterialSteps[11].run !== expectedGeneratorRun ||
    !isRecord(artifactMaterialSteps[12]) ||
    !hasExactKeys(artifactMaterialSteps[12], ["name", "shell", "run"]) ||
    artifactMaterialSteps[12].name !==
      "Validate staged release artifact materials" ||
    artifactMaterialSteps[12].shell !== "bash" ||
    artifactMaterialSteps[12].run !== expectedValidatorRun ||
    !isRecord(artifactMaterialSteps[13]) ||
    !hasExactKeys(artifactMaterialSteps[13], ["name", "id", "uses", "with"]) ||
    artifactMaterialSteps[13].name !==
      "Attest exact release artifact subjects" ||
    artifactMaterialSteps[13].id !== "attest-release-artifacts" ||
    artifactMaterialSteps[13].uses !== PINNED_RELEASE_WORKFLOW_ACTIONS.attest ||
    !hasExactKeys(artifactMaterialSteps[13].with, ["subject-checksums"]) ||
    artifactMaterialSteps[13].with["subject-checksums"] !==
      `${RELEASE_ARTIFACT_MATERIALS_DIRECTORY}/SHA256SUMS` ||
    !isRecord(artifactMaterialSteps[14]) ||
    !hasExactKeys(artifactMaterialSteps[14], ["name", "shell", "run"]) ||
    artifactMaterialSteps[14].name !==
      "Materialize digest-named provenance bundles" ||
    artifactMaterialSteps[14].shell !== "bash" ||
    artifactMaterialSteps[14].run !== expectedMaterializerRun ||
    !isRecord(artifactMaterialSteps[15]) ||
    !hasExactKeys(artifactMaterialSteps[15], ["name", "uses", "with"]) ||
    artifactMaterialSteps[15].name !==
      "Upload release artifact verification materials" ||
    artifactMaterialSteps[15].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.uploadArtifact ||
    !hasExactKeys(artifactMaterialSteps[15].with, [
      "name",
      "path",
      "if-no-files-found",
      "compression-level",
    ]) ||
    artifactMaterialSteps[15].with.name !==
      RELEASE_ARTIFACT_MATERIALS_ARTIFACT ||
    artifactMaterialSteps[15].with.path !==
      RELEASE_ARTIFACT_MATERIALS_DIRECTORY ||
    artifactMaterialSteps[15].with["if-no-files-found"] !== "error" ||
    artifactMaterialSteps[15].with["compression-level"] !== 0
  )
    addError(
      errors,
      "release artifact materials must use the exact tag-only permission, download, generation, attestation, materialization, and upload graph",
    );
  const expectedMachineMatrix = CANONICAL_MACHINE_EVIDENCE_MATRIX.map(
    (entry) => ({ ...entry }),
  );
  const producerSteps = isRecord(machineProducerJob)
    ? machineProducerJob.steps
    : null;
  if (
    !isRecord(machineProducerJob) ||
    !hasExactKeys(machineProducerJob, [
      "name",
      "if",
      "needs",
      "permissions",
      "strategy",
      "runs-on",
      "steps",
    ]) ||
    machineProducerJob.name !==
      "release-machine-evidence / ${{ matrix.claimId }} / ${{ matrix.platform }}" ||
    machineProducerJob.if !== "startsWith(github.ref, 'refs/tags/v')" ||
    machineProducerJob["runs-on"] !== "${{ matrix.runner }}" ||
    JSON.stringify(machineProducerJob.needs) !==
      JSON.stringify([
        "desktop-mac",
        "desktop-windows",
        "desktop-linux",
        RELEASE_ARTIFACT_MATERIALS_JOB,
      ]) ||
    !hasExactKeys(machineProducerJob.permissions, ["contents", "actions"]) ||
    machineProducerJob.permissions.contents !== "read" ||
    machineProducerJob.permissions.actions !== "read" ||
    !isRecord(machineProducerJob.strategy) ||
    !hasExactKeys(machineProducerJob.strategy, ["fail-fast", "matrix"]) ||
    machineProducerJob.strategy["fail-fast"] !== false ||
    !isRecord(machineProducerJob.strategy.matrix) ||
    !hasExactKeys(machineProducerJob.strategy.matrix, ["include"]) ||
    JSON.stringify(machineProducerJob.strategy.matrix.include) !==
      JSON.stringify(expectedMachineMatrix) ||
    !Array.isArray(producerSteps) ||
    producerSteps.length !== 10 ||
    !isRecord(producerSteps[0]) ||
    !hasExactKeys(producerSteps[0], ["uses", "with"]) ||
    producerSteps[0].uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !hasExactKeys(producerSteps[0].with, ["persist-credentials"]) ||
    producerSteps[0].with["persist-credentials"] !== false ||
    !isRecord(producerSteps[1]) ||
    !hasExactKeys(producerSteps[1], ["uses", "with"]) ||
    producerSteps[1].uses !==
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" ||
    !hasExactKeys(producerSteps[1].with, ["path"]) ||
    producerSteps[1].with.path !== "artifacts" ||
    !isRecord(producerSteps[2]) ||
    !hasExactKeys(producerSteps[2], ["name", "if", "uses", "with"]) ||
    producerSteps[2].name !==
      "Download release artifact verification materials" ||
    producerSteps[2].if !==
      "matrix.claimId == 'release.artifact-verification'" ||
    producerSteps[2].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.downloadArtifact ||
    !hasExactKeys(producerSteps[2].with, ["name", "path"]) ||
    producerSteps[2].with.name !== RELEASE_ARTIFACT_MATERIALS_ARTIFACT ||
    producerSteps[2].with.path !== ARTIFACT_VERIFICATION_DIRECTORY ||
    !isRecord(producerSteps[3]) ||
    !hasExactKeys(producerSteps[3], ["name", "id", "if", "env", "run"]) ||
    producerSteps[3].name !== "Resolve packaged sample provenance" ||
    producerSteps[3].id !== "sample-provenance" ||
    producerSteps[3].if !==
      "matrix.claimId == 'sample.packaged-account-free'" ||
    !hasExactKeys(producerSteps[3].env, ["GITHUB_TOKEN"]) ||
    producerSteps[3].env.GITHUB_TOKEN !== "${{ github.token }}" ||
    producerSteps[3].run !==
      "node scripts/release-claims/verifiers/sample.packaged-account-free.mjs --discover --platform ${{ matrix.platform }} --descriptor .release-evidence/provenance/${{ matrix.reportName }}" ||
    !isRecord(producerSteps[4]) ||
    !hasExactKeys(producerSteps[4], ["name", "if", "env", "run"]) ||
    producerSteps[4].name !==
      "Run canonical packaged sample verifier without GitHub API token" ||
    producerSteps[4].if !==
      "matrix.claimId == 'sample.packaged-account-free'" ||
    !hasExactKeys(producerSteps[4].env, [
      "SKYTWIN_RELEASE_PROVENANCE_SHA256",
    ]) ||
    producerSteps[4].env.SKYTWIN_RELEASE_PROVENANCE_SHA256 !==
      "${{ steps.sample-provenance.outputs.descriptor_sha256 }}" ||
    producerSteps[4].run !==
      "node scripts/release-claims/verifiers/sample.packaged-account-free.mjs --verify --platform ${{ matrix.platform }} --descriptor .release-evidence/provenance/${{ matrix.reportName }} --output .release-evidence/reports/${{ matrix.reportName }}" ||
    !isRecord(producerSteps[5]) ||
    !hasExactKeys(producerSteps[5], ["name", "id", "if", "env", "run"]) ||
    producerSteps[5].name !== CANONICAL_MACHINE_VERIFIER_STEP ||
    producerSteps[5].id !== "machine-verifier" ||
    producerSteps[5].if !==
      "matrix.claimId != 'sample.packaged-account-free'" ||
    !hasExactKeys(producerSteps[5].env, [
      "GITHUB_TOKEN",
      "SKYTWIN_RELEASE_ARTIFACT_IDS",
      "SKYTWIN_RELEASE_ARTIFACT_DIGESTS",
      "SKYTWIN_LINUX_APPIMAGE_ARTIFACT_ID",
      "SKYTWIN_LINUX_APPIMAGE_ARTIFACT_DIGEST",
    ]) ||
    producerSteps[5].env.GITHUB_TOKEN !== "${{ github.token }}" ||
    producerSteps[5].env.SKYTWIN_RELEASE_ARTIFACT_IDS !==
      "${{ matrix.platform == 'macos' && format('SkyTwin-macOS-dmg={0},SkyTwin-macOS-zip={1}', needs.desktop-mac.outputs.dmg-artifact-id, needs.desktop-mac.outputs.zip-artifact-id) || matrix.platform == 'windows' && format('SkyTwin-Windows-installer={0}', needs.desktop-windows.outputs.installer-artifact-id) || matrix.platform == 'linux' && format('SkyTwin-Linux-AppImage={0},SkyTwin-Linux-deb={1},SkyTwin-Linux-rpm={2}', needs.desktop-linux.outputs.appimage-artifact-id, needs.desktop-linux.outputs.deb-artifact-id, needs.desktop-linux.outputs.rpm-artifact-id) || '' }}" ||
    producerSteps[5].env.SKYTWIN_RELEASE_ARTIFACT_DIGESTS !==
      "${{ matrix.platform == 'macos' && format('SkyTwin-macOS-dmg={0},SkyTwin-macOS-zip={1}', needs.desktop-mac.outputs.dmg-artifact-digest, needs.desktop-mac.outputs.zip-artifact-digest) || matrix.platform == 'windows' && format('SkyTwin-Windows-installer={0}', needs.desktop-windows.outputs.installer-artifact-digest) || matrix.platform == 'linux' && format('SkyTwin-Linux-AppImage={0},SkyTwin-Linux-deb={1},SkyTwin-Linux-rpm={2}', needs.desktop-linux.outputs.appimage-artifact-digest, needs.desktop-linux.outputs.deb-artifact-digest, needs.desktop-linux.outputs.rpm-artifact-digest) || '' }}" ||
    producerSteps[5].env.SKYTWIN_LINUX_APPIMAGE_ARTIFACT_ID !==
      "${{ needs.desktop-linux.outputs.appimage-artifact-id }}" ||
    producerSteps[5].env.SKYTWIN_LINUX_APPIMAGE_ARTIFACT_DIGEST !==
      "${{ needs.desktop-linux.outputs.appimage-artifact-digest }}" ||
    producerSteps[5].run !==
      "node scripts/release-claims/verifiers/${{ matrix.claimId }}.mjs --platform ${{ matrix.platform }} --output .release-evidence/reports/${{ matrix.reportName }}" ||
    !isRecord(producerSteps[6]) ||
    !hasExactKeys(producerSteps[6], ["name", "id", "uses", "with"]) ||
    producerSteps[6].name !== "Upload machine evidence report" ||
    producerSteps[6].id !== "upload-machine-evidence" ||
    producerSteps[6].uses !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    !hasExactKeys(producerSteps[6].with, [
      "name",
      "path",
      "if-no-files-found",
      "compression-level",
    ]) ||
    producerSteps[6].with.name !==
      "${{ matrix.claimId == 'release.signing' && format('release-signing-report-{0}-attempt-{1}', matrix.platform, github.run_attempt) || format('release-machine-evidence-{0}-{1}-attempt-{2}', matrix.claimId, matrix.platform, github.run_attempt) }}" ||
    producerSteps[6].with.path !==
      ".release-evidence/reports/${{ matrix.reportName }}" ||
    producerSteps[6].with["if-no-files-found"] !== "error" ||
    producerSteps[6].with["compression-level"] !== 0 ||
    !isRecord(producerSteps[7]) ||
    !hasExactKeys(producerSteps[7], ["name", "if", "uses", "with"]) ||
    producerSteps[7].name !== "Download exact uploaded signing report" ||
    producerSteps[7].if !== "matrix.claimId == 'release.signing'" ||
    producerSteps[7].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.downloadArtifact ||
    !hasExactKeys(producerSteps[7].with, [
      "artifact-ids",
      "path",
      "merge-multiple",
    ]) ||
    producerSteps[7].with["artifact-ids"] !==
      "${{ steps.upload-machine-evidence.outputs.artifact-id }}" ||
    producerSteps[7].with.path !== ".release-evidence/upload-confirmation" ||
    producerSteps[7].with["merge-multiple"] !== true ||
    !isRecord(producerSteps[8]) ||
    !hasExactKeys(producerSteps[8], ["name", "if", "env", "run"]) ||
    producerSteps[8].name !== "Verify exact uploaded signing report binding" ||
    producerSteps[8].if !== "matrix.claimId == 'release.signing'" ||
    !hasExactKeys(producerSteps[8].env, [
      "SKYTWIN_EXPECTED_REPORT_SHA256",
      "SKYTWIN_UPLOADED_ARTIFACT_ID",
      "SKYTWIN_UPLOADED_ARTIFACT_NAME",
      "SKYTWIN_UPLOADED_ARTIFACT_SHA256",
    ]) ||
    producerSteps[8].env.SKYTWIN_EXPECTED_REPORT_SHA256 !==
      "${{ steps.machine-verifier.outputs.report_sha256 }}" ||
    producerSteps[8].env.SKYTWIN_UPLOADED_ARTIFACT_ID !==
      "${{ steps.upload-machine-evidence.outputs.artifact-id }}" ||
    producerSteps[8].env.SKYTWIN_UPLOADED_ARTIFACT_NAME !==
      "release-signing-report-${{ matrix.platform }}-attempt-${{ github.run_attempt }}" ||
    producerSteps[8].env.SKYTWIN_UPLOADED_ARTIFACT_SHA256 !==
      "${{ steps.upload-machine-evidence.outputs.artifact-digest }}" ||
    producerSteps[8].run !==
      "node scripts/release-claims/verifiers/release.signing.mjs --verify-upload --platform ${{ matrix.platform }} --report .release-evidence/upload-confirmation/${{ matrix.reportName }} --binding .release-evidence/upload-bindings/${{ matrix.reportName }}.binding.json" ||
    !isRecord(producerSteps[9]) ||
    !hasExactKeys(producerSteps[9], ["name", "if", "uses", "with"]) ||
    producerSteps[9].name !== "Upload signing report source binding" ||
    producerSteps[9].if !== "matrix.claimId == 'release.signing'" ||
    producerSteps[9].uses !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    !hasExactKeys(producerSteps[9].with, [
      "name",
      "path",
      "if-no-files-found",
      "compression-level",
    ]) ||
    producerSteps[9].with.name !==
      "release-signing-binding-${{ matrix.platform }}-attempt-${{ github.run_attempt }}" ||
    producerSteps[9].with.path !==
      ".release-evidence/upload-bindings/${{ matrix.reportName }}.binding.json" ||
    producerSteps[9].with["if-no-files-found"] !== "error" ||
    producerSteps[9].with["compression-level"] !== 0
  )
    addError(
      errors,
      "machine evidence producers must use the exact native matrix, reviewed verifier command, and immutable per-report upload graph",
    );

  const aggregatorSteps = isRecord(evidenceAggregatorJob)
    ? evidenceAggregatorJob.steps
    : null;
  if (
    !isRecord(evidenceAggregatorJob) ||
    !hasExactKeys(evidenceAggregatorJob, [
      "name",
      "if",
      "needs",
      "runs-on",
      "steps",
    ]) ||
    evidenceAggregatorJob.name !== "Aggregate release machine evidence" ||
    evidenceAggregatorJob.if !== "startsWith(github.ref, 'refs/tags/v')" ||
    JSON.stringify(evidenceAggregatorJob.needs) !==
      JSON.stringify([
        "release-machine-evidence",
        RELEASE_ARTIFACT_MATERIALS_JOB,
      ]) ||
    evidenceAggregatorJob["runs-on"] !== "ubuntu-24.04" ||
    !Array.isArray(aggregatorSteps) ||
    aggregatorSteps.length !== 8 ||
    !isRecord(aggregatorSteps[0]) ||
    !hasExactKeys(aggregatorSteps[0], ["uses", "with"]) ||
    aggregatorSteps[0].uses !== PINNED_RELEASE_WORKFLOW_ACTIONS.checkout ||
    !hasExactKeys(aggregatorSteps[0].with, ["persist-credentials"]) ||
    aggregatorSteps[0].with["persist-credentials"] !== false ||
    !isRecord(aggregatorSteps[1]) ||
    !hasExactKeys(aggregatorSteps[1], ["name", "uses", "with"]) ||
    aggregatorSteps[1].name !==
      "Download signing report source bindings for this run attempt" ||
    aggregatorSteps[1].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.downloadArtifact ||
    !hasExactKeys(aggregatorSteps[1].with, [
      "pattern",
      "path",
      "merge-multiple",
    ]) ||
    aggregatorSteps[1].with.pattern !==
      "release-signing-binding-*-attempt-${{ github.run_attempt }}" ||
    aggregatorSteps[1].with.path !== ".release-evidence/upload-bindings" ||
    aggregatorSteps[1].with["merge-multiple"] !== true ||
    !isRecord(aggregatorSteps[2]) ||
    !hasExactKeys(aggregatorSteps[2], ["name", "id", "run"]) ||
    aggregatorSteps[2].name !==
      "Resolve exact source signing report artifact IDs" ||
    aggregatorSteps[2].id !== "signing-report-bindings" ||
    aggregatorSteps[2].run !==
      "node scripts/release-claims/verifiers/release.signing.mjs --resolve-upload-bindings --bindings .release-evidence/upload-bindings" ||
    !isRecord(aggregatorSteps[3]) ||
    !hasExactKeys(aggregatorSteps[3], ["name", "uses", "with"]) ||
    aggregatorSteps[3].name !== "Download exact source signing reports" ||
    aggregatorSteps[3].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.downloadArtifact ||
    !hasExactKeys(aggregatorSteps[3].with, [
      "artifact-ids",
      "path",
      "merge-multiple",
    ]) ||
    aggregatorSteps[3].with["artifact-ids"] !==
      "${{ steps.signing-report-bindings.outputs.artifact_ids }}" ||
    aggregatorSteps[3].with.path !== ".release-evidence/reports" ||
    aggregatorSteps[3].with["merge-multiple"] !== true ||
    !isRecord(aggregatorSteps[4]) ||
    !hasExactKeys(aggregatorSteps[4], ["name", "run"]) ||
    aggregatorSteps[4].name !==
      "Verify aggregated source signing report bindings" ||
    aggregatorSteps[4].run !==
      "node scripts/release-claims/verifiers/release.signing.mjs --verify-aggregated-uploads --bindings .release-evidence/upload-bindings --reports .release-evidence/reports" ||
    !isRecord(aggregatorSteps[5]) ||
    !hasExactKeys(aggregatorSteps[5], ["name", "uses", "with"]) ||
    aggregatorSteps[5].name !==
      "Download non-signing machine evidence reports for this run attempt" ||
    aggregatorSteps[5].uses !==
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" ||
    !hasExactKeys(aggregatorSteps[5].with, [
      "pattern",
      "path",
      "merge-multiple",
    ]) ||
    aggregatorSteps[5].with.pattern !==
      "release-machine-evidence-*-attempt-${{ github.run_attempt }}" ||
    aggregatorSteps[5].with.path !== ".release-evidence/reports" ||
    aggregatorSteps[5].with["merge-multiple"] !== true ||
    !isRecord(aggregatorSteps[6]) ||
    !hasExactKeys(aggregatorSteps[6], ["name", "uses", "with"]) ||
    aggregatorSteps[6].name !==
      "Download release artifact verification materials" ||
    aggregatorSteps[6].uses !==
      PINNED_RELEASE_WORKFLOW_ACTIONS.downloadArtifact ||
    !hasExactKeys(aggregatorSteps[6].with, ["name", "path"]) ||
    aggregatorSteps[6].with.name !== RELEASE_ARTIFACT_MATERIALS_ARTIFACT ||
    aggregatorSteps[6].with.path !== ARTIFACT_VERIFICATION_DIRECTORY ||
    !isRecord(aggregatorSteps[7]) ||
    !hasExactKeys(aggregatorSteps[7], ["name", "uses", "with"]) ||
    aggregatorSteps[7].name !== "Upload aggregated release evidence" ||
    aggregatorSteps[7].uses !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    !hasExactKeys(aggregatorSteps[7].with, [
      "name",
      "path",
      "if-no-files-found",
      "compression-level",
    ]) ||
    aggregatorSteps[7].with.name !== MACHINE_EVIDENCE_ARTIFACT_NAME ||
    aggregatorSteps[7].with.path !== ".release-evidence" ||
    aggregatorSteps[7].with["if-no-files-found"] !== "error" ||
    aggregatorSteps[7].with["compression-level"] !== 0
  )
    addError(
      errors,
      "machine evidence aggregation must be the exact producer-dependent immutable artifact graph",
    );

  const aggregateUploaders = Object.entries(
    canonicalWorkflow.jobs ?? {},
  ).flatMap(([jobName, job]) =>
    isRecord(job) && Array.isArray(job.steps)
      ? job.steps
          .filter(
            (step) =>
              isRecord(step) &&
              String(step.uses ?? "").startsWith("actions/upload-artifact@") &&
              step.with?.name === MACHINE_EVIDENCE_ARTIFACT_NAME,
          )
          .map(() => jobName)
      : [],
  );
  if (!sameStringSet(aggregateUploaders, ["aggregate-release-evidence"]))
    addError(
      errors,
      "only the verified aggregator may upload the release-evidence artifact",
    );
  const artifactMaterialUploaders = [];
  const attesters = [];
  const legacySbomProducers = [];
  for (const [path, workflow] of parsedWorkflows) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (!isRecord(job)) continue;
      for (const [stepIndex, step] of asArray(job.steps).entries()) {
        if (!isRecord(step) || typeof step.uses !== "string") continue;
        if (
          step.uses.startsWith("actions/upload-artifact@") &&
          step.with?.name === RELEASE_ARTIFACT_MATERIALS_ARTIFACT
        )
          artifactMaterialUploaders.push({ path, jobName, stepIndex });
        if (step.uses.startsWith("actions/attest@"))
          attesters.push({ path, jobName, stepIndex, uses: step.uses });
        if (
          step.uses.startsWith("anchore/sbom-action@") ||
          (step.uses.startsWith("actions/upload-artifact@") &&
            String(step.with?.name ?? "").startsWith("release-sbom-"))
        )
          legacySbomProducers.push({ path, jobName, stepIndex });
      }
    }
  }
  if (
    artifactMaterialUploaders.length !== 1 ||
    artifactMaterialUploaders[0]?.path !== workflowPath ||
    artifactMaterialUploaders[0]?.jobName !== RELEASE_ARTIFACT_MATERIALS_JOB ||
    artifactMaterialUploaders[0]?.stepIndex !== 15
  )
    addError(
      errors,
      "only the canonical release artifact materials job may upload the fixed materials artifact",
    );
  if (
    attesters.length !== 1 ||
    attesters[0]?.path !== workflowPath ||
    attesters[0]?.jobName !== RELEASE_ARTIFACT_MATERIALS_JOB ||
    attesters[0]?.stepIndex !== 13 ||
    attesters[0]?.uses !== PINNED_RELEASE_WORKFLOW_ACTIONS.attest
  )
    addError(
      errors,
      "only the canonical release artifact materials job may attest release subjects",
    );
  if (legacySbomProducers.length > 0)
    addError(
      errors,
      `legacy or duplicate release SBOM producers are prohibited: ${legacySbomProducers
        .map(
          ({ path, jobName, stepIndex }) =>
            `${relativePath(root, path)} jobs.${jobName}.steps[${stepIndex}]`,
        )
        .join(", ")}`,
    );
  const machineInputUploaders = [];
  const dynamicArtifactUploaders = [];
  const canonicalMachineReportUploadName =
    "${{ matrix.claimId == 'release.signing' && format('release-signing-report-{0}-attempt-{1}', matrix.platform, github.run_attempt) || format('release-machine-evidence-{0}-{1}-attempt-{2}', matrix.claimId, matrix.platform, github.run_attempt) }}";
  const canonicalSigningBindingUploadName =
    "release-signing-binding-${{ matrix.platform }}-attempt-${{ github.run_attempt }}";
  for (const [jobName, job] of Object.entries(canonicalWorkflow.jobs ?? {})) {
    if (!isRecord(job)) continue;
    for (const [stepIndex, step] of asArray(job.steps).entries()) {
      if (
        !isRecord(step) ||
        typeof step.uses !== "string" ||
        !step.uses.startsWith("actions/upload-artifact@")
      )
        continue;
      const artifactName = step.with?.name;
      const location = `jobs.${jobName}.steps[${stepIndex}]`;
      if (typeof artifactName !== "string") {
        dynamicArtifactUploaders.push(location);
        continue;
      }
      if (
        artifactName.includes("release-machine-evidence-") ||
        artifactName.includes("release-signing-report-") ||
        artifactName.includes("release-signing-binding-")
      )
        machineInputUploaders.push({ jobName, artifactName, location });
      if (
        artifactName.includes("${{") &&
        !(
          jobName === "release-machine-evidence" &&
          [
            canonicalMachineReportUploadName,
            canonicalSigningBindingUploadName,
          ].includes(artifactName)
        )
      )
        dynamicArtifactUploaders.push(location);
    }
  }
  if (
    machineInputUploaders.length !== 2 ||
    machineInputUploaders.some(
      ({ jobName }) => jobName !== "release-machine-evidence",
    ) ||
    !machineInputUploaders.some(
      ({ artifactName }) => artifactName === canonicalMachineReportUploadName,
    ) ||
    !machineInputUploaders.some(
      ({ artifactName }) => artifactName === canonicalSigningBindingUploadName,
    )
  )
    addError(
      errors,
      "only the canonical machine producer may upload attempt-bound machine reports and signing bindings",
    );
  if (dynamicArtifactUploaders.length > 0)
    addError(
      errors,
      `non-canonical artifact uploads must use static names: ${dynamicArtifactUploaders.join(", ")}`,
    );
  const actionIndexes = releaseSteps
    .map((step, index) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("softprops/action-gh-release@")
        ? index
        : -1,
    )
    .filter((index) => index !== -1);
  if (
    actionIndexes.length !== 1 ||
    publisherActions.length !== 1 ||
    publisherActions[0]?.path !== workflowPath ||
    publisherActions[0]?.jobName !== "release" ||
    publisherActions[0]?.stepIndex !== actionIndexes[0]
  ) {
    addError(
      errors,
      `release workflow must contain exactly one canonical GitHub release publisher; found ${actionIndexes.length}`,
    );
    return errors;
  }
  const actionIndex = actionIndexes[0];
  const actionStep = releaseSteps[actionIndex];
  const releaseActionReferences = releaseSteps
    .filter((step) => isRecord(step) && typeof step.uses === "string")
    .map((step) => step.uses);
  if (
    releaseActionReferences.length !== CANONICAL_RELEASE_JOB_ACTIONS.size ||
    new Set(releaseActionReferences).size !== releaseActionReferences.length ||
    releaseActionReferences.some(
      (reference) => !CANONICAL_RELEASE_JOB_ACTIONS.has(reference),
    )
  )
    addError(
      errors,
      "every action in the write-capable release job must match the canonical full-SHA allowlist",
    );
  if (actionStep.uses !== RELEASE_PUBLISHER_ACTION)
    addError(
      errors,
      `canonical GitHub release publisher must be pinned to ${RELEASE_PUBLISHER_ACTION}`,
    );
  const stepIndexByName = (name) => {
    const indexes = releaseSteps
      .map((step, index) => (isRecord(step) && step.name === name ? index : -1))
      .filter((index) => index !== -1);
    return indexes.length === 1 ? indexes[0] : -1;
  };
  const evidenceGateIndex = stepIndexByName(
    "Verify post-build release evidence",
  );
  const environmentGateIndex = stepIndexByName(
    "Verify protected release environment",
  );
  const absenceGateIndex = stepIndexByName("Refuse an existing release tag");
  const tagTargetGateIndex = stepIndexByName(
    "Verify release tag target and main ancestry",
  );
  const controlledPublishIndex = stepIndexByName(
    "Verify exact draft assets and publish",
  );
  if (
    environmentGateIndex === -1 ||
    absenceGateIndex !== environmentGateIndex + 1 ||
    tagTargetGateIndex !== absenceGateIndex + 1 ||
    actionIndex !== tagTargetGateIndex + 1
  )
    addError(
      errors,
      "existing releases and moved tags must be rejected immediately before draft creation",
    );
  if (
    evidenceGateIndex === -1 ||
    evidenceGateIndex >= environmentGateIndex ||
    !String(releaseSteps[evidenceGateIndex]?.run).includes(
      "--evidence-manifest .release-evidence/manifest.json",
    )
  )
    addError(
      errors,
      "post-build release evidence gate must execute before the canonical publisher",
    );
  const canonicalPublisherPath = resolve(
    root,
    "scripts/release-claims/publish-verified-draft.mjs",
  );
  const checkerPath = resolve(
    root,
    "scripts/release-claims/check-release-claims.mjs",
  );
  const alternatePublicationSource = publicationSources
    .filter(
      (path) =>
        path !== workflowPath &&
        path !== canonicalPublisherPath &&
        path !== checkerPath,
    )
    .map((path) => nonCommentContent(readFileSync(path, "utf8"), extname(path)))
    .join("\n");
  const workflowPublisherPatterns = [
    /\bgh\s+release\s+(?:create|upload|edit|delete)\b/i,
    /\bgh\s+api\b[^\n]*(?:\/releases(?:\/|\b)|releases\/assets)[^\n]*(?:--method|-X)\s*(?:POST|PATCH|PUT|DELETE)\b/i,
    /\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PATCH|PUT|DELETE)\b[^\n]*(?:api\.github\.com[^\n]*)?\/releases(?:\/|\b)/i,
    /uses:\s*actions\/(?:create-release|upload-release-asset)@/i,
    /electron-builder[^\n]*--publish\s+(?!never\b)/i,
  ];
  const scriptPublisherPatterns = [
    ...workflowPublisherPatterns,
    /octokit(?:\.rest)?\.repos\.(?:createRelease|updateRelease|deleteRelease|uploadReleaseAsset|deleteReleaseAsset)\s*\(/i,
    /(?:fetch|request)\s*\([^\n]*(?:\/releases(?:\/|\b)|releases\/assets)[\s\S]{0,500}?method\s*:\s*["'](?:POST|PATCH|PUT|DELETE)["']/i,
  ];
  const hasGenericReleaseApiMutation = (source) =>
    /(?:api\.github\.com|\/repos\/|repos\.)[^\n]{0,300}(?:\/releases(?:\/|\b)|releases\/assets)/i.test(
      source,
    ) &&
    /(?:\b(?:POST|PATCH|PUT|DELETE)\b|createRelease|updateRelease|deleteRelease|uploadReleaseAsset|deleteReleaseAsset)/i.test(
      source,
    );
  if (
    workflowPublisherPatterns.some((pattern) =>
      pattern.test(allPublicationSource),
    ) ||
    scriptPublisherPatterns.some((pattern) =>
      pattern.test(alternatePublicationSource),
    ) ||
    hasGenericReleaseApiMutation(alternatePublicationSource)
  )
    addError(
      errors,
      "release workflow contains an alternate publisher outside the canonical gated action",
    );
  const installCheckerIndex = stepIndexByName("Install release claim checker");
  const updateFeedStep = releaseSteps[0];
  const checkoutStep = releaseSteps[1];
  const setupNodeStep = releaseSteps[2];
  const downloadStep = releaseSteps[4];
  const listArtifactsStep = releaseSteps[6];
  if (
    releaseSteps.length !== 12 ||
    !hasExactKeys(updateFeedStep, ["name", "run"]) ||
    updateFeedStep.name !== "Verify update feed reachable" ||
    String(updateFeedStep.run).trim() !== CANONICAL_UPDATE_FEED_RUN ||
    !hasExactKeys(checkoutStep, ["uses", "with"]) ||
    checkoutStep.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !hasExactKeys(checkoutStep.with, ["persist-credentials"]) ||
    checkoutStep.with["persist-credentials"] !== false ||
    !hasExactKeys(setupNodeStep, ["uses", "with"]) ||
    setupNodeStep.uses !==
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38" ||
    !hasExactKeys(setupNodeStep.with, ["node-version"]) ||
    setupNodeStep.with["node-version"] !== "${{ env.NODE_VERSION }}" ||
    !hasExactKeys(downloadStep, ["name", "uses", "with"]) ||
    downloadStep.name !== "Download all artifacts" ||
    downloadStep.uses !==
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" ||
    !hasExactKeys(downloadStep.with, ["path"]) ||
    downloadStep.with.path !== "artifacts" ||
    !hasExactKeys(listArtifactsStep, ["name", "run"]) ||
    listArtifactsStep.name !== "List artifacts" ||
    listArtifactsStep.run !== "find artifacts -type f | sort" ||
    installCheckerIndex !== 3 ||
    evidenceGateIndex !== 5 ||
    environmentGateIndex !== 7 ||
    absenceGateIndex !== 8 ||
    tagTargetGateIndex !== 9 ||
    actionIndex !== 10 ||
    controlledPublishIndex !== 11
  )
    addError(
      errors,
      "canonical release job must contain only the exact allowlisted step graph in order",
    );
  if (
    !hasExactKeys(releaseJob, [
      "name",
      "if",
      "needs",
      "runs-on",
      "timeout-minutes",
      "environment",
      "concurrency",
      "permissions",
      "steps",
    ]) ||
    releaseJob.name !== "Create GitHub Release" ||
    releaseJob.if !== "startsWith(github.ref, 'refs/tags/v')" ||
    releaseJob["runs-on"] !== "ubuntu-latest" ||
    releaseJob["timeout-minutes"] !== 30 ||
    !Array.isArray(releaseJob.needs) ||
    releaseJob.needs.join("\n") !==
      [
        "test",
        "desktop-mac",
        "desktop-windows",
        "desktop-linux",
        "aggregate-release-evidence",
      ].join("\n")
  )
    addError(
      errors,
      "canonical release job identity and dependencies must be exact",
    );
  const hasExactEnvironment = (step, expected) =>
    isRecord(step) &&
    hasExactKeys(step.env, Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => step.env[key] === value);
  const assertExactRunStep = ({ index, name, run, env, error }) => {
    const step = releaseSteps[index];
    const allowedKeys = env ? ["name", "env", "run"] : ["name", "run"];
    if (
      index === -1 ||
      !isRecord(step) ||
      !hasExactKeys(step, allowedKeys) ||
      step.name !== name ||
      step.run !== run ||
      (env && !hasExactEnvironment(step, env))
    ) {
      addError(errors, error);
    }
  };
  const githubTokenEnvironment = {
    GITHUB_TOKEN: "${{ github.token }}",
  };
  const checkoutIndex = releaseSteps.findIndex(
    (step) =>
      isRecord(step) &&
      step.uses === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  );
  const setupNodeIndex = releaseSteps.findIndex(
    (step) =>
      isRecord(step) &&
      step.uses ===
        "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  );
  const downloadIndex = releaseSteps.findIndex(
    (step) =>
      isRecord(step) &&
      step.uses ===
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  );
  if (
    setupNodeIndex !== checkoutIndex + 1 ||
    installCheckerIndex !== setupNodeIndex + 1 ||
    downloadIndex !== installCheckerIndex + 1
  )
    addError(
      errors,
      "release claim checker installation and artifact download must follow pinned checkout and Node setup",
    );
  assertExactRunStep({
    index: installCheckerIndex,
    name: "Install release claim checker",
    run: "corepack pnpm@9.1.0 install --frozen-lockfile --ignore-scripts --filter skytwin",
    error:
      "release claim checker dependencies must use the exact locked install",
  });
  const evidenceStep = releaseSteps[evidenceGateIndex];
  const executableEvidenceRun =
    typeof evidenceStep?.run === "string"
      ? evidenceStep.run
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "" && !/^\s*#/.test(line))
          .join("\n")
          .trim()
      : "";
  if (
    evidenceGateIndex === -1 ||
    !isRecord(evidenceStep) ||
    !hasExactKeys(evidenceStep, ["name", "env", "run"]) ||
    !hasExactEnvironment(evidenceStep, githubTokenEnvironment) ||
    executableEvidenceRun !== CANONICAL_RELEASE_EVIDENCE_RUN
  )
    addError(
      errors,
      "post-build release evidence gate must execute with canonical fail-closed controls",
    );
  assertExactRunStep({
    index: environmentGateIndex,
    name: "Verify protected release environment",
    run: "node scripts/release-claims/verify-release-environment.mjs",
    env: githubTokenEnvironment,
    error:
      "release job must fail closed when the protected environment is absent or misconfigured",
  });
  assertExactRunStep({
    index: absenceGateIndex,
    name: "Refuse an existing release tag",
    run: "node scripts/release-claims/publish-verified-draft.mjs --assert-absent",
    env: githubTokenEnvironment,
    error:
      "existing releases and moved tags must be rejected immediately before draft creation",
  });
  assertExactRunStep({
    index: tagTargetGateIndex,
    name: "Verify release tag target and main ancestry",
    run: "node scripts/release-claims/publish-verified-draft.mjs --assert-tag-target",
    env: githubTokenEnvironment,
    error:
      "existing releases and moved tags must be rejected immediately before draft creation",
  });
  if (
    !hasExactKeys(actionStep, ["name", "id", "uses", "with"]) ||
    actionStep.name !== "Create release" ||
    actionStep.id !== "create-release-draft"
  )
    addError(
      errors,
      "canonical GitHub release publisher must not have conditional or overridden execution controls",
    );
  const actionWith = isRecord(actionStep.with) ? actionStep.with : undefined;
  if (
    !hasExactKeys(actionWith, [
      "draft",
      "prerelease",
      "target_commitish",
      "generate_release_notes",
      "fail_on_unmatched_files",
      "files",
    ])
  )
    addError(
      errors,
      "canonical GitHub release publisher settings must be exact",
    );
  const files = typeof actionWith?.files === "string" ? actionWith.files : "";
  if (files === "") {
    addError(
      errors,
      "canonical GitHub release publisher files block is missing",
    );
  }
  const patterns = files
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const patternSet = new Set(patterns);
  if (patternSet.size !== patterns.length)
    addError(
      errors,
      "canonical release publisher contains duplicate asset patterns",
    );
  for (const expected of CANONICAL_RELEASE_FILE_PATTERNS) {
    if (!patternSet.has(expected))
      addError(
        errors,
        `release publisher is missing canonical asset: ${expected}`,
      );
  }
  for (const actual of patternSet) {
    if (!CANONICAL_RELEASE_FILE_PATTERNS.has(actual))
      addError(errors, `release publisher has an unexpected asset: ${actual}`);
  }
  if (actionWith?.draft !== true)
    addError(errors, "canonical publisher must create an unpublished draft");
  if (actionWith?.prerelease !== true)
    addError(errors, "canonical publisher must mark the beta as a prerelease");
  if (actionWith?.fail_on_unmatched_files !== true)
    addError(
      errors,
      "canonical publisher must fail when an exact release asset path is missing",
    );
  if (
    actionWith?.target_commitish !== "${{ github.sha }}" ||
    actionWith?.generate_release_notes !== true
  )
    addError(
      errors,
      "canonical publisher must bind the draft to the current commit and generated notes",
    );
  if (releaseJob.environment !== "release-publication")
    addError(
      errors,
      "release job must use the protected release-publication environment",
    );
  if (
    canonicalWorkflow.defaults !== undefined ||
    releaseJob.defaults !== undefined
  )
    addError(
      errors,
      "release publication must not inherit custom run defaults",
    );
  if (
    !hasExactKeys(canonicalWorkflow.concurrency, [
      "group",
      "cancel-in-progress",
    ]) ||
    canonicalWorkflow.concurrency.group !== "build-${{ github.ref }}" ||
    canonicalWorkflow.concurrency["cancel-in-progress"] !==
      "${{ !startsWith(github.ref, 'refs/tags/v') }}"
  )
    addError(errors, "tag publication workflows must not be cancelled");
  if (
    !hasExactKeys(releaseJob.concurrency, ["group", "cancel-in-progress"]) ||
    releaseJob.concurrency.group !== "release-publication-${{ github.ref }}" ||
    releaseJob.concurrency["cancel-in-progress"] !== false
  )
    addError(errors, "release publication must serialize without cancellation");
  if (
    !hasExactKeys(releaseJob.permissions, [
      "contents",
      "actions",
      "attestations",
    ]) ||
    releaseJob.permissions.contents !== "write" ||
    releaseJob.permissions.actions !== "read" ||
    releaseJob.permissions.attestations !== "read"
  )
    addError(
      errors,
      "release job permissions must be limited to contents:write, actions:read, and attestations:read",
    );
  const controlledPublishCommand =
    "node scripts/release-claims/publish-verified-draft.mjs .release-evidence/manifest.json";
  if (
    controlledPublishIndex !== actionIndex + 1 ||
    releaseSteps[controlledPublishIndex]?.run !== controlledPublishCommand
  )
    addError(
      errors,
      "controlled draft verification and publication must be the immediate step after draft creation",
    );
  assertExactRunStep({
    index: controlledPublishIndex,
    name: "Verify exact draft assets and publish",
    run: controlledPublishCommand,
    env: {
      GITHUB_TOKEN: "${{ github.token }}",
      RELEASE_ID: "${{ steps.create-release-draft.outputs.id }}",
    },
    error:
      "controlled draft verification and publication must use canonical fail-closed controls",
  });
  const controlledPublishStep = releaseSteps[controlledPublishIndex];
  if (
    !isRecord(controlledPublishStep) ||
    controlledPublishStep.env?.RELEASE_ID !==
      "${{ steps.create-release-draft.outputs.id }}"
  )
    addError(
      errors,
      "controlled publisher must consume the exact draft release ID",
    );
  return errors;
}

export function validateLedgerShape(
  ledger,
  root,
  ledgerPath = DEFAULT_LEDGER_PATH,
) {
  root = realpathSync(resolve(root));
  const errors = [];
  const absoluteLedgerPath = resolve(root, ledgerPath);
  if (ledger?.schemaVersion !== 1) {
    addError(errors, "schemaVersion must be 1");
  }

  const release = ledger?.release;
  if (!release || typeof release !== "object") {
    addError(errors, "release contract is required");
  } else {
    if (
      normalizeReleaseTagToRepositoryVersion(release.targetVersion) === null
    ) {
      addError(
        errors,
        "release.targetVersion must be a canonical four-segment tag or beta tag with no leading/oversized segments",
      );
    }
    if (!["blocked", "candidate", "ready"].includes(release.status)) {
      addError(errors, "release.status must be blocked, candidate, or ready");
    }
    if (!isNonEmptyString(release.audience))
      addError(errors, "release.audience is required");
    if (!isNonEmptyString(release.releaseSurface))
      addError(errors, "release.releaseSurface is required");
    if (
      release.auditBaseline?.ref !== CANONICAL_AUDIT_BASELINE.ref ||
      release.auditBaseline?.commit !== CANONICAL_AUDIT_BASELINE.commit ||
      release.auditBaseline?.auditedOn !== CANONICAL_AUDIT_BASELINE.auditedOn
    ) {
      addError(
        errors,
        "release.auditBaseline must retain the audited origin/main commit and date",
      );
    }
    if (!Array.isArray(release.platforms) || release.platforms.length === 0) {
      addError(
        errors,
        "release.platforms must record at least one candidate or deferred platform",
      );
    } else {
      for (const [index, platform] of release.platforms.entries()) {
        const prefix = `release.platforms[${index}]`;
        if (!isNonEmptyString(platform?.name))
          addError(errors, `${prefix}.name is required`);
        if (
          !["candidate", "supported", "deferred", "excluded"].includes(
            platform?.state,
          )
        ) {
          addError(
            errors,
            `${prefix}.state must be candidate, supported, deferred, or excluded`,
          );
        }
        if (!isNonEmptyString(platform?.minimumHardware)) {
          addError(
            errors,
            `${prefix}.minimumHardware must state the requirement or say it is unverified`,
          );
        }
        if (!isNonEmptyString(platform?.evidence))
          addError(errors, `${prefix}.evidence is required`);
      }
    }
    if (
      !Array.isArray(release.deferredFeatures) ||
      release.deferredFeatures.length === 0
    ) {
      addError(errors, "release.deferredFeatures must be non-empty");
    } else if (
      release.deferredFeatures.some((feature) => !isNonEmptyString(feature))
    ) {
      addError(
        errors,
        "release.deferredFeatures entries must be non-empty strings",
      );
    }
    if (
      !Array.isArray(release.stopShipConditions) ||
      release.stopShipConditions.length === 0
    ) {
      addError(errors, "release.stopShipConditions must be non-empty");
    } else {
      const stopShipIds = new Set();
      for (const [index, condition] of release.stopShipConditions.entries()) {
        const prefix = `release.stopShipConditions[${index}]`;
        if (!isNonEmptyString(condition?.id))
          addError(errors, `${prefix}.id is required`);
        else if (stopShipIds.has(condition.id))
          addError(errors, `duplicate stop-ship condition id: ${condition.id}`);
        else stopShipIds.add(condition.id);
        if (!["open", "met"].includes(condition?.status))
          addError(errors, `${prefix}.status must be open or met`);
        if (!isNonEmptyString(condition?.owner))
          addError(errors, `${prefix}.owner is required`);
        if (!isNonEmptyString(condition?.condition))
          addError(errors, `${prefix}.condition is required`);
        const canonical = CANONICAL_STOP_SHIP_CONDITIONS.get(condition?.id);
        if (
          canonical &&
          (condition.owner !== canonical.owner ||
            condition.condition !== canonical.condition)
        ) {
          addError(
            errors,
            `${prefix} owner/condition differs from the audited canonical stop-ship baseline`,
          );
        }
        // No stop-ship condition has immutable resolution evidence yet. A
        // source edit cannot convert an open blocker into a self-attested met
        // record; advancing this baseline requires adding and verifying the
        // external issue/artifact proof contract first.
        if (canonical && condition.status !== "open") {
          addError(
            errors,
            `${prefix} must remain open until immutable resolution evidence is implemented`,
          );
        }
      }
      for (const requiredId of REQUIRED_STOP_SHIP_IDS) {
        if (!stopShipIds.has(requiredId))
          addError(
            errors,
            `required stop-ship condition is missing: ${requiredId}`,
          );
      }
      for (const id of stopShipIds) {
        if (!REQUIRED_STOP_SHIP_IDS.has(id))
          addError(errors, `unexpected stop-ship condition id: ${id}`);
      }
      const openConditions = release.stopShipConditions.filter(
        (condition) => condition?.status !== "met",
      );
      if (release.status === "ready" && openConditions.length > 0) {
        addError(
          errors,
          `release cannot be ready with ${openConditions.length} unmet stop-ship condition(s)`,
        );
      }
    }
  }

  const claims = asArray(ledger?.claims);
  if (claims.length === 0) addError(errors, "claims must be non-empty");
  const ids = new Set();
  const categories = new Set();
  for (const [index, claim] of claims.entries()) {
    const prefix = `claims[${index}]`;
    if (!isNonEmptyString(claim?.id))
      addError(errors, `${prefix}.id is required`);
    if (ids.has(claim?.id)) addError(errors, `duplicate claim id: ${claim.id}`);
    ids.add(claim?.id);
    if (!isNonEmptyString(claim?.category))
      addError(errors, `${prefix}.category is required`);
    categories.add(claim?.category);
    if (!isNonEmptyString(claim?.statement))
      addError(errors, `${prefix}.statement is required`);
    if (!isNonEmptyString(claim?.scope))
      addError(errors, `${prefix}.scope is required`);
    if (!isNonEmptyString(claim?.owner))
      addError(errors, `${prefix}.owner is required`);
    if (!CLAIM_STATES.has(claim?.state)) {
      addError(
        errors,
        `${prefix}.state must be proven, limited, deferred, or prohibited`,
      );
    }
    if (!Array.isArray(claim?.evidence) || claim.evidence.length === 0) {
      addError(errors, `${prefix}.evidence must be non-empty`);
    }
    if (
      !Array.isArray(claim?.verification) ||
      claim.verification.length === 0
    ) {
      addError(
        errors,
        `${prefix}.verification must include an exact command or test`,
      );
    } else {
      for (const [
        verificationIndex,
        verification,
      ] of claim.verification.entries()) {
        if (
          !isNonEmptyString(verification?.command) ||
          !isNonEmptyString(verification?.expected)
        ) {
          addError(
            errors,
            `${prefix}.verification[${verificationIndex}] needs command and expected`,
          );
        } else if (!isAllowlistedVerificationCommand(verification.command)) {
          addError(
            errors,
            `${prefix}.verification[${verificationIndex}].command is not an allowlisted, shell-safe pnpm/rg command`,
          );
        }
      }
    }
    if (claim?.state !== "proven" && !isNonEmptyString(claim?.limitation)) {
      addError(
        errors,
        `${prefix}.limitation is required for ${claim?.state ?? "unknown"} claims`,
      );
    }

    for (const [evidenceIndex, evidence] of asArray(
      claim?.evidence,
    ).entries()) {
      const evidencePrefix = `${prefix}.evidence[${evidenceIndex}]`;
      if (!isNonEmptyString(evidence?.why)) {
        addError(errors, `${evidencePrefix}.why is required`);
      }

      const evidenceKind = evidence?.kind ?? (evidence?.path ? "source" : null);
      if (!["source", "ci", "machine"].includes(evidenceKind)) {
        addError(
          errors,
          `${evidencePrefix}.kind must be source, ci, or machine`,
        );
        continue;
      }

      if (evidenceKind === "ci" || evidenceKind === "machine") {
        addError(
          errors,
          `${evidencePrefix} ${evidenceKind} evidence must live in the post-build release evidence manifest, not the source ledger`,
        );
        continue;
      }

      if (!isNonEmptyString(evidence?.path)) {
        addError(
          errors,
          `${evidencePrefix}.path is required for source evidence`,
        );
        continue;
      }
      const unresolvedEvidencePath = resolve(root, evidence.path);
      if (!isInsideRoot(root, unresolvedEvidencePath)) {
        addError(
          errors,
          `${claim.id}: evidence path escapes repository root: ${evidence.path}`,
        );
        continue;
      }
      if (unresolvedEvidencePath === absoluteLedgerPath) {
        addError(
          errors,
          `${claim.id}: the claim ledger cannot serve as its own evidence: ${evidence.path}`,
        );
        continue;
      }
      if (!existsSync(unresolvedEvidencePath)) {
        addError(
          errors,
          `${claim.id}: evidence path does not exist: ${evidence.path}`,
        );
        continue;
      }
      const evidencePath = resolveContainedRegularFile(root, evidence.path);
      if (!evidencePath) {
        addError(
          errors,
          `${claim.id}: evidence path must be a real, regular, non-symlink repository file: ${evidence.path}`,
        );
        continue;
      }
      if (!SOURCE_DIGEST.test(evidence.sha256 ?? "")) {
        addError(
          errors,
          `${evidencePrefix}.sha256 must be a lowercase SHA-256 digest for source evidence`,
        );
        continue;
      }
      const actual = sha256(readFileSync(evidencePath));
      if (actual !== evidence.sha256) {
        addError(
          errors,
          `${claim.id}: evidence changed: ${evidence.path} (expected ${evidence.sha256}, got ${actual}); re-audit this claim and update the ledger`,
        );
      }
    }
  }

  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category))
      addError(errors, `required claim category is missing: ${category}`);
  }
  for (const [id, category] of CANONICAL_CLAIM_CATEGORIES) {
    const claim = claims.find((candidate) => candidate?.id === id);
    if (!claim) {
      addError(errors, `required canonical claim is missing: ${id}`);
    } else if (claim.category !== category) {
      addError(
        errors,
        `canonical claim ${id} must remain in category ${category}`,
      );
    } else if (
      CANONICAL_READINESS_CLAIM_DIGESTS.has(id) &&
      sha256(`${claim.statement}\0${claim.scope}\0${claim.owner}`) !==
        CANONICAL_READINESS_CLAIM_DIGESTS.get(id)
    ) {
      addError(errors, `canonical readiness claim meaning changed: ${id}`);
    }
  }
  for (const id of ids) {
    if (!CANONICAL_CLAIM_CATEGORIES.has(id))
      addError(errors, `unexpected canonical claim id: ${id}`);
  }
  const licenseClaim = claims.find((claim) => claim?.id === "license.apache-2");
  if (
    licenseClaim &&
    (licenseClaim.state !== "proven" ||
      licenseClaim.statement !==
        "The repository source is available under Apache License 2.0." ||
      !asArray(licenseClaim.evidence).some(
        (evidence) => evidence?.path === "LICENSE",
      ))
  ) {
    addError(
      errors,
      "license.apache-2 must remain a proven Apache-2.0 source claim backed by LICENSE",
    );
  }

  const readinessClaims = asArray(release?.readinessClaims);
  if (readinessClaims.length === 0) {
    addError(
      errors,
      "release.readinessClaims must identify claims and accepted states required for publication",
    );
  }
  const readinessIds = new Set();
  for (const [index, readiness] of readinessClaims.entries()) {
    const prefix = `release.readinessClaims[${index}]`;
    if (!isNonEmptyString(readiness?.claimId)) {
      addError(errors, `${prefix}.claimId is required`);
      continue;
    }
    if (readinessIds.has(readiness.claimId)) {
      addError(errors, `duplicate readiness claim id: ${readiness.claimId}`);
    }
    readinessIds.add(readiness.claimId);
    if (!ids.has(readiness.claimId))
      addError(
        errors,
        `release.readinessClaims references unknown claim: ${readiness.claimId}`,
      );
    if (typeof readiness.critical !== "boolean")
      addError(errors, `${prefix}.critical must be a boolean`);
    if (
      !Array.isArray(readiness.acceptedStates) ||
      readiness.acceptedStates.length === 0
    ) {
      addError(errors, `${prefix}.acceptedStates must be non-empty`);
      continue;
    }
    const acceptedStates = new Set(readiness.acceptedStates);
    if (acceptedStates.size !== readiness.acceptedStates.length)
      addError(errors, `${prefix}.acceptedStates must be unique`);
    for (const state of acceptedStates) {
      if (!READY_ACCEPTED_STATES.has(state)) {
        addError(
          errors,
          `${prefix}.acceptedStates may contain only proven or limited`,
        );
      }
    }
    if (
      readiness.critical === true &&
      (acceptedStates.size !== 1 || !acceptedStates.has("proven"))
    ) {
      addError(
        errors,
        `${prefix} is critical and must accept only the proven state`,
      );
    }
    if (
      !Array.isArray(readiness.requiredEvidenceKinds) ||
      readiness.requiredEvidenceKinds.length === 0
    ) {
      addError(errors, `${prefix}.requiredEvidenceKinds must be non-empty`);
    } else {
      const requiredEvidenceKinds = new Set(readiness.requiredEvidenceKinds);
      if (requiredEvidenceKinds.size !== readiness.requiredEvidenceKinds.length)
        addError(errors, `${prefix}.requiredEvidenceKinds must be unique`);
      for (const kind of requiredEvidenceKinds) {
        if (!["source", "ci", "machine"].includes(kind))
          addError(
            errors,
            `${prefix}.requiredEvidenceKinds contains unsupported kind: ${kind}`,
          );
      }
      if (
        readiness.critical === true &&
        !requiredEvidenceKinds.has("ci") &&
        !requiredEvidenceKinds.has("machine")
      ) {
        addError(
          errors,
          `${prefix} is critical and must require immutable ci or machine evidence`,
        );
      }
    }
  }
  for (const requiredId of REQUIRED_READINESS_CLAIM_IDS) {
    if (!readinessIds.has(requiredId))
      addError(errors, `required readiness claim is missing: ${requiredId}`);
  }
  for (const id of readinessIds) {
    if (!REQUIRED_READINESS_CLAIM_IDS.has(id))
      addError(errors, `unexpected readiness claim id: ${id}`);
  }
  for (const [claimId, canonicalKinds] of CANONICAL_READINESS_EVIDENCE_KINDS) {
    const readiness = readinessClaims.find(
      (candidate) => candidate?.claimId === claimId,
    );
    if (!readiness) continue;
    const actualKinds = asArray(readiness.requiredEvidenceKinds);
    if (
      readiness.critical !== true ||
      asArray(readiness.acceptedStates).length !== 1 ||
      readiness.acceptedStates[0] !== "proven" ||
      actualKinds.length !== canonicalKinds.length ||
      canonicalKinds.some((kind) => !actualKinds.includes(kind))
    ) {
      addError(
        errors,
        `readiness contract changed for ${claimId}; critical=true, acceptedStates=[proven], and requiredEvidenceKinds=[${canonicalKinds.join(", ")}] are mandatory`,
      );
    }
    if (
      claimId === "sample.packaged-account-free" &&
      !sameStringSet(readiness.requiredPlatforms, [
        ...SAMPLE_EVIDENCE_PLATFORMS,
      ])
    ) {
      addError(
        errors,
        "sample.packaged-account-free readiness requires exactly macos, windows, and linux machine evidence",
      );
    }
  }
  if (release?.status === "ready") {
    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    for (const readiness of readinessClaims) {
      const claim = claimById.get(readiness?.claimId);
      const state = claim?.state;
      if (!asArray(readiness?.acceptedStates).includes(state)) {
        addError(
          errors,
          `release cannot be ready while claim ${readiness?.claimId ?? "(missing)"} is ${state ?? "missing"}; accepted states: ${asArray(readiness?.acceptedStates).join(", ") || "none"}`,
        );
      }
      const evidenceKinds = new Set(
        asArray(claim?.evidence).map(
          (evidence) => evidence?.kind ?? (evidence?.path ? "source" : null),
        ),
      );
      for (const kind of asArray(readiness?.requiredEvidenceKinds)) {
        if (kind !== "source") continue;
        if (!evidenceKinds.has(kind)) {
          addError(
            errors,
            `release cannot be ready while claim ${readiness?.claimId ?? "(missing)"} lacks required ${kind} evidence`,
          );
        }
      }
    }
    if (
      !asArray(release.platforms).some(
        (platform) => platform.state === "supported",
      )
    ) {
      addError(
        errors,
        "release cannot be ready without at least one supported platform",
      );
    }
  } else if (
    asArray(release?.platforms).some(
      (platform) => platform.state === "supported",
    )
  ) {
    addError(
      errors,
      "a blocked or candidate release cannot label a platform supported",
    );
  }

  if (
    !Array.isArray(ledger?.claimSurfaces) ||
    ledger.claimSurfaces.length === 0
  ) {
    addError(errors, "claimSurfaces must be non-empty");
  } else {
    const surfaceClasses = new Set();
    for (const [index, surface] of ledger.claimSurfaces.entries()) {
      if (!isNonEmptyString(surface?.path))
        addError(errors, `claimSurfaces[${index}].path is required`);
      const hasStartMarker = surface?.startMarker !== undefined;
      const hasEndMarker = surface?.endMarker !== undefined;
      if (hasStartMarker || hasEndMarker) {
        addError(
          errors,
          `claimSurfaces[${index}] may not use marker slices; the complete file must be scanned`,
        );
      }
      if (!REQUIRED_SURFACE_CLASSES.has(surface?.class)) {
        addError(
          errors,
          `claimSurfaces[${index}].class must be one of: ${[...REQUIRED_SURFACE_CLASSES].join(", ")}`,
        );
      } else {
        surfaceClasses.add(surface.class);
      }
    }
    for (const requiredClass of REQUIRED_SURFACE_CLASSES) {
      if (!surfaceClasses.has(requiredClass)) {
        addError(
          errors,
          `required claim surface class is missing: ${requiredClass}`,
        );
      }
    }
  }
  if (
    !Array.isArray(ledger?.prohibitedClaims) ||
    ledger.prohibitedClaims.length === 0
  ) {
    addError(errors, "prohibitedClaims must be non-empty");
  } else {
    const prohibitedIds = new Set();
    for (const [index, rule] of ledger.prohibitedClaims.entries()) {
      if (!isNonEmptyString(rule?.id))
        addError(errors, `prohibitedClaims[${index}].id is required`);
      else if (prohibitedIds.has(rule.id))
        addError(errors, `duplicate prohibited claim id: ${rule.id}`);
      else prohibitedIds.add(rule.id);
      if (!isNonEmptyString(rule?.pattern))
        addError(errors, `prohibitedClaims[${index}].pattern is required`);
      if (!isNonEmptyString(rule?.reason))
        addError(errors, `prohibitedClaims[${index}].reason is required`);
      const expectedDigest = CANONICAL_PROHIBITED_RULE_DIGESTS.get(rule?.id);
      if (!expectedDigest) {
        if (isNonEmptyString(rule?.id))
          addError(
            errors,
            `unexpected canonical prohibited claim id: ${rule.id}`,
          );
      } else if (
        sha256(`${rule.pattern}\0${rule.flags ?? "i"}`) !== expectedDigest
      ) {
        addError(errors, `canonical prohibited claim rule changed: ${rule.id}`);
      }
    }
    for (const id of CANONICAL_PROHIBITED_RULE_DIGESTS.keys()) {
      if (!prohibitedIds.has(id))
        addError(
          errors,
          `required canonical prohibited claim is missing: ${id}`,
        );
    }
  }
  if (
    !Array.isArray(ledger?.approvedStatements) ||
    ledger.approvedStatements.length === 0
  ) {
    addError(errors, "approvedStatements must be non-empty");
  } else {
    const approvedIds = new Set();
    for (const [index, statement] of ledger.approvedStatements.entries()) {
      if (!isNonEmptyString(statement?.id))
        addError(errors, `approvedStatements[${index}].id is required`);
      else if (approvedIds.has(statement.id))
        addError(errors, `duplicate approved statement id: ${statement.id}`);
      else approvedIds.add(statement.id);
      const expectedDigest = CANONICAL_APPROVED_STATEMENT_DIGESTS.get(
        statement?.id,
      );
      if (!expectedDigest) {
        if (isNonEmptyString(statement?.id))
          addError(
            errors,
            `unexpected canonical approved statement id: ${statement.id}`,
          );
      } else if (
        sha256(`${statement.path}\0${statement.exact}`) !== expectedDigest
      ) {
        addError(
          errors,
          `canonical approved statement changed: ${statement.id}`,
        );
      }
    }
    for (const id of CANONICAL_APPROVED_STATEMENT_DIGESTS.keys()) {
      if (!approvedIds.has(id))
        addError(
          errors,
          `required canonical approved statement is missing: ${id}`,
        );
    }
  }

  const staleAssetIds = new Set();
  const staleAssetPaths = new Set();
  for (const [index, asset] of asArray(ledger?.staleAssets).entries()) {
    const prefix = `staleAssets[${index}]`;
    if (!isNonEmptyString(asset?.id))
      addError(errors, `${prefix}.id is required`);
    else if (staleAssetIds.has(asset.id))
      addError(errors, `duplicate stale asset id: ${asset.id}`);
    else staleAssetIds.add(asset.id);
    if (asset?.state !== "prohibited")
      addError(errors, `${prefix}.state must be prohibited`);
    if (!isNonEmptyString(asset?.reason))
      addError(errors, `${prefix}.reason is required`);
    if (!isNonEmptyString(asset?.path)) {
      addError(errors, `${prefix}.path is required`);
      continue;
    }
    if (staleAssetPaths.has(asset.path))
      addError(errors, `duplicate stale asset path: ${asset.path}`);
    staleAssetPaths.add(asset.path);
    const assetPath = resolveContainedRegularFile(root, asset.path);
    if (!assetPath) {
      addError(
        errors,
        `${prefix}.path must identify a real, regular, non-symlink repository file`,
      );
      continue;
    }
    if (!SOURCE_DIGEST.test(asset.sha256 ?? "")) {
      addError(errors, `${prefix}.sha256 must be a lowercase SHA-256 digest`);
      continue;
    }
    const actual = sha256(readFileSync(assetPath));
    if (actual !== asset.sha256)
      addError(
        errors,
        `${asset.id}: stale asset changed: ${asset.path}; re-audit or replace it`,
      );
  }

  for (const [id, path] of CANONICAL_STALE_ASSETS) {
    const asset = asArray(ledger?.staleAssets).find(
      (candidate) => candidate?.id === id,
    );
    if (!asset)
      addError(errors, `required canonical stale asset is missing: ${id}`);
    else if (asset.path !== path)
      addError(errors, `canonical stale asset ${id} must remain at ${path}`);
  }
  for (const id of staleAssetIds) {
    if (!CANONICAL_STALE_ASSETS.has(id))
      addError(errors, `unexpected canonical stale asset id: ${id}`);
  }

  const binaryEntries = asArray(ledger?.publicBinaryAssets);
  if (
    ledger?.binaryAssetAudit?.reviewedOn !== "2026-09-10" ||
    ledger?.binaryAssetAudit?.method !==
      "Tesseract OCR plus human inspection at each recorded SHA-256; any byte change requires a new review" ||
    !isNonEmptyString(ledger?.binaryAssetAudit?.scope)
  ) {
    addError(
      errors,
      "binaryAssetAudit must retain the dated OCR/human-review method and scope",
    );
  }
  const binaryPaths = new Set();
  for (const [index, asset] of binaryEntries.entries()) {
    const prefix = `publicBinaryAssets[${index}]`;
    if (!isNonEmptyString(asset?.path)) {
      addError(errors, `${prefix}.path is required`);
      continue;
    }
    if (binaryPaths.has(asset.path))
      addError(errors, `duplicate public binary asset path: ${asset.path}`);
    binaryPaths.add(asset.path);
    const expectedDisposition = CANONICAL_PUBLIC_BINARY_ASSETS.get(asset.path);
    if (!expectedDisposition)
      addError(errors, `unexpected public binary asset: ${asset.path}`);
    else if (asset.ocrDisposition !== expectedDisposition)
      addError(
        errors,
        `${prefix}.ocrDisposition must be ${expectedDisposition}`,
      );
    const path = resolveContainedRegularFile(root, asset.path);
    if (!path) {
      addError(
        errors,
        `${prefix}.path must identify a real, regular, non-symlink repository file`,
      );
      continue;
    }
    if (!SOURCE_DIGEST.test(asset.sha256 ?? "")) {
      addError(errors, `${prefix}.sha256 must be a lowercase SHA-256 digest`);
    } else if (
      asset.sha256 !== CANONICAL_PUBLIC_BINARY_DIGESTS.get(asset.path)
    ) {
      addError(
        errors,
        `${asset.path}: public binary asset digest differs from the audited OCR baseline`,
      );
    } else if (sha256(readFileSync(path)) !== asset.sha256) {
      addError(
        errors,
        `${asset.path}: public binary asset changed; re-run OCR/human review and update its digest`,
      );
    }
    if (
      expectedDisposition === "prohibited-stale" &&
      !staleAssetPaths.has(asset.path)
    ) {
      addError(
        errors,
        `${asset.path}: prohibited binary asset must also appear in staleAssets`,
      );
    }
  }
  const discoveredBinaryPaths = collectPublicBinaryAssetPaths(root, errors);
  for (const path of discoveredBinaryPaths) {
    if (!binaryPaths.has(path))
      addError(
        errors,
        `public binary asset is missing from inventory: ${path}`,
      );
  }
  for (const [path] of CANONICAL_PUBLIC_BINARY_ASSETS) {
    if (!binaryPaths.has(path))
      addError(
        errors,
        `required canonical public binary asset is missing: ${path}`,
      );
  }

  return errors;
}

function readVersionSourceValues(ledger, root, errors) {
  root = realpathSync(resolve(root));
  const sources = asArray(ledger?.release?.currentVersionSources);
  if (sources.length < 2) {
    addError(
      errors,
      "release.currentVersionSources must contain at least two synchronized sources",
    );
    return [];
  }

  const values = [];
  const requiredSources = new Map([
    ["VERSION", "text"],
    ["package.json", "package-json"],
  ]);
  const seenSources = new Set();
  for (const source of sources) {
    const absolute = resolve(root, source.path ?? "");
    if (!isInsideRoot(root, absolute)) {
      addError(
        errors,
        `version source escapes repository root: ${source.path ?? "(missing path)"}`,
      );
      continue;
    }
    if (seenSources.has(source.path)) {
      addError(errors, `duplicate version source: ${source.path}`);
      continue;
    }
    seenSources.add(source.path);
    if (!existsSync(absolute)) {
      addError(
        errors,
        `version source does not exist: ${source.path ?? "(missing path)"}`,
      );
      continue;
    }
    const sourcePath = resolveContainedRegularFile(root, source.path);
    if (!sourcePath) {
      addError(
        errors,
        `version source must be a real, regular, non-symlink repository file: ${source.path}`,
      );
      continue;
    }
    let value;
    if (source.kind === "text") {
      value = readFileSync(sourcePath, "utf8").trim();
    } else if (source.kind === "package-json") {
      try {
        value = JSON.parse(readFileSync(sourcePath, "utf8")).version;
      } catch (error) {
        addError(
          errors,
          `invalid package-json version source ${source.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    } else {
      addError(
        errors,
        `unsupported version source kind: ${source.kind ?? "(missing)"}`,
      );
      continue;
    }
    if (!isNonEmptyString(value))
      addError(errors, `empty version value in ${source.path}`);
    values.push({ path: source.path, value });
  }
  for (const [path, kind] of requiredSources) {
    const source = sources.find((candidate) => candidate?.path === path);
    if (!source || source.kind !== kind) {
      addError(
        errors,
        `release.currentVersionSources must include ${path} with kind ${kind}`,
      );
    }
  }
  return values;
}

export function verifyVersionSources(ledger, root) {
  const errors = [];
  const values = readVersionSourceValues(ledger, root, errors);

  const distinct = new Set(values.map(({ value }) => value));
  if (distinct.size > 1) {
    addError(
      errors,
      `release version sources disagree: ${values.map(({ path, value }) => `${path}=${value}`).join(", ")}`,
    );
  } else if (distinct.size === 1) {
    const [version] = distinct;
    if (!FOUR_SEGMENT_VERSION.test(version)) {
      addError(
        errors,
        `repository release version must be four numeric segments with no leading/oversized segments: ${version}`,
      );
    }
  }
  return errors;
}

export function verifyReleaseVersionBinding(
  ledger,
  root,
  { tag = null, requireReady = false } = {},
) {
  const errors = [];
  const targetTag = ledger?.release?.targetVersion;
  const targetRepositoryVersion =
    normalizeReleaseTagToRepositoryVersion(targetTag);
  if (targetRepositoryVersion === null) return errors;

  if (tag !== null) {
    if (normalizeReleaseTagToRepositoryVersion(tag) === null) {
      addError(errors, `triggering tag is not a canonical release tag: ${tag}`);
    } else if (tag !== targetTag) {
      addError(
        errors,
        `triggering tag ${tag} does not match ledger target ${targetTag}`,
      );
    }
  } else if (requireReady) {
    addError(errors, "release publication requires an explicit --tag value");
  }

  if (requireReady || ledger?.release?.status === "ready") {
    const sourceErrors = [];
    const values = readVersionSourceValues(ledger, root, sourceErrors);
    errors.push(...sourceErrors);
    const distinct = new Set(values.map(({ value }) => value));
    if (distinct.size === 1) {
      const [repositoryVersion] = distinct;
      if (!FOUR_SEGMENT_VERSION.test(repositoryVersion)) {
        addError(
          errors,
          `repository release version must be four numeric segments with no leading/oversized segments: ${repositoryVersion}`,
        );
      } else if (repositoryVersion !== targetRepositoryVersion) {
        addError(
          errors,
          `ledger target ${targetTag} normalizes to repository version ${targetRepositoryVersion}, but VERSION/package.json contain ${repositoryVersion}`,
        );
      }
    }
  }

  return errors;
}

export function verifyApprovedStatements(ledger, root) {
  root = realpathSync(resolve(root));
  const errors = [];
  for (const statement of asArray(ledger?.approvedStatements)) {
    if (
      !isNonEmptyString(statement?.path) ||
      !isNonEmptyString(statement?.exact)
    ) {
      addError(errors, "every approvedStatements entry needs path and exact");
      continue;
    }
    const absolute = resolve(root, statement.path);
    if (!isInsideRoot(resolve(root), absolute)) {
      addError(
        errors,
        `approved statement path escapes repository root: ${statement.path}`,
      );
      continue;
    }
    if (!existsSync(absolute)) {
      addError(
        errors,
        `approved statement path does not exist: ${statement.path}`,
      );
      continue;
    }
    const statementPath = resolveContainedRegularFile(root, statement.path);
    if (!statementPath) {
      addError(
        errors,
        `approved statement path must be a real, regular, non-symlink repository file: ${statement.path}`,
      );
      continue;
    }
    const content = readFileSync(statementPath, "utf8");
    const extension = extname(statement.path).toLowerCase();
    const visibleContent = nonCommentContent(content, extension);
    let present = visibleContent.includes(statement.exact);
    if (present && [".js", ".mjs", ".ts", ".tsx"].includes(extension)) {
      present = extractComposedLiteralText(visibleContent).includes(
        normalizeClaimText(statement.exact),
      );
    }
    if (!present) {
      addError(
        errors,
        `${statement.id ?? statement.path}: approved statement is missing, stale, or only present in a non-rendered/comment context in ${statement.path}: ${JSON.stringify(statement.exact)}`,
      );
    }
  }
  return errors;
}

export function scanProhibitedClaims(ledger, root) {
  root = realpathSync(resolve(root));
  const errors = [];
  const documents = [];
  const seenFiles = new Set();
  for (const surface of asArray(ledger?.claimSurfaces)) {
    for (const file of collectSurfaceFiles(root, surface, errors)) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      documents.push({ file, content: readFileSync(file, "utf8") });
    }
  }

  for (const rule of asArray(ledger?.prohibitedClaims)) {
    if (!isNonEmptyString(rule?.id) || !isNonEmptyString(rule?.pattern)) {
      addError(errors, "every prohibitedClaims entry needs id and pattern");
      continue;
    }
    let regex;
    try {
      const flags = new Set((rule.flags ?? "i").split(""));
      flags.add("g");
      regex = new RegExp(rule.pattern, [...flags].join(""));
    } catch (error) {
      addError(
        errors,
        `${rule.id}: invalid prohibited-claim regex: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    for (const { file, content } of documents) {
      const relativeFile = relativePath(root, file);
      let variantContent = content;
      if (relativeFile === "CHANGELOG.md") {
        for (const exception of HISTORICAL_CHANGELOG_EXCEPTIONS) {
          if (
            exception.ruleId === rule.id &&
            content.toLowerCase().split(exception.exact.toLowerCase())
              .length === 2
          ) {
            const at = variantContent
              .toLowerCase()
              .indexOf(exception.exact.toLowerCase());
            if (at !== -1)
              variantContent = `${variantContent.slice(0, at)}${" ".repeat(exception.exact.length)}${variantContent.slice(at + exception.exact.length)}`;
          }
        }
      }
      const isHistoricalException = (matchText, matchIndex) => {
        if (relativeFile !== "CHANGELOG.md") return false;
        const exception = HISTORICAL_CHANGELOG_EXCEPTIONS.find(
          (candidate) =>
            candidate.ruleId === rule.id &&
            candidate.exact.toLowerCase() === matchText.toLowerCase(),
        );
        if (!exception) return false;
        const occurrence = content
          .toLowerCase()
          .indexOf(exception.exact.toLowerCase());
        return (
          occurrence === matchIndex &&
          occurrence !== -1 &&
          content
            .toLowerCase()
            .indexOf(exception.exact.toLowerCase(), occurrence + 1) === -1
        );
      };
      regex.lastIndex = 0;
      let match;
      let foundRawMatch = false;
      while ((match = regex.exec(content)) !== null) {
        if (isHistoricalException(match[0], match.index)) {
          if (match[0].length === 0) regex.lastIndex += 1;
          continue;
        }
        foundRawMatch = true;
        addError(
          errors,
          `${relativeFile}:${lineAt(content, match.index)}: prohibited release claim ${rule.id}: ${JSON.stringify(match[0])}`,
        );
        if (match[0].length === 0) regex.lastIndex += 1;
      }
      if (!foundRawMatch) {
        const normalized = normalizeClaimText(variantContent);
        regex.lastIndex = 0;
        while ((match = regex.exec(normalized)) !== null) {
          addError(
            errors,
            `${relativeFile}: normalized public copy contains prohibited release claim ${rule.id}: ${JSON.stringify(match[0])}`,
          );
          if (match[0].length === 0) regex.lastIndex += 1;
        }
      }
      if (!foundRawMatch) {
        const composed = extractComposedLiteralText(variantContent);
        regex.lastIndex = 0;
        while ((match = regex.exec(composed)) !== null) {
          addError(
            errors,
            `${relativeFile}: runtime-composed public copy contains prohibited release claim ${rule.id}: ${JSON.stringify(match[0])}`,
          );
          if (match[0].length === 0) regex.lastIndex += 1;
        }
      }
    }
  }
  for (const asset of asArray(ledger?.staleAssets)) {
    if (!isNonEmptyString(asset?.path)) continue;
    const pathNeedles = new Set([asset.path, asset.path.split("/").at(-1)]);
    for (const { file, content } of documents) {
      if (resolve(root, asset.path) === file) continue;
      const decodedContent = decodeHtmlEntities(content).replace(
        /%([0-9a-f]{2})/gi,
        (encoded, hex) => {
          const value = Number.parseInt(hex, 16);
          return Number.isNaN(value) ? encoded : String.fromCharCode(value);
        },
      );
      for (const needle of pathNeedles) {
        if (!needle) continue;
        const rawIndex = content.indexOf(needle);
        const decodedIndex = decodedContent.indexOf(needle);
        if (rawIndex === -1 && decodedIndex === -1) continue;
        if (
          relativePath(root, file) === "CHANGELOG.md" &&
          HISTORICAL_STALE_ASSET_EXCEPTIONS.some(
            (exception) =>
              exception.assetId === asset.id &&
              exception.exact === needle &&
              content.split(needle).length === 2,
          )
        )
          continue;
        addError(
          errors,
          `${relativePath(root, file)}:${rawIndex === -1 ? 1 : lineAt(content, rawIndex)}: prohibited stale asset reference ${asset.id}: ${needle}`,
        );
        break;
      }
    }
  }
  return errors;
}

async function fetchChecked(fetchImpl, url, options, description, errors) {
  try {
    const response = await fetchImpl(url, options);
    if (!response.ok) {
      addError(
        errors,
        `${description} lookup failed with HTTP ${response.status}`,
      );
      return null;
    }
    return response;
  } catch (error) {
    addError(
      errors,
      `${description} lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function hasExactPassingChecks(checks, expectedIds) {
  if (
    !sameStringSet(
      asArray(checks).map((check) => check?.id),
      expectedIds,
    )
  )
    return false;
  return asArray(checks).every(
    (check) =>
      check.testId === check.id &&
      check.result === "pass" &&
      isNonEmptyString(check.observed),
  );
}

function hasExactPassingMachineChecks(checks, expectedIds) {
  if (
    !sameStringSet(
      asArray(checks).map((check) => check?.id),
      expectedIds,
    )
  )
    return false;
  return asArray(checks).every(
    (check) =>
      check.testId === check.id &&
      check.result === "pass" &&
      isPlainRecord(check.observed) &&
      check.observed.exitCode === 0 &&
      isNonEmptyString(check.observed.assertion) &&
      isNonEmptyString(check.observed.measurement),
  );
}

function hasCompleteMacSigningObservation(
  subject,
  expectedArtifactName,
  expectedAppVersion,
) {
  const expectedKeys = [
    "artifactId",
    "artifactName",
    "artifactSha256",
    "artifactCreatedAt",
    "artifactUpdatedAt",
    "artifactProducerJobId",
    "artifactProducerJobName",
    "artifactProducerRunAttempt",
    "artifactProducerJobConclusion",
    "artifactProducerJobStartedAt",
    "artifactProducerJobCompletedAt",
    "artifactUploadStepName",
    "artifactUploadStepStartedAt",
    "artifactUploadStepCompletedAt",
    "kind",
    "path",
    "name",
    "sha256",
    "sizeBytes",
    "platform",
    "signatureResult",
    "notarizationResult",
    "verificationMethod",
    "signer",
    "signerTeamId",
    "signedIdentifier",
    "signedContentCdHash",
    "signedBundleVersion",
    "signedBundleBuildVersion",
    "executableArchitecture",
    "containerSignature",
  ];
  const expectedMethod = MACOS_SIGNING_METHODS.get(expectedArtifactName);
  const teamId = subject?.signerTeamId;
  const container = subject?.containerSignature;
  const containerKeys = [
    "signatureResult",
    "signer",
    "signerTeamId",
    "signedIdentifier",
    "signedContentCdHash",
  ];
  return (
    isPlainRecord(subject) &&
    Object.keys(subject).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(subject, key)) &&
    subject?.artifactName === expectedArtifactName &&
    subject?.signatureResult === "pass" &&
    subject?.notarizationResult === "pass" &&
    subject?.verificationMethod === expectedMethod &&
    /^[A-Z0-9]{10}$/u.test(teamId ?? "") &&
    new RegExp(`^Developer ID Application: .+ \\(${teamId}\\)$`, "u").test(
      subject?.signer ?? "",
    ) &&
    subject?.signedIdentifier === "com.skytwin.desktop" &&
    /^[0-9a-f]{40}$/u.test(subject?.signedContentCdHash ?? "") &&
    subject?.signedBundleVersion === expectedAppVersion &&
    subject?.signedBundleBuildVersion === expectedAppVersion &&
    subject?.executableArchitecture === "arm64" &&
    (expectedArtifactName === "SkyTwin-macOS-dmg"
      ? isPlainRecord(container) &&
        Object.keys(container).length === containerKeys.length &&
        containerKeys.every((key) => Object.hasOwn(container, key)) &&
        container.signatureResult === "pass" &&
        container.signer === subject.signer &&
        container.signerTeamId === teamId &&
        isNonEmptyString(container.signedIdentifier) &&
        /^[0-9a-f]{40}$/u.test(container.signedContentCdHash ?? "")
      : container === null)
  );
}

function hasCompleteWindowsSigningObservation(
  subject,
  expectedArtifactName,
  expectedAppVersion,
) {
  const expectedKeys = [
    "artifactId",
    "artifactName",
    "artifactSha256",
    "artifactCreatedAt",
    "artifactUpdatedAt",
    "artifactProducerJobId",
    "artifactProducerJobName",
    "artifactProducerRunAttempt",
    "artifactProducerJobConclusion",
    "artifactProducerJobStartedAt",
    "artifactProducerJobCompletedAt",
    "artifactUploadStepName",
    "artifactUploadStepStartedAt",
    "artifactUploadStepCompletedAt",
    "kind",
    "path",
    "name",
    "sha256",
    "sizeBytes",
    "platform",
    "signatureResult",
    "verificationMethod",
    "authenticodeStatus",
    "authenticodeSignatureType",
    "signer",
    "signerIssuer",
    "signerCertificateSha256",
    "signerCertificatePinned",
    "codeSigningEku",
    "timestampCertificatePresent",
    "timestampSignerCertificateSha256",
    "timestampCertificateValidation",
    "productVersion",
    "fileVersionMajor",
    "fileVersionMinor",
    "fileVersionBuild",
    "fileVersionPrivate",
    "containedExecutable",
  ];
  const executableKeys = [
    "derivationMethod",
    "derivationPath",
    "name",
    "sha256",
    "sizeBytes",
    "architecture",
    "productVersion",
    "fileVersionMajor",
    "fileVersionMinor",
    "fileVersionBuild",
    "fileVersionPrivate",
    "signatureResult",
    "verificationMethod",
    "authenticodeStatus",
    "authenticodeSignatureType",
    "signer",
    "signerIssuer",
    "signerCertificateSha256",
    "signerCertificatePinned",
    "codeSigningEku",
    "timestampCertificatePresent",
    "timestampSignerCertificateSha256",
    "timestampCertificateValidation",
  ];
  const executable = subject?.containedExecutable;
  const expectedProductVersion = `${expectedAppVersion}.0`;
  return (
    isPlainRecord(subject) &&
    Object.keys(subject).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(subject, key)) &&
    subject?.artifactName === expectedArtifactName &&
    subject?.signatureResult === "pass" &&
    subject?.verificationMethod === WINDOWS_SIGNING_METHOD &&
    subject?.authenticodeStatus === "Valid" &&
    subject?.authenticodeSignatureType === "Authenticode" &&
    isNonEmptyString(subject?.signer) &&
    isNonEmptyString(subject?.signerIssuer) &&
    subject.signer !== subject.signerIssuer &&
    SOURCE_DIGEST.test(subject?.signerCertificateSha256 ?? "") &&
    subject?.signerCertificatePinned === true &&
    subject?.codeSigningEku === true &&
    subject?.timestampCertificatePresent === true &&
    SOURCE_DIGEST.test(subject?.timestampSignerCertificateSha256 ?? "") &&
    subject?.timestampCertificateValidation === WINDOWS_TIMESTAMP_VALIDATION &&
    subject?.productVersion === expectedProductVersion &&
    subject?.fileVersionMajor === Number(expectedAppVersion.split(".")[0]) &&
    subject?.fileVersionMinor === Number(expectedAppVersion.split(".")[1]) &&
    subject?.fileVersionBuild === Number(expectedAppVersion.split(".")[2]) &&
    subject?.fileVersionPrivate === 0 &&
    isPlainRecord(executable) &&
    Object.keys(executable).length === executableKeys.length &&
    executableKeys.every((key) => Object.hasOwn(executable, key)) &&
    executable.derivationMethod === "nsis-7zip" &&
    executable.derivationPath === "app-64.7z!/SkyTwin.exe" &&
    executable.name === "SkyTwin.exe" &&
    SOURCE_DIGEST.test(executable.sha256 ?? "") &&
    Number.isSafeInteger(executable.sizeBytes) &&
    executable.sizeBytes > 0 &&
    executable.architecture === "AMD64" &&
    executable.productVersion === expectedProductVersion &&
    executable.fileVersionMajor === Number(expectedAppVersion.split(".")[0]) &&
    executable.fileVersionMinor === Number(expectedAppVersion.split(".")[1]) &&
    executable.fileVersionBuild === Number(expectedAppVersion.split(".")[2]) &&
    executable.fileVersionPrivate === 0 &&
    executable.signatureResult === "pass" &&
    executable.verificationMethod === WINDOWS_SIGNING_METHOD &&
    executable.authenticodeStatus === "Valid" &&
    executable.authenticodeSignatureType === "Authenticode" &&
    executable.signer === subject.signer &&
    executable.signerIssuer === subject.signerIssuer &&
    executable.signerCertificateSha256 === subject.signerCertificateSha256 &&
    executable.signerCertificatePinned === true &&
    executable.codeSigningEku === true &&
    executable.timestampCertificatePresent === true &&
    SOURCE_DIGEST.test(executable.timestampSignerCertificateSha256 ?? "") &&
    executable.timestampCertificateValidation === WINDOWS_TIMESTAMP_VALIDATION
  );
}

export function verifyMachineEvidenceApplicability(
  claimId,
  report,
  releaseAssets,
  verificationAssets = [],
) {
  const errors = [];
  if (claimId === "sample.packaged-account-free") {
    const binary = report?.executedBinary;
    const expectedDerivations = new Map([
      ["macos", "zip-ditto"],
      ["windows", "nsis-7zip"],
      ["linux", "appimage-extract"],
    ]);
    const expectedDerivationPaths = new Map([
      ["macos", "SkyTwin.app/Contents/MacOS/SkyTwin"],
      ["windows", "app-64.7z!/SkyTwin.exe"],
      ["linux", "squashfs-root/skytwin"],
    ]);
    const expectedRunnerPlatforms = new Map([
      ["macos", "darwin-arm64"],
      ["windows", "win32-x64"],
      ["linux", "linux-x64"],
    ]);
    if (
      !isNonEmptyString(binary?.name) ||
      !Number.isSafeInteger(binary?.sizeBytes) ||
      binary.sizeBytes <= 0 ||
      !SOURCE_DIGEST.test(binary?.sha256 ?? "") ||
      !Number.isSafeInteger(binary?.device) ||
      !Number.isSafeInteger(binary?.inode) ||
      binary?.identityResult !== "pass" ||
      expectedDerivations.get(report?.platform) !== binary?.derivationMethod ||
      expectedDerivationPaths.get(report?.platform) !==
        binary?.derivationPath ||
      expectedRunnerPlatforms.get(report?.platform) !== report?.runnerPlatform
    )
      errors.push(
        "sample.packaged-account-free machine evidence must identify the unpacked executable exercised by the verifier and prove stable pre/post file identity",
      );
  }
  if (claimId === "release.signing") {
    const reportPlatform = machineEvidencePlatformFamily(report?.platform);
    const expectedRunnerPlatforms = new Map([
      ["macos", "darwin-arm64"],
      ["windows", "win32-x64"],
      ["linux", "linux-x64"],
    ]);
    const expectedAssets = asArray(releaseAssets)
      .filter((asset) =>
        ["desktop-installer", "desktop-archive"].includes(asset.kind),
      )
      .filter((asset) => {
        const name = String(asset.artifactName ?? "");
        return (
          (reportPlatform === "macos" && name.includes("macOS")) ||
          (reportPlatform === "windows" && name.includes("Windows")) ||
          (reportPlatform === "linux" && name.includes("Linux"))
        );
      });
    const expectedSubjectArtifacts = new Map(
      expectedAssets.flatMap((asset) =>
        asArray(asset.subjects).map((subject) => [
          `${subject.path}:${subject.sha256}`,
          { asset, subject },
        ]),
      ),
    );
    const expectedSubjects = [...expectedSubjectArtifacts.keys()].sort();
    const coveredSubjects = asArray(report?.coveredSubjects);
    const actualSubjects = coveredSubjects
      .map((subject) => `${subject?.path}:${subject?.sha256}`)
      .sort();
    const expectedAppVersion = normalizeReleaseTagToAppVersion(
      report?.releaseTag,
    );
    const observationsAreComplete = coveredSubjects.every((subject) => {
      const subjectKey = `${subject?.path}:${subject?.sha256}`;
      const expected = expectedSubjectArtifacts.get(subjectKey);
      const expectedArtifactName = expected?.asset?.artifactName;
      const identityMatches =
        subject?.artifactId === expected?.asset?.artifactId &&
        subject?.artifactName === expectedArtifactName &&
        subject?.artifactSha256 === expected?.asset?.artifactSha256 &&
        subject?.kind === expected?.asset?.kind &&
        subject?.name === expected?.subject?.name &&
        subject?.sizeBytes === expected?.subject?.sizeBytes;
      if (!identityMatches) return false;
      if (reportPlatform === "macos")
        return hasCompleteMacSigningObservation(
          subject,
          expectedArtifactName,
          expectedAppVersion,
        );
      if (reportPlatform === "windows")
        return hasCompleteWindowsSigningObservation(
          subject,
          expectedArtifactName,
          expectedAppVersion,
        );
      return false;
    });
    const macIdentities = new Set(
      coveredSubjects.map((subject) =>
        [
          subject?.signer,
          subject?.signerTeamId,
          subject?.signedIdentifier,
          subject?.signedContentCdHash,
          subject?.signedBundleVersion,
          subject?.signedBundleBuildVersion,
          subject?.executableArchitecture,
        ].join("\u0000"),
      ),
    );
    if (
      !sameStringSet(actualSubjects, expectedSubjects) ||
      expectedSubjects.length === 0 ||
      reportPlatform === "linux" ||
      expectedRunnerPlatforms.get(reportPlatform) !== report?.runnerPlatform ||
      coveredSubjects.some(
        (subject) =>
          machineEvidencePlatformFamily(subject?.platform) !== reportPlatform,
      ) ||
      !observationsAreComplete ||
      (reportPlatform === "macos" && macIdentities.size !== 1)
    )
      errors.push(
        "release.signing machine evidence must prove the complete platform-native signature, identity, architecture, and notarization contract for every published installer/archive subject",
      );
  }
  if (claimId === "release.artifact-verification") {
    const verificationAssetsByPath = new Map(
      asArray(verificationAssets).map((asset) => [asset?.path, asset]),
    );
    const referencesVerificationAsset = (reference, kind) => {
      const asset = verificationAssetsByPath.get(reference?.path);
      return (
        asset?.kind === kind &&
        asset?.sha256 === reference?.sha256 &&
        SOURCE_DIGEST.test(reference?.sha256 ?? "")
      );
    };
    const expectedSubjects = asArray(releaseAssets)
      .flatMap((asset) =>
        asArray(asset.subjects).map(
          (subject) => `${subject.path}:${subject.sha256}`,
        ),
      )
      .sort();
    const coveredSubjects = asArray(report?.coveredSubjects);
    const actualSubjects = coveredSubjects
      .map((subject) => `${subject?.path}:${subject?.sha256}`)
      .sort();
    const hasCompleteEvidence = (subject) => {
      const subjectDigest = subject?.sha256;
      return (
        isNonEmptyString(subject?.path) &&
        SOURCE_DIGEST.test(subjectDigest ?? "") &&
        subject?.checksum?.algorithm === "sha256" &&
        referencesVerificationAsset(subject?.checksum, "checksums") &&
        subject?.checksum?.subjectSha256 === subjectDigest &&
        subject?.checksum?.result === "pass" &&
        subject?.sbom?.format === "spdx-json" &&
        referencesVerificationAsset(subject?.sbom, "sbom") &&
        subject?.sbom?.subjectSha256 === subjectDigest &&
        subject?.sbom?.result === "pass" &&
        subject?.provenance?.verificationMethod === "gh-attestation-verify" &&
        subject?.provenance?.bundlePath ===
          `${ARTIFACT_VERIFICATION_DIRECTORY}/${subjectDigest}.attestation.jsonl` &&
        referencesVerificationAsset(
          {
            path: subject?.provenance?.bundlePath,
            sha256: subject?.provenance?.bundleSha256,
          },
          "provenance-bundle",
        ) &&
        subject?.provenance?.subjectSha256 === subjectDigest &&
        subject?.provenance?.sourceCommit === report?.sourceCommit &&
        subject?.provenance?.result === "pass" &&
        referencesVerificationAsset(
          subject?.verificationInstructions,
          "verification-instructions",
        ) &&
        subject?.verificationInstructions?.subjectSha256 === subjectDigest &&
        subject?.verificationInstructions?.result === "pass"
      );
    };
    if (
      expectedSubjects.length === 0 ||
      !sameStringSet(actualSubjects, expectedSubjects) ||
      coveredSubjects.some((subject) => !hasCompleteEvidence(subject))
    )
      errors.push(
        "release.artifact-verification machine evidence must cover every canonical release subject with SHA-256 checksum, SBOM, source-bound provenance attestation, and verification instructions",
      );
  }
  if (claimId === "models.verified-delivery") {
    const modelArtifacts = asArray(report?.modelArtifacts);
    const model = modelArtifacts[0];
    const expectedFields = Object.keys(CANONICAL_MODEL_DELIVERY_ARTIFACT);
    const artifactCreated = Date.parse(report?.releaseArtifactCreatedAt ?? "");
    const uploadStarted = Date.parse(report?.desktopUploadStartedAt ?? "");
    const uploadCompleted = Date.parse(report?.desktopUploadCompletedAt ?? "");
    if (
      !isPlainRecord(report) ||
      !sameStringSet(Object.keys(report), MODEL_DELIVERY_REPORT_FIELDS) ||
      !Number.isSafeInteger(report.runAttempt) ||
      report.runAttempt <= 0 ||
      report.releaseArtifactAttemptBindingResult !==
        "workflow-output-and-upload-step-window-pass" ||
      !Number.isSafeInteger(artifactCreated) ||
      !Number.isSafeInteger(uploadStarted) ||
      !Number.isSafeInteger(uploadCompleted) ||
      artifactCreated < uploadStarted ||
      artifactCreated > uploadCompleted ||
      !Number.isSafeInteger(report.desktopProducerJobId) ||
      report.desktopProducerJobId <= 0 ||
      report.desktopProducerJobName !==
        "Desktop — Linux (AppImage + deb + rpm)" ||
      report.desktopProducerJobRunAttempt !== report.runAttempt ||
      report.desktopProducerJobConclusion !== "success" ||
      !Number.isSafeInteger(report.verifierJobId) ||
      report.verifierJobId <= 0 ||
      report.verifierJobName !== report.producerJobName ||
      report.verifierJobRunAttempt !== report.runAttempt ||
      report.verifierJobStatus !== "in_progress" ||
      report.runnerPlatform !== "linux-x64" ||
      modelArtifacts.length !== 1 ||
      !isPlainRecord(model) ||
      !sameStringSet(Object.keys(model), expectedFields) ||
      Object.entries(CANONICAL_MODEL_DELIVERY_ARTIFACT).some(
        ([field, value]) => model[field] !== value,
      ) ||
      JSON.stringify(report.checks) !==
        JSON.stringify(CANONICAL_MODEL_DELIVERY_CHECKS)
    )
      errors.push(
        "models.verified-delivery machine evidence must exactly match the canonical model inventory and complete verifier report contract",
      );
  }
  return errors;
}

function isValidSpdx23Checksum(checksum) {
  return (
    isPlainRecord(checksum) &&
    SPDX_23_CHECKSUM_ALGORITHMS.has(checksum.algorithm) &&
    typeof checksum.checksumValue === "string" &&
    /^[a-f0-9]+$/.test(checksum.checksumValue)
  );
}

function isValidSpdxUtcTimestamp(value) {
  if (!SPDX_UTC_TIMESTAMP.test(value ?? "")) return false;
  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) &&
    new Date(timestamp).toISOString() === value.replace(/Z$/, ".000Z")
  );
}

function isValidSpdxDocumentNamespace(value) {
  if (!isNonEmptyString(value) || value.includes("#")) return false;
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
}

function isValidSpdxPackageVerificationCode(value) {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    /^[a-f0-9]{40}$/.test(value.packageVerificationCodeValue ?? "")
  );
}

export function isValidSpdx23Document(sbom) {
  if (
    !isPlainRecord(sbom) ||
    sbom.spdxVersion !== "SPDX-2.3" ||
    sbom.dataLicense !== "CC0-1.0" ||
    sbom.SPDXID !== "SPDXRef-DOCUMENT" ||
    !isNonEmptyString(sbom.name) ||
    !isValidSpdxDocumentNamespace(sbom.documentNamespace) ||
    !isPlainRecord(sbom.creationInfo) ||
    !isValidSpdxUtcTimestamp(sbom.creationInfo.created) ||
    asArray(sbom.creationInfo.creators).length === 0 ||
    asArray(sbom.creationInfo.creators).some(
      (creator) =>
        !/^(?:Person|Organization|Tool):\s+\S/.test(String(creator ?? "")),
    ) ||
    asArray(sbom.packages).length === 0 ||
    asArray(sbom.files).length === 0
  )
    return false;

  const packagesValid = sbom.packages.every(
    (entry) =>
      isPlainRecord(entry) &&
      SPDX_ELEMENT_ID.test(entry.SPDXID ?? "") &&
      isNonEmptyString(entry.downloadLocation) &&
      isNonEmptyString(entry.name) &&
      isNonEmptyString(entry.versionInfo) &&
      entry.filesAnalyzed === true &&
      isValidSpdxPackageVerificationCode(entry.packageVerificationCode),
  );
  const filesValid = sbom.files.every(
    (entry) =>
      isPlainRecord(entry) &&
      SPDX_ELEMENT_ID.test(entry.SPDXID ?? "") &&
      isNonEmptyString(entry.fileName) &&
      asArray(entry.checksums).length > 0 &&
      entry.checksums.every(isValidSpdx23Checksum),
  );
  if (!packagesValid || !filesValid) return false;

  const elementIds = [
    sbom.SPDXID,
    ...sbom.packages.map((entry) => entry.SPDXID),
    ...sbom.files.map((entry) => entry.SPDXID),
  ];
  if (new Set(elementIds).size !== elementIds.length) return false;
  const packageIds = new Set(sbom.packages.map((entry) => entry.SPDXID));
  const fileIds = new Set(sbom.files.map((entry) => entry.SPDXID));
  if (
    !sameStringSet(sbom.documentDescribes, [...packageIds]) ||
    !Array.isArray(sbom.relationships)
  )
    return false;
  const relationshipsValid = sbom.relationships.every(
    (relationship) =>
      isPlainRecord(relationship) &&
      elementIds.includes(relationship.spdxElementId) &&
      elementIds.includes(relationship.relatedSpdxElement) &&
      SPDX_23_RELATIONSHIP_TYPES.has(relationship.relationshipType),
  );
  if (!relationshipsValid) return false;
  const describedPackages = new Set(
    sbom.relationships
      .filter(
        (relationship) =>
          relationship.spdxElementId === sbom.SPDXID &&
          relationship.relationshipType === "DESCRIBES" &&
          packageIds.has(relationship.relatedSpdxElement),
      )
      .map((relationship) => relationship.relatedSpdxElement),
  );
  const containedFiles = new Set(
    sbom.relationships
      .filter(
        (relationship) =>
          packageIds.has(relationship.spdxElementId) &&
          relationship.relationshipType === "CONTAINS" &&
          fileIds.has(relationship.relatedSpdxElement),
      )
      .map((relationship) => relationship.relatedSpdxElement),
  );
  return (
    sameStringSet([...describedPackages], [...packageIds]) &&
    sameStringSet([...containedFiles], [...fileIds])
  );
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function buildCanonicalVerificationInstructions({
  subjects,
  repository,
  sourceCommit,
  sourceRef,
}) {
  const orderedSubjects = [...subjects].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const provenanceCommands = orderedSubjects.map(
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
${provenanceCommands.join("\n")}
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

export function verifyGitHubArtifactAttestation(
  { subjectPath, bundlePath, repository, sourceCommit, sourceRef, token },
  execute = execFileSync,
) {
  const output = execute(
    "gh",
    [
      "attestation",
      "verify",
      subjectPath,
      "--repo",
      repository,
      "--bundle",
      bundlePath,
      "--source-digest",
      sourceCommit,
      "--source-ref",
      sourceRef,
      "--signer-workflow",
      `github.com/${repository}/.github/workflows/build.yml`,
      "--predicate-type",
      "https://slsa.dev/provenance/v1",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  const verified = JSON.parse(output);
  if (!Array.isArray(verified) || verified.length === 0)
    throw new Error("GitHub CLI returned no verified attestations");
}

export async function verifyArtifactVerificationMaterials(
  {
    root,
    manifest,
    report,
    repository,
    releaseCommit,
    triggerRef,
    githubToken,
  },
  attestationVerifier = verifyGitHubArtifactAttestation,
) {
  const errors = [];
  const verificationDirectory = resolve(root, ARTIFACT_VERIFICATION_DIRECTORY);
  if (
    !isInsideRoot(root, verificationDirectory) ||
    !existsSync(verificationDirectory) ||
    hasSymlinkComponent(root, verificationDirectory) ||
    !lstatSync(verificationDirectory).isDirectory()
  ) {
    return ["artifact-verification material directory is missing or unsafe"];
  }

  const actualPaths = [];
  for (const entry of readdirSync(verificationDirectory, {
    withFileTypes: true,
  })) {
    const path = join(verificationDirectory, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      addError(
        errors,
        `artifact-verification material is not a direct regular file: ${relativePath(root, path)}`,
      );
      continue;
    }
    actualPaths.push(relativePath(root, path));
  }
  const declaredPaths = asArray(manifest?.verificationAssets)
    .map((asset) => asset?.path)
    .sort();
  if (!sameStringSet(actualPaths.sort(), declaredPaths))
    addError(
      errors,
      "artifact-verification material inventory does not exactly equal the manifest",
    );

  const assetsByPath = new Map();
  for (const asset of asArray(manifest?.verificationAssets)) {
    const safePath = resolveContainedRegularFile(root, asset?.path);
    if (!safePath) {
      addError(
        errors,
        `artifact-verification material is missing or unsafe: ${asset?.path ?? "missing"}`,
      );
      continue;
    }
    const actualDigest = sha256(readFileSync(safePath));
    if (actualDigest !== asset.sha256)
      addError(
        errors,
        `artifact-verification material digest changed: ${asset.path}`,
      );
    assetsByPath.set(asset.path, { ...asset, safePath });
  }

  const subjects = asArray(manifest?.releaseAssets).flatMap((asset) =>
    asArray(asset?.subjects),
  );
  const subjectNames = subjects.map((subject) => subject?.name);
  if (
    subjectNames.some((name) => !isNonEmptyString(name)) ||
    new Set(subjectNames).size !== subjectNames.length
  )
    addError(
      errors,
      "canonical release subjects must have unique published filenames",
    );

  const checksumAsset = [...assetsByPath.values()].find(
    (asset) => asset.kind === "checksums",
  );
  if (checksumAsset) {
    const checksumEntries = readFileSync(checksumAsset.safePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => line.match(/^([a-f0-9]{64}) [ *]([^/\\]+)$/));
    const actualChecksums = checksumEntries
      .filter(Boolean)
      .map((match) => `${match[2]}:${match[1]}`)
      .sort();
    const expectedChecksums = subjects
      .map((subject) => `${subject.name}:${subject.sha256}`)
      .sort();
    if (
      checksumEntries.some((entry) => entry === null) ||
      !sameStringSet(actualChecksums, expectedChecksums)
    )
      addError(
        errors,
        "SHA256SUMS must exactly cover every canonical published subject",
      );
  }

  const sbomAsset = [...assetsByPath.values()].find(
    (asset) => asset.kind === "sbom",
  );
  if (sbomAsset) {
    let sbom;
    try {
      sbom = JSON.parse(readFileSync(sbomAsset.safePath, "utf8"));
    } catch {
      addError(errors, "artifact-verification SBOM is not valid JSON");
    }
    if (sbom) {
      const described = new Set(asArray(sbom.documentDescribes));
      const files = asArray(sbom.files);
      const contained = new Set(
        asArray(sbom.relationships)
          .filter(
            (relationship) =>
              described.has(relationship?.spdxElementId) &&
              relationship?.relationshipType === "CONTAINS",
          )
          .map((relationship) => relationship.relatedSpdxElement),
      );
      const coversSubject = (subject) =>
        files.some(
          (file) =>
            contained.has(file?.SPDXID) &&
            [subject.name, subject.path].includes(file?.fileName) &&
            asArray(file?.checksums).some(
              (checksum) =>
                checksum?.algorithm === "SHA256" &&
                checksum?.checksumValue === subject.sha256,
            ),
        );
      const filesById = new Map(files.map((file) => [file?.SPDXID, file]));
      const subjectsForPackage = (packageId) => {
        const containedFileIds = asArray(sbom.relationships)
          .filter(
            (relationship) =>
              relationship?.spdxElementId === packageId &&
              relationship?.relationshipType === "CONTAINS",
          )
          .map((relationship) => relationship.relatedSpdxElement);
        const matchedSubjects = containedFileIds.map((fileId) => {
          const file = filesById.get(fileId);
          return subjects.find(
            (subject) =>
              [subject.name, subject.path].includes(file?.fileName) &&
              asArray(file?.checksums).some(
                (checksum) =>
                  checksum?.algorithm === "SHA256" &&
                  checksum?.checksumValue === subject.sha256,
              ),
          );
        });
        return matchedSubjects.every(Boolean) &&
          new Set(matchedSubjects.map((subject) => subject.path)).size ===
            matchedSubjects.length
          ? matchedSubjects
          : null;
      };
      const hasValidPackageVerificationCodes = asArray(sbom.packages).every(
        (spdxPackage) => {
          const packageSubjects = subjectsForPackage(spdxPackage?.SPDXID);
          if (!packageSubjects || packageSubjects.length === 0) return false;
          const fileSha1s = packageSubjects
            .map((subject) => {
              const subjectPath = resolveContainedRegularFile(
                root,
                subject.path,
              );
              return subjectPath
                ? createHash("sha1")
                    .update(readFileSync(subjectPath))
                    .digest("hex")
                : null;
            })
            .sort();
          if (fileSha1s.some((digest) => digest === null)) return false;
          const expectedCode = createHash("sha1")
            .update(fileSha1s.join(""))
            .digest("hex");
          return (
            spdxPackage?.packageVerificationCode
              ?.packageVerificationCodeValue === expectedCode
          );
        },
      );
      if (
        !isValidSpdx23Document(sbom) ||
        subjects.some((subject) => !coversSubject(subject)) ||
        !hasValidPackageVerificationCodes
      )
        addError(
          errors,
          "SPDX SBOM must satisfy the SPDX 2.3 document, package, and file contract and describe every canonical subject by SHA-256",
        );
    }
  }

  const instructionsAsset = [...assetsByPath.values()].find(
    (asset) => asset.kind === "verification-instructions",
  );
  if (instructionsAsset) {
    const instructions = readFileSync(instructionsAsset.safePath, "utf8");
    const canonicalInstructions = buildCanonicalVerificationInstructions({
      subjects,
      repository,
      sourceCommit: releaseCommit,
      sourceRef: triggerRef,
    });
    if (instructions !== canonicalInstructions)
      addError(
        errors,
        "verification instructions must exactly match the repository-, source-, workflow-, predicate-, bundle-, and subject-bound canonical guide",
      );
  }

  const coveredSubjects = asArray(report?.coveredSubjects);
  const referencedBundlePaths = coveredSubjects.map(
    (subject) => subject?.provenance?.bundlePath,
  );
  const declaredBundlePaths = asArray(manifest?.verificationAssets)
    .filter((asset) => asset?.kind === "provenance-bundle")
    .map((asset) => asset.path);
  if (
    referencedBundlePaths.some((path) => !isNonEmptyString(path)) ||
    !sameStringSet([...new Set(referencedBundlePaths)], declaredBundlePaths)
  )
    addError(
      errors,
      "provenance bundle inventory must exactly cover every canonical subject",
    );

  if (errors.length > 0) return errors;
  for (const subject of coveredSubjects) {
    const releaseSubject = subjects.find(
      (candidate) =>
        candidate.path === subject.path && candidate.sha256 === subject.sha256,
    );
    const bundle = assetsByPath.get(subject.provenance.bundlePath);
    const subjectPath = releaseSubject
      ? resolveContainedRegularFile(root, releaseSubject.path)
      : null;
    if (!subjectPath || !bundle) {
      addError(errors, `provenance material is missing for ${subject.path}`);
      continue;
    }
    try {
      await attestationVerifier({
        subjectPath,
        bundlePath: bundle.safePath,
        repository,
        sourceCommit: releaseCommit,
        sourceRef: triggerRef,
        token: githubToken,
      });
    } catch (error) {
      addError(
        errors,
        `GitHub attestation verification failed for ${subject.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

export function hasCanonicalSuccessfulMachineSteps(claimId, producerJob) {
  const steps = asArray(producerJob?.steps);
  const verifierStepName =
    claimId === "sample.packaged-account-free"
      ? "Run canonical packaged sample verifier without GitHub API token"
      : CANONICAL_MACHINE_VERIFIER_STEP;
  return (
    steps.some(
      (step) =>
        step?.name === verifierStepName && step?.conclusion === "success",
    ) &&
    (claimId !== "release.signing" ||
      steps.some(
        (step) =>
          step?.name === "Verify exact uploaded signing report binding" &&
          step?.conclusion === "success",
      ))
  );
}

export function isValidSigningSourceReportArtifact(
  artifact,
  evidence,
  runId,
  releaseCommit,
) {
  return (
    artifact?.id === evidence?.sourceReportArtifactId &&
    artifact?.name === evidence?.sourceReportArtifactName &&
    artifact?.expired === false &&
    artifact?.digest === `sha256:${evidence?.sourceReportArtifactSha256}` &&
    artifact?.created_at === evidence?.sourceReportArtifactCreatedAt &&
    artifact?.updated_at === evidence?.sourceReportArtifactUpdatedAt &&
    artifact?.workflow_run?.id === runId &&
    artifact?.workflow_run?.head_sha === releaseCommit
  );
}

export function isValidSigningUploadBinding(
  binding,
  evidence,
  { repository, releaseCommit, tag, triggerRef, runId, runAttempt },
) {
  return (
    hasExactRecordKeys(binding, [
      "schemaVersion",
      "generatedBy",
      "claimId",
      "platform",
      "repository",
      "sourceCommit",
      "releaseTag",
      "ref",
      "runId",
      "runAttempt",
      "runAttemptStartedAt",
      "artifactProducers",
      "reportName",
      "reportSha256",
      "sourceArtifactId",
      "sourceArtifactName",
      "sourceArtifactSha256",
    ]) &&
    binding.schemaVersion === 1 &&
    binding.generatedBy === "release-signing-upload-verifier" &&
    binding.claimId === evidence.claimId &&
    binding.platform === evidence.platform &&
    binding.repository === repository &&
    binding.sourceCommit === releaseCommit &&
    binding.releaseTag === tag &&
    binding.ref === triggerRef &&
    binding.runId === runId &&
    binding.runAttempt === runAttempt &&
    binding.runAttemptStartedAt === evidence.runAttemptStartedAt &&
    JSON.stringify(binding.artifactProducers) ===
      JSON.stringify(evidence.artifactProducers) &&
    binding.reportName === basename(evidence.reportPath) &&
    binding.reportSha256 === evidence.reportSha256 &&
    binding.sourceArtifactId === evidence.sourceReportArtifactId &&
    binding.sourceArtifactName === evidence.sourceReportArtifactName &&
    binding.sourceArtifactSha256 === evidence.sourceReportArtifactSha256
  );
}

export async function verifyPublicationEvidence(
  ledger,
  manifest,
  {
    root,
    repository,
    releaseCommit,
    tag,
    runId,
    triggerRef,
    githubToken,
    fetchImpl = globalThis.fetch,
    attestationVerifier = verifyGitHubArtifactAttestation,
  } = {},
) {
  const errors = [];
  if (!GITHUB_REPOSITORY.test(repository ?? ""))
    addError(
      errors,
      "release publication requires --repository owner/repository",
    );
  if (!COMMIT_SHA.test(releaseCommit ?? ""))
    addError(
      errors,
      "release publication requires --commit with a lowercase 40-character commit SHA",
    );
  if (!isNonEmptyString(tag))
    addError(errors, "release publication requires an explicit tag");
  if (!Number.isSafeInteger(runId) || runId <= 0)
    addError(
      errors,
      "release publication requires the current positive run ID",
    );
  if (triggerRef !== `refs/tags/${tag}`)
    addError(
      errors,
      `release publication ref must be the triggering tag ref refs/tags/${tag}`,
    );
  if (manifest?.schemaVersion !== 1)
    addError(errors, "release evidence manifest schemaVersion must be 1");
  if (manifest?.repository !== repository)
    addError(
      errors,
      "release evidence manifest repository does not match the triggering repository",
    );
  if (manifest?.releaseCommit !== releaseCommit)
    addError(
      errors,
      "release evidence manifest commit does not match the triggering release commit",
    );
  if (manifest?.tag !== tag)
    addError(
      errors,
      "release evidence manifest tag does not match the triggering tag",
    );
  if (manifest?.runId !== runId)
    addError(
      errors,
      "release evidence manifest runId does not match the current workflow run",
    );
  if (!Number.isSafeInteger(manifest?.runAttempt) || manifest.runAttempt <= 0)
    addError(
      errors,
      "release evidence manifest runAttempt must be a positive integer",
    );
  if (canonicalGithubTimestampMs(manifest?.runAttemptStartedAt) === null)
    addError(
      errors,
      "release evidence manifest runAttemptStartedAt must be a canonical GitHub timestamp",
    );
  if (manifest?.ref !== triggerRef)
    addError(
      errors,
      "release evidence manifest ref does not match the triggering tag ref",
    );
  validateReleaseAssetManifest(manifest, errors);
  validateArtifactVerificationAssetManifest(manifest, errors);
  if (errors.length > 0) return errors;

  const requiredPairs = new Set();
  for (const readiness of asArray(ledger?.release?.readinessClaims)) {
    for (const kind of asArray(readiness?.requiredEvidenceKinds)) {
      if (kind !== "source") requiredPairs.add(`${readiness.claimId}:${kind}`);
    }
  }
  const evidenceEntries = [];
  const seenPairs = new Set();
  for (const [index, evidence] of asArray(manifest?.evidence).entries()) {
    const pair = `${evidence?.claimId}:${evidence?.kind}`;
    const canonicalMachinePlatforms =
      evidence?.kind === "machine"
        ? CANONICAL_MACHINE_EVIDENCE_MATRIX.filter(
            (entry) => entry.claimId === evidence?.claimId,
          ).map((entry) => entry.platform)
        : [];
    const usesPlatformIdentity = canonicalMachinePlatforms.length > 1;
    const identity = usesPlatformIdentity
      ? `${pair}:${evidence?.platform ?? "missing"}`
      : pair;
    const prefix = `release evidence manifest entry ${index}`;
    if (!requiredPairs.has(pair)) {
      addError(
        errors,
        `${prefix} is not required by the release ledger: ${pair}`,
      );
      continue;
    }
    if (
      evidence?.kind === "machine" &&
      !canonicalMachinePlatforms.includes(evidence?.platform)
    ) {
      addError(
        errors,
        `${prefix} has unexpected canonical machine evidence platform: ${evidence?.platform ?? "missing"}`,
      );
      continue;
    }
    if (seenPairs.has(identity)) {
      addError(errors, `${prefix} duplicates required evidence: ${identity}`);
      continue;
    }
    seenPairs.add(identity);
    validateExternalEvidenceShape(evidence, prefix, errors);
    if (
      evidence?.claimId === "release.signing" &&
      !validSigningArtifactProducers(
        evidence.artifactProducers,
        evidence.platform,
        evidence.runAttempt,
        manifest.runAttemptStartedAt,
      )
    )
      addError(
        errors,
        `${prefix}.artifactProducers does not prove current-attempt desktop upload provenance`,
      );
    evidenceEntries.push({ claimId: evidence.claimId, evidence });
  }
  for (const pair of requiredPairs) {
    const [claimId, kind] = pair.split(":");
    const canonicalMachinePlatforms =
      kind === "machine"
        ? CANONICAL_MACHINE_EVIDENCE_MATRIX.filter(
            (entry) => entry.claimId === claimId,
          ).map((entry) => entry.platform)
        : [];
    if (canonicalMachinePlatforms.length > 1) {
      for (const platform of canonicalMachinePlatforms)
        if (!seenPairs.has(`${pair}:${platform}`))
          addError(
            errors,
            `release evidence manifest is missing required evidence: ${pair}:${platform}`,
          );
      continue;
    }
    if (!seenPairs.has(pair))
      addError(
        errors,
        `release evidence manifest is missing required evidence: ${pair}`,
      );
  }
  if (errors.length > 0) return errors;
  const ciEntries = evidenceEntries.filter(
    ({ evidence }) => evidence?.kind === "ci",
  );
  if (evidenceEntries.length > 0 && !isNonEmptyString(githubToken)) {
    addError(errors, "release evidence verification requires GITHUB_TOKEN");
    return errors;
  }

  for (const { claimId, evidence } of evidenceEntries) {
    if (evidence.runId !== runId)
      addError(
        errors,
        `${claimId} ${evidence.kind} evidence is not from the current workflow run`,
      );
    if (evidence.runAttempt !== manifest.runAttempt)
      addError(
        errors,
        `${claimId} ${evidence.kind} evidence is not from the current workflow run attempt`,
      );
    if (evidence.runAttemptStartedAt !== manifest.runAttemptStartedAt)
      addError(
        errors,
        `${claimId} ${evidence.kind} evidence is not from the current workflow attempt start`,
      );
    if (evidence.ref !== triggerRef)
      addError(
        errors,
        `${claimId} ${evidence.kind} evidence is not bound to the triggering tag ref`,
      );
  }
  if (errors.length > 0) return errors;

  const apiRoot = `https://api.github.com/repos/${repository}/actions`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const currentRunResponse = await fetchChecked(
    fetchImpl,
    `${apiRoot}/runs/${runId}`,
    { headers },
    "current release workflow run",
    errors,
  );
  if (!currentRunResponse) return errors;
  let currentRun;
  try {
    currentRun = await currentRunResponse.json();
  } catch {
    addError(
      errors,
      "current release workflow run API response was not valid JSON",
    );
    return errors;
  }
  if (
    currentRun.id !== runId ||
    currentRun.head_sha !== releaseCommit ||
    currentRun.event !== "push" ||
    currentRun.head_branch !== tag ||
    currentRun.path !== RELEASE_EVIDENCE_WORKFLOW_PATH ||
    currentRun.repository?.full_name !== repository ||
    currentRun.run_attempt !== manifest.runAttempt
  ) {
    addError(
      errors,
      "current workflow run is not the tag-push build.yml run for the release commit",
    );
    return errors;
  }
  const currentAttemptResponse = await fetchChecked(
    fetchImpl,
    `${apiRoot}/runs/${runId}/attempts/${manifest.runAttempt}`,
    { headers },
    "current release workflow attempt",
    errors,
  );
  const currentAttemptJobsResponse = await fetchChecked(
    fetchImpl,
    `${apiRoot}/runs/${runId}/attempts/${manifest.runAttempt}/jobs?per_page=100&page=1`,
    { headers },
    "current release workflow attempt jobs",
    errors,
  );
  if (!currentAttemptResponse || !currentAttemptJobsResponse) return errors;
  let currentAttempt;
  let currentAttemptJobsPage;
  try {
    [currentAttempt, currentAttemptJobsPage] = await Promise.all([
      currentAttemptResponse.json(),
      currentAttemptJobsResponse.json(),
    ]);
  } catch {
    addError(
      errors,
      "current workflow attempt API response was not valid JSON",
    );
    return errors;
  }
  if (
    currentAttempt.id !== runId ||
    currentAttempt.run_attempt !== manifest.runAttempt ||
    currentAttempt.head_sha !== releaseCommit ||
    currentAttempt.event !== "push" ||
    currentAttempt.head_branch !== tag ||
    currentAttempt.path !== RELEASE_EVIDENCE_WORKFLOW_PATH ||
    currentAttempt.repository?.full_name !== repository ||
    currentAttempt.run_started_at !== manifest.runAttemptStartedAt
  ) {
    addError(
      errors,
      "current workflow attempt is not the exact tag-push build.yml attempt recorded by the manifest",
    );
    return errors;
  }
  if (
    !Array.isArray(currentAttemptJobsPage?.jobs) ||
    !Number.isSafeInteger(currentAttemptJobsPage.total_count) ||
    currentAttemptJobsPage.total_count > 100 ||
    currentAttemptJobsPage.jobs.length !== currentAttemptJobsPage.total_count
  ) {
    addError(
      errors,
      "current workflow attempt job inventory is malformed, ambiguous, or paginated",
    );
    return errors;
  }
  const exactAttemptJobsById = new Map();
  for (const job of currentAttemptJobsPage.jobs) {
    if (
      !Number.isSafeInteger(job?.id) ||
      job.id <= 0 ||
      job.run_id !== runId ||
      job.run_attempt !== manifest.runAttempt ||
      job.run_url !== `${apiRoot}/runs/${runId}` ||
      job.head_sha !== releaseCommit ||
      exactAttemptJobsById.has(job.id)
    ) {
      addError(
        errors,
        "current workflow attempt job inventory has an invalid, wrong-run, or duplicate job identity",
      );
      return errors;
    }
    exactAttemptJobsById.set(job.id, job);
  }

  const releaseAssetsByName = new Map();
  for (const asset of manifest.releaseAssets) {
    const prefix = `release asset ${asset.artifactName}`;
    const response = await fetchChecked(
      fetchImpl,
      `${apiRoot}/artifacts/${asset.artifactId}`,
      { headers },
      prefix,
      errors,
    );
    if (!response) continue;
    let apiArtifact;
    try {
      apiArtifact = await response.json();
    } catch {
      addError(errors, `${prefix} API response was not valid JSON`);
      continue;
    }
    if (
      apiArtifact.id !== asset.artifactId ||
      apiArtifact.name !== asset.artifactName ||
      apiArtifact.expired !== false ||
      apiArtifact.digest !== `sha256:${asset.artifactSha256}` ||
      apiArtifact.workflow_run?.id !== runId ||
      apiArtifact.workflow_run?.head_sha !== releaseCommit
    ) {
      addError(
        errors,
        `${prefix} is not an unexpired ID/name/digest-bound artifact from the current run`,
      );
      continue;
    }
    const actualPaths = collectDownloadedArtifactSubjects(
      root,
      asset.artifactName,
      errors,
    );
    const declaredPaths = asArray(asset.subjects)
      .map((subject) => subject.path)
      .sort();
    if (
      actualPaths.length !== declaredPaths.length ||
      actualPaths.some((path, index) => path !== declaredPaths[index])
    ) {
      addError(
        errors,
        `${prefix} subject inventory does not exactly equal the downloaded artifact contents`,
      );
      continue;
    }
    for (const subject of asset.subjects) {
      const subjectPath = resolveContainedRegularFile(root, subject.path);
      if (
        !subjectPath ||
        lstatSync(subjectPath).size !== subject.sizeBytes ||
        sha256(readFileSync(subjectPath)) !== subject.sha256
      )
        addError(
          errors,
          `${prefix} subject is missing, unsafe, or has the wrong size or digest: ${subject.path}`,
        );
    }
    releaseAssetsByName.set(asset.artifactName, { ...asset, apiArtifact });
  }

  for (const { claimId, evidence } of ciEntries) {
    const prefix = `${claimId} CI evidence`;
    if (evidence.repository !== repository)
      addError(errors, `${prefix} repository is not the triggering repository`);
    if (evidence.commitSha !== releaseCommit)
      addError(errors, `${prefix} commit is not the triggering release commit`);
    if (evidence.conclusion !== "success")
      addError(errors, `${prefix} does not record a successful conclusion`);
    if (
      evidence.repository !== repository ||
      evidence.commitSha !== releaseCommit ||
      evidence.conclusion !== "success"
    ) {
      continue;
    }

    const jobResponse = await fetchChecked(
      fetchImpl,
      `${apiRoot}/jobs/${evidence.jobId}`,
      { headers },
      `${prefix} job`,
      errors,
    );
    const artifactResponse = await fetchChecked(
      fetchImpl,
      `${apiRoot}/artifacts/${evidence.artifactId}`,
      { headers },
      `${prefix} artifact`,
      errors,
    );
    if (!jobResponse || !artifactResponse) continue;
    let job;
    let artifact;
    try {
      [job, artifact] = await Promise.all([
        jobResponse.json(),
        artifactResponse.json(),
      ]);
    } catch {
      addError(errors, `${prefix} API response was not valid JSON`);
      continue;
    }
    if (
      job.id !== evidence.jobId ||
      job.name !== evidence.jobName ||
      job.conclusion !== "success" ||
      job.run_url !==
        `https://api.github.com/repos/${repository}/actions/runs/${runId}` ||
      job.head_sha !== releaseCommit
    ) {
      addError(
        errors,
        `${prefix} job is not a successful job in the recorded run`,
      );
    }
    const exactAttemptJob = exactAttemptJobsById.get(evidence.jobId);
    const jobStartedMs = canonicalGithubTimestampMs(job.started_at);
    const attemptStartedMs = canonicalGithubTimestampMs(
      manifest.runAttemptStartedAt,
    );
    if (
      job.run_attempt !== manifest.runAttempt ||
      jobStartedMs === null ||
      jobStartedMs < attemptStartedMs ||
      exactAttemptJob?.id !== job.id ||
      exactAttemptJob?.run_attempt !== manifest.runAttempt ||
      exactAttemptJob?.name !== job.name ||
      exactAttemptJob?.conclusion !== "success" ||
      exactAttemptJob?.started_at !== job.started_at ||
      exactAttemptJob?.completed_at !== job.completed_at
    )
      addError(
        errors,
        `${prefix} job is not current-attempt verifier evidence`,
      );
    if (
      artifact.id !== evidence.artifactId ||
      artifact.name !== evidence.artifactName ||
      artifact.expired !== false ||
      artifact.digest !== `sha256:${evidence.artifactSha256}` ||
      artifact.workflow_run?.id !== evidence.runId ||
      artifact.workflow_run?.head_sha !== releaseCommit
    ) {
      addError(
        errors,
        `${prefix} artifact is not an unexpired digest-bound artifact from the recorded run`,
      );
    }
    const reportPath = resolveContainedRegularFile(root, evidence.reportPath);
    if (!reportPath) {
      addError(
        errors,
        `${prefix} downloaded result is missing or unsafe: ${evidence.reportPath}`,
      );
      continue;
    }
    const reportBytes = readFileSync(reportPath);
    let report;
    try {
      report = JSON.parse(reportBytes.toString("utf8"));
    } catch {
      addError(errors, `${prefix} downloaded result is not valid JSON`);
      continue;
    }
    const reportClaims = asArray(report?.claims);
    const reportClaimIds = reportClaims.map((entry) => entry?.claimId);
    const canonicalCiClaimIds = [...CANONICAL_CI_EVIDENCE_CHECKS.keys()];
    const claimResult = reportClaims.find(
      (entry) => entry?.claimId === claimId,
    );
    if (
      sha256(reportBytes) !== evidence.reportSha256 ||
      report.schemaVersion !== 1 ||
      report.generatedBy !== "release-claim-ci-harness" ||
      report.result !== "pass" ||
      report.runId !== runId ||
      report.sourceCommit !== releaseCommit ||
      report.ref !== triggerRef ||
      !sameStringSet(reportClaimIds, canonicalCiClaimIds) ||
      !claimResult ||
      !hasExactPassingChecks(
        claimResult.checks,
        CANONICAL_CI_EVIDENCE_CHECKS.get(claimId),
      ) ||
      !sameStringSet(
        evidence.checkIds,
        claimResult.checks.map(({ id }) => id),
      )
    ) {
      addError(
        errors,
        `${prefix} downloaded result is not a claim-specific passing result with the canonical test IDs for the current tag run`,
      );
    }
  }

  for (const { claimId, evidence } of evidenceEntries.filter(
    ({ evidence }) => evidence?.kind === "machine",
  )) {
    const prefix = `${claimId} machine evidence`;
    const declaredReleaseAsset = releaseAssetsByName.get(
      evidence.releaseArtifactName,
    );
    if (evidence.repository !== repository)
      addError(errors, `${prefix} repository is not the triggering repository`);
    if (evidence.sourceCommit !== releaseCommit)
      addError(
        errors,
        `${prefix} sourceCommit is not the triggering release commit`,
      );
    if (evidence.releaseTag !== tag)
      addError(errors, `${prefix} releaseTag is not the triggering tag`);
    if (
      evidence.repository !== repository ||
      evidence.sourceCommit !== releaseCommit ||
      evidence.releaseTag !== tag ||
      evidence.producerJobConclusion !== "success"
    )
      continue;
    if (
      !declaredReleaseAsset ||
      declaredReleaseAsset.artifactId !== evidence.releaseArtifactId ||
      declaredReleaseAsset.kind !== evidence.releaseArtifactKind ||
      declaredReleaseAsset.artifactSha256 !== evidence.releaseArtifactSha256 ||
      !declaredReleaseAsset.subjects.some(
        (subject) =>
          subject.name === evidence.subjectName &&
          subject.path === evidence.subjectPath &&
          subject.sha256 === evidence.subjectSha256,
      )
    ) {
      addError(
        errors,
        `${prefix} is not bound to a subject in the complete canonical release asset inventory`,
      );
    }
    const producerJobResponse = await fetchChecked(
      fetchImpl,
      `${apiRoot}/jobs/${evidence.producerJobId}`,
      { headers },
      `${prefix} producer job`,
      errors,
    );
    const evidenceArtifactResponse = await fetchChecked(
      fetchImpl,
      `${apiRoot}/artifacts/${evidence.evidenceArtifactId}`,
      { headers },
      `${prefix} report artifact`,
      errors,
    );
    const releaseArtifactResponse = await fetchChecked(
      fetchImpl,
      `${apiRoot}/artifacts/${evidence.releaseArtifactId}`,
      { headers },
      `${prefix} release artifact`,
      errors,
    );
    const sourceReportArtifactResponse =
      claimId === "release.signing"
        ? await fetchChecked(
            fetchImpl,
            `${apiRoot}/artifacts/${evidence.sourceReportArtifactId}`,
            { headers },
            `${prefix} source report artifact`,
            errors,
          )
        : null;
    if (
      !producerJobResponse ||
      !evidenceArtifactResponse ||
      !releaseArtifactResponse ||
      (claimId === "release.signing" && !sourceReportArtifactResponse)
    )
      continue;
    let producerJob;
    let evidenceArtifact;
    let releaseArtifact;
    let sourceReportArtifact;
    try {
      [producerJob, evidenceArtifact, releaseArtifact, sourceReportArtifact] =
        await Promise.all([
          producerJobResponse.json(),
          evidenceArtifactResponse.json(),
          releaseArtifactResponse.json(),
          sourceReportArtifactResponse?.json(),
        ]);
    } catch {
      addError(errors, `${prefix} API response was not valid JSON`);
      continue;
    }
    const expectedProducerJobName = machineProducerJobName(
      claimId,
      evidence.platform,
    );
    const exactAttemptProducerJob = exactAttemptJobsById.get(
      evidence.producerJobId,
    );
    const producerStartedMs = canonicalGithubTimestampMs(
      producerJob.started_at,
    );
    const attemptStartedMs = canonicalGithubTimestampMs(
      manifest.runAttemptStartedAt,
    );
    if (
      producerJob.id !== evidence.producerJobId ||
      producerJob.name !== expectedProducerJobName ||
      producerJob.name !== evidence.producerJobName ||
      producerJob.conclusion !== "success" ||
      producerJob.run_attempt !== manifest.runAttempt ||
      evidence.producerJobRunAttempt !== manifest.runAttempt ||
      producerJob.run_url !==
        `https://api.github.com/repos/${repository}/actions/runs/${runId}` ||
      producerJob.head_sha !== releaseCommit ||
      producerStartedMs === null ||
      producerStartedMs < attemptStartedMs ||
      exactAttemptProducerJob?.id !== producerJob.id ||
      exactAttemptProducerJob?.run_attempt !== manifest.runAttempt ||
      exactAttemptProducerJob?.name !== producerJob.name ||
      exactAttemptProducerJob?.conclusion !== "success" ||
      exactAttemptProducerJob?.started_at !== producerJob.started_at ||
      exactAttemptProducerJob?.completed_at !== producerJob.completed_at ||
      !hasCanonicalSuccessfulMachineSteps(claimId, producerJob)
    )
      addError(
        errors,
        `${prefix} producer is not the canonical successful verifier job and step from the current run`,
      );
    if (
      evidenceArtifact.id !== evidence.evidenceArtifactId ||
      evidenceArtifact.name !== evidence.evidenceArtifactName ||
      evidenceArtifact.expired !== false ||
      evidenceArtifact.digest !== `sha256:${evidence.evidenceArtifactSha256}` ||
      evidenceArtifact.workflow_run?.id !== runId ||
      evidenceArtifact.workflow_run?.head_sha !== releaseCommit
    ) {
      addError(
        errors,
        `${prefix} report artifact is not an unexpired digest-bound artifact from the recorded run`,
      );
    }
    if (
      releaseArtifact.id !== evidence.releaseArtifactId ||
      releaseArtifact.name !== evidence.releaseArtifactName ||
      releaseArtifact.expired !== false ||
      releaseArtifact.digest !== `sha256:${evidence.releaseArtifactSha256}` ||
      releaseArtifact.workflow_run?.id !== runId ||
      releaseArtifact.workflow_run?.head_sha !== releaseCommit
    ) {
      addError(
        errors,
        `${prefix} release artifact is not the unexpired ID/name/digest-bound artifact from the current run`,
      );
    }
    if (
      claimId === "release.signing" &&
      !isValidSigningSourceReportArtifact(
        sourceReportArtifact,
        evidence,
        runId,
        releaseCommit,
      )
    )
      addError(
        errors,
        `${prefix} source report artifact is not the unexpired attempt-bound ID/name/archive-digest artifact from the current run`,
      );
    if (claimId === "release.signing") {
      const sourceUploadSteps = asArray(exactAttemptProducerJob?.steps).filter(
        ({ name }) => name === "Upload machine evidence report",
      );
      const sourceUploadStep = sourceUploadSteps[0];
      const sourceCreatedMs = canonicalGithubTimestampMs(
        sourceReportArtifact?.created_at,
      );
      const sourceUpdatedMs = canonicalGithubTimestampMs(
        sourceReportArtifact?.updated_at,
      );
      const sourceUploadStartedMs = canonicalGithubTimestampMs(
        sourceUploadStep?.started_at,
      );
      const sourceUploadCompletedMs = canonicalGithubTimestampMs(
        sourceUploadStep?.completed_at,
      );
      const verifierCompletedMs = canonicalGithubTimestampMs(
        exactAttemptProducerJob?.completed_at,
      );
      if (
        sourceUploadSteps.length !== 1 ||
        sourceUploadStep?.status !== "completed" ||
        sourceUploadStep?.conclusion !== "success" ||
        sourceCreatedMs === null ||
        sourceUpdatedMs === null ||
        sourceUploadStartedMs === null ||
        sourceUploadCompletedMs === null ||
        verifierCompletedMs === null ||
        sourceUploadStartedMs < attemptStartedMs ||
        producerStartedMs > sourceUploadStartedMs ||
        !isArtifactCreationWithinProducerWindow(
          sourceReportArtifact?.created_at,
          sourceUploadStep?.started_at,
          exactAttemptProducerJob?.completed_at,
        ) ||
        sourceUploadStartedMs > sourceUploadCompletedMs ||
        sourceUploadCompletedMs > verifierCompletedMs ||
        sourceCreatedMs > sourceUpdatedMs
      )
        addError(
          errors,
          `${prefix} source report artifact was not created by the successful current-attempt upload step`,
        );
      for (const producer of evidence.artifactProducers) {
        const asset = releaseAssetsByName.get(producer.artifactName);
        const apiArtifact = asset?.apiArtifact;
        const producerJobForAttempt = exactAttemptJobsById.get(
          producer.artifactProducerJobId,
        );
        const uploadSteps = asArray(producerJobForAttempt?.steps).filter(
          ({ name }) => name === producer.artifactUploadStepName,
        );
        const uploadStep = uploadSteps[0];
        const artifactCreatedMs = canonicalGithubTimestampMs(
          apiArtifact?.created_at,
        );
        const uploadStartedMs = canonicalGithubTimestampMs(
          uploadStep?.started_at,
        );
        const uploadCompletedMs = canonicalGithubTimestampMs(
          uploadStep?.completed_at,
        );
        const producerCompletedMs = canonicalGithubTimestampMs(
          producerJobForAttempt?.completed_at,
        );
        if (
          !asset ||
          asset.artifactId !== producer.artifactId ||
          apiArtifact?.id !== producer.artifactId ||
          apiArtifact?.name !== producer.artifactName ||
          apiArtifact?.created_at !== producer.artifactCreatedAt ||
          apiArtifact?.updated_at !== producer.artifactUpdatedAt ||
          producerJobForAttempt?.id !== producer.artifactProducerJobId ||
          producerJobForAttempt?.name !== producer.artifactProducerJobName ||
          producerJobForAttempt?.run_attempt !== manifest.runAttempt ||
          producerJobForAttempt?.run_id !== runId ||
          producerJobForAttempt?.run_url !== `${apiRoot}/runs/${runId}` ||
          producerJobForAttempt?.head_sha !== releaseCommit ||
          producerJobForAttempt?.status !== "completed" ||
          producerJobForAttempt?.conclusion !== "success" ||
          producerJobForAttempt?.started_at !==
            producer.artifactProducerJobStartedAt ||
          producerJobForAttempt?.completed_at !==
            producer.artifactProducerJobCompletedAt ||
          uploadSteps.length !== 1 ||
          uploadStep?.status !== "completed" ||
          uploadStep?.conclusion !== "success" ||
          uploadStep?.started_at !== producer.artifactUploadStepStartedAt ||
          uploadStep?.completed_at !== producer.artifactUploadStepCompletedAt ||
          artifactCreatedMs === null ||
          uploadStartedMs === null ||
          uploadCompletedMs === null ||
          producerCompletedMs === null ||
          !isArtifactCreationWithinProducerWindow(
            apiArtifact?.created_at,
            uploadStep?.started_at,
            producerJobForAttempt?.completed_at,
          ) ||
          uploadStartedMs > uploadCompletedMs
        )
          addError(
            errors,
            `${prefix} release artifact is not bound to its exact current-attempt desktop upload job and step`,
          );
      }
    }
    const subjectPath = resolveContainedRegularFile(root, evidence.subjectPath);
    if (!subjectPath) {
      addError(
        errors,
        `${prefix} downloaded release artifact subject is missing or unsafe: ${evidence.subjectPath}`,
      );
    } else if (sha256(readFileSync(subjectPath)) !== evidence.subjectSha256) {
      addError(
        errors,
        `${prefix} downloaded release artifact subject digest does not match subjectSha256`,
      );
    }
    const reportPath = resolve(root, evidence.reportPath);
    const evidenceRoot = resolve(root, ".release-evidence");
    const safeReportPath = resolveContainedRegularFile(
      root,
      evidence.reportPath,
    );
    if (!isInsideRoot(evidenceRoot, reportPath) || !safeReportPath) {
      addError(
        errors,
        `${prefix} report does not exist at ${evidence.reportPath}`,
      );
      continue;
    }
    const bytes = readFileSync(safeReportPath);
    if (sha256(bytes) !== evidence.reportSha256) {
      addError(errors, `${prefix} report digest does not match reportSha256`);
      continue;
    }
    if (claimId === "release.signing") {
      const bindingRelativePath = `.release-evidence/upload-bindings/${basename(
        evidence.reportPath,
      )}.binding.json`;
      const bindingPath = resolveContainedRegularFile(
        root,
        bindingRelativePath,
      );
      let binding;
      try {
        binding = JSON.parse(readFileSync(bindingPath, "utf8"));
      } catch {
        addError(errors, `${prefix} upload binding is missing or invalid JSON`);
        continue;
      }
      if (
        !isValidSigningUploadBinding(binding, evidence, {
          repository,
          releaseCommit,
          tag,
          triggerRef,
          runId,
          runAttempt: manifest.runAttempt,
        })
      ) {
        addError(
          errors,
          `${prefix} upload binding does not bind the source report bytes, artifact, run, and attempt`,
        );
        continue;
      }
    }
    let report;
    try {
      report = JSON.parse(bytes.toString("utf8"));
    } catch {
      addError(errors, `${prefix} report is not valid JSON`);
      continue;
    }
    let modelDesktopProducerJob = null;
    if (claimId === "models.verified-delivery") {
      if (
        !Number.isSafeInteger(report.desktopProducerJobId) ||
        report.desktopProducerJobId <= 0
      ) {
        addError(
          errors,
          `${prefix} report does not identify the exact desktop producer job`,
        );
      } else {
        const desktopProducerResponse = await fetchChecked(
          fetchImpl,
          `${apiRoot}/jobs/${report.desktopProducerJobId}`,
          { headers },
          `${prefix} desktop producer job`,
          errors,
        );
        if (desktopProducerResponse) {
          try {
            modelDesktopProducerJob = await desktopProducerResponse.json();
          } catch {
            addError(
              errors,
              `${prefix} desktop producer job API response was not valid JSON`,
            );
          }
        }
      }
    }
    const expectedVerifierPath = machineVerifierPath(claimId);
    const expectedVerifierCommand = machineVerifierCommand(
      claimId,
      evidence.platform,
    );
    const verifierPath = resolveContainedRegularFile(
      root,
      expectedVerifierPath,
    );
    if (
      !verifierPath ||
      sha256(readFileSync(verifierPath)) !== evidence.verifierSha256
    )
      addError(
        errors,
        `${prefix} canonical verifier source is missing or does not match verifierSha256`,
      );
    const expectedCheckIds = CANONICAL_MACHINE_EVIDENCE_CHECKS.get(claimId);
    if (
      report.schemaVersion !== 1 ||
      report.generatedBy !== "release-machine-verifier" ||
      report.result !== "pass" ||
      !hasExactPassingMachineChecks(report.checks, expectedCheckIds) ||
      !sameStringSet(evidence.checkIds, expectedCheckIds) ||
      report.claimId !== claimId ||
      report.sourceCommit !== releaseCommit ||
      report.releaseTag !== tag ||
      report.runId !== runId ||
      (claimId === "models.verified-delivery" &&
        (report.runAttempt !== currentRun.run_attempt ||
          report.verifierJobId !== evidence.producerJobId ||
          report.verifierJobId !== producerJob.id ||
          report.verifierJobName !== producerJob.name ||
          report.verifierJobRunAttempt !== currentRun.run_attempt ||
          producerJob.run_attempt !== currentRun.run_attempt)) ||
      report.repository !== repository ||
      report.ref !== triggerRef ||
      report.platform !== evidence.platform ||
      report.releaseArtifactKind !== evidence.releaseArtifactKind ||
      report.releaseArtifactId !== evidence.releaseArtifactId ||
      report.releaseArtifactName !== evidence.releaseArtifactName ||
      report.releaseArtifactSha256 !== evidence.releaseArtifactSha256 ||
      report.subjectName !== evidence.subjectName ||
      report.subjectPath !== evidence.subjectPath ||
      report.subjectSha256 !== evidence.subjectSha256 ||
      (claimId === "release.signing" &&
        (report.runAttempt !== manifest.runAttempt ||
          report.runAttemptStartedAt !== manifest.runAttemptStartedAt ||
          JSON.stringify(report.artifactProducers) !==
            JSON.stringify(evidence.artifactProducers))) ||
      report.producerJobName !== expectedProducerJobName ||
      report.verifierPath !== expectedVerifierPath ||
      report.verifierCommand !== expectedVerifierCommand ||
      report.verifierSha256 !== evidence.verifierSha256
    ) {
      addError(
        errors,
        `${prefix} report is not a passing result bound to the release artifact and commit`,
      );
    }
    if (claimId === "models.verified-delivery") {
      const uploadStep = asArray(modelDesktopProducerJob?.steps).filter(
        (step) => step?.name === "Upload Linux AppImage",
      );
      const packageStep = asArray(modelDesktopProducerJob?.steps).filter(
        (step) => step?.name === "Package Linux desktop app",
      );
      const artifactCreated = Date.parse(releaseArtifact.created_at ?? "");
      const uploadStarted = Date.parse(uploadStep[0]?.started_at ?? "");
      const uploadCompleted = Date.parse(uploadStep[0]?.completed_at ?? "");
      if (
        modelDesktopProducerJob?.id !== report.desktopProducerJobId ||
        modelDesktopProducerJob?.name !== report.desktopProducerJobName ||
        modelDesktopProducerJob?.name !==
          "Desktop — Linux (AppImage + deb + rpm)" ||
        modelDesktopProducerJob?.run_id !== runId ||
        modelDesktopProducerJob?.run_attempt !== currentRun.run_attempt ||
        modelDesktopProducerJob?.head_sha !== releaseCommit ||
        modelDesktopProducerJob?.status !== "completed" ||
        modelDesktopProducerJob?.conclusion !== "success" ||
        packageStep.length !== 1 ||
        packageStep[0]?.conclusion !== "success" ||
        uploadStep.length !== 1 ||
        uploadStep[0]?.conclusion !== "success" ||
        releaseArtifact.id !== report.releaseArtifactId ||
        releaseArtifact.digest !== `sha256:${report.releaseArtifactSha256}` ||
        releaseArtifact.created_at !== report.releaseArtifactCreatedAt ||
        uploadStep[0]?.started_at !== report.desktopUploadStartedAt ||
        uploadStep[0]?.completed_at !== report.desktopUploadCompletedAt ||
        !Number.isSafeInteger(artifactCreated) ||
        !Number.isSafeInteger(uploadStarted) ||
        !Number.isSafeInteger(uploadCompleted) ||
        artifactCreated < uploadStarted ||
        artifactCreated > uploadCompleted
      )
        addError(
          errors,
          `${prefix} AppImage artifact is not bound to its exact-attempt successful producer and upload window`,
        );
    }
    for (const applicabilityError of verifyMachineEvidenceApplicability(
      claimId,
      report,
      [...releaseAssetsByName.values()],
      manifest.verificationAssets,
    ))
      addError(errors, `${prefix} ${applicabilityError}`);
    if (claimId === "release.artifact-verification") {
      for (const materialError of await verifyArtifactVerificationMaterials(
        {
          root,
          manifest,
          report,
          repository,
          releaseCommit,
          triggerRef,
          githubToken,
        },
        attestationVerifier,
      ))
        addError(errors, `${prefix} ${materialError}`);
    }
  }
  return errors;
}

export function runChecks({
  root,
  ledgerPath = DEFAULT_LEDGER_PATH,
  requireReady = false,
  tag = null,
  externalEvidenceVerified = false,
}) {
  const absoluteRoot = realpathSync(resolve(root));
  const absoluteLedger = resolve(absoluteRoot, ledgerPath);
  if (!isInsideRoot(absoluteRoot, absoluteLedger)) {
    return {
      ledger: null,
      errors: [`claim ledger escapes repository root: ${ledgerPath}`],
    };
  }
  if (!existsSync(absoluteLedger)) {
    return {
      ledger: null,
      errors: [`claim ledger does not exist: ${ledgerPath}`],
    };
  }
  const safeLedgerPath = resolveContainedRegularFile(absoluteRoot, ledgerPath);
  if (!safeLedgerPath) {
    return {
      ledger: null,
      errors: [
        `claim ledger must be a real, regular, non-symlink repository file: ${ledgerPath}`,
      ],
    };
  }

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(safeLedgerPath, "utf8"));
  } catch (error) {
    return {
      ledger: null,
      errors: [
        `claim ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const errors = [
    ...validateLedgerShape(ledger, absoluteRoot, ledgerPath),
    ...verifyVersionSources(ledger, absoluteRoot),
    ...verifyReleaseVersionBinding(ledger, absoluteRoot, {
      tag,
      requireReady,
    }),
    ...verifyRequiredSurfaceCoverage(ledger, absoluteRoot),
    ...verifyCanonicalReleasePublisher(absoluteRoot),
    ...verifyApprovedStatements(ledger, absoluteRoot),
    ...scanProhibitedClaims(ledger, absoluteRoot),
  ];
  if (requireReady && ledger?.release?.status !== "ready") {
    errors.push(
      `release publication requires ledger status ready; found ${ledger?.release?.status ?? "missing"}`,
    );
  }
  if (requireReady && !externalEvidenceVerified) {
    errors.push(
      "release publication evidence was not externally verified; use the publication CLI gate",
    );
  }
  return { ledger, errors };
}

export function runPublicationPreflight(options) {
  const result = runChecks({
    ...options,
    requireReady: true,
    externalEvidenceVerified: true,
  });
  if (!GITHUB_REPOSITORY.test(options.repository ?? ""))
    result.errors.push(
      "release publication requires --repository owner/repository",
    );
  if (!COMMIT_SHA.test(options.commit ?? ""))
    result.errors.push(
      "release publication requires --commit with a lowercase 40-character commit SHA",
    );
  if (!Number.isSafeInteger(options.runId) || options.runId <= 0)
    result.errors.push(
      "release publication requires --run-id with the current workflow run ID",
    );
  if (options.ref !== `refs/tags/${options.tag}`)
    result.errors.push(
      `release publication requires --ref refs/tags/${options.tag}`,
    );
  return result;
}

export async function runPublicationChecks(options) {
  const result = runPublicationPreflight(options);
  if (result.errors.length > 0 || !result.ledger) return result;
  const manifestPath = resolve(
    options.root,
    options.evidenceManifestPath ?? "",
  );
  const safeManifestPath = isNonEmptyString(options.evidenceManifestPath)
    ? resolveContainedRegularFile(options.root, options.evidenceManifestPath)
    : null;
  if (
    !isNonEmptyString(options.evidenceManifestPath) ||
    !isInsideRoot(resolve(options.root), manifestPath) ||
    !safeManifestPath
  ) {
    return {
      ...result,
      errors: [
        ...result.errors,
        "final release publication requires an existing --evidence-manifest file",
      ],
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(safeManifestPath, "utf8"));
  } catch (error) {
    return {
      ...result,
      errors: [
        ...result.errors,
        `release evidence manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const evidenceErrors = await verifyPublicationEvidence(
    result.ledger,
    manifest,
    {
      root: resolve(options.root),
      repository: options.repository,
      releaseCommit: options.commit,
      tag: options.tag,
      runId: options.runId,
      triggerRef: options.ref,
      githubToken: options.githubToken ?? process.env.GITHUB_TOKEN,
      fetchImpl: options.fetchImpl,
    },
  );
  return { ...result, errors: [...result.errors, ...evidenceErrors] };
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    ledgerPath: DEFAULT_LEDGER_PATH,
    requireReady: false,
    tag: null,
    commit: null,
    repository: null,
    evidenceManifestPath: null,
    preflight: false,
    runId: null,
    ref: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    else if (argv[index] === "--root") args.root = argv[++index];
    else if (argv[index] === "--ledger") args.ledgerPath = argv[++index];
    else if (argv[index] === "--require-ready") args.requireReady = true;
    else if (argv[index] === "--tag") args.tag = argv[++index];
    else if (argv[index] === "--commit") args.commit = argv[++index];
    else if (argv[index] === "--repository") args.repository = argv[++index];
    else if (argv[index] === "--run-id") {
      const value = argv[++index];
      args.runId = /^[1-9][0-9]*$/.test(value ?? "") ? Number(value) : null;
    } else if (argv[index] === "--ref") args.ref = argv[++index];
    else if (argv[index] === "--evidence-manifest")
      args.evidenceManifestPath = argv[++index];
    else if (argv[index] === "--preflight") args.preflight = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = args.requireReady
      ? args.preflight
        ? runPublicationPreflight(args)
        : await runPublicationChecks(args)
      : runChecks(args);
    if (result.errors.length > 0) {
      console.error(
        `Release claim check failed with ${result.errors.length} error(s):`,
      );
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      console.log(
        `Release claim check passed: ${result.ledger.claims.length} claims, target ${result.ledger.release.targetVersion} (${result.ledger.release.status}).`,
      );
    }
  } catch (error) {
    console.error(
      `Release claim check could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
