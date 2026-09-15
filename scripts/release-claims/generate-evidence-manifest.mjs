#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ARTIFACT_VERIFICATION_DIRECTORY,
  CANONICAL_ARTIFACT_VERIFICATION_ASSETS,
  CANONICAL_CI_EVIDENCE_CHECKS,
  CANONICAL_MACHINE_EVIDENCE_CHECKS,
  CANONICAL_RELEASE_ASSETS,
  machineProducerJobName,
  machineReportNamesForClaim,
} from "./release-constants.mjs";

const [ledgerPath, reportsDirectory, outputPath] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const releaseCommit = process.env.GITHUB_SHA;
const tag = process.env.GITHUB_REF_NAME;
const ref = process.env.GITHUB_REF;
const token = process.env.GITHUB_TOKEN;
const runId = Number(process.env.GITHUB_RUN_ID);
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);

if (!ledgerPath || !reportsDirectory || !outputPath)
  throw new Error(
    "usage: generate-evidence-manifest.mjs LEDGER REPORTS_DIRECTORY OUTPUT",
  );
if (
  !repository ||
  !releaseCommit ||
  !tag ||
  !ref ||
  !token ||
  !runId ||
  !Number.isSafeInteger(runAttempt) ||
  runAttempt <= 0
)
  throw new Error("GitHub release context and GITHUB_TOKEN are required");
if (ref !== `refs/tags/${tag}`)
  throw new Error(`expected tag ref refs/tags/${tag}, got ${ref}`);

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function getJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function oneBy(items, field, value, description) {
  const matches = items.filter((item) => item?.[field] === value);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one ${description} with ${field}=${value}; found ${matches.length}`,
    );
  return matches[0];
}

function digestOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ledger = JSON.parse(readFileSync(resolve(ledgerPath), "utf8"));
const apiRoot = `https://api.github.com/repos/${repository}/actions`;
const [run, jobsPage, artifactsPage] = await Promise.all([
  getJson(`${apiRoot}/runs/${runId}`),
  getJson(`${apiRoot}/runs/${runId}/jobs?per_page=100`),
  getJson(`${apiRoot}/runs/${runId}/artifacts?per_page=100`),
]);
if (
  run.id !== runId ||
  run.event !== "push" ||
  run.head_branch !== tag ||
  run.head_sha !== releaseCommit ||
  run.path !== ".github/workflows/build.yml" ||
  run.repository?.full_name !== repository ||
  run.run_attempt !== runAttempt
)
  throw new Error("current run is not the expected tag-push build workflow");
if (jobsPage.total_count > jobsPage.jobs.length)
  throw new Error("job result is paginated; refusing an incomplete manifest");
if (artifactsPage.total_count > artifactsPage.artifacts.length)
  throw new Error(
    "artifact result is paginated; refusing an incomplete manifest",
  );

const ciJob = oneBy(jobsPage.jobs, "name", "release-claim-ci", "CI job");
if (ciJob.conclusion !== "success")
  throw new Error("CI evidence job did not pass");
const ciArtifact = oneBy(
  artifactsPage.artifacts,
  "name",
  "release-claims-ci",
  "CI evidence artifact",
);
const machineArtifact = oneBy(
  artifactsPage.artifacts,
  "name",
  "release-evidence",
  "machine evidence artifact",
);

const releaseAssets = CANONICAL_RELEASE_ASSETS.map(([artifactName, kind]) => {
  const artifact = oneBy(
    artifactsPage.artifacts,
    "name",
    artifactName,
    `published release artifact ${artifactName}`,
  );
  const directory = join("artifacts", artifactName);
  const subjects = readdirSync(directory, { withFileTypes: true }).map(
    (entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error(
          `${directory} must contain only direct regular-file release subjects`,
        );
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (!stat.isFile())
        throw new Error(`${path} is not a regular release subject`);
      return {
        name: entry.name,
        path,
        sha256: digestOf(path),
        sizeBytes: stat.size,
      };
    },
  );
  if (subjects.length === 0)
    throw new Error(`${directory} contains no published release subjects`);
  return {
    artifactId: artifact.id,
    artifactName,
    artifactSha256: String(artifact.digest).replace(/^sha256:/, ""),
    kind,
    subjects,
  };
});

const canonicalVerificationAssets = new Map(
  CANONICAL_ARTIFACT_VERIFICATION_ASSETS,
);
const verificationDirectory = resolve(ARTIFACT_VERIFICATION_DIRECTORY);
const verificationDirectoryStat = lstatSync(verificationDirectory);
if (
  verificationDirectoryStat.isSymbolicLink() ||
  !verificationDirectoryStat.isDirectory()
)
  throw new Error(
    `${ARTIFACT_VERIFICATION_DIRECTORY} must be a real directory`,
  );
const verificationAssets = readdirSync(verificationDirectory, {
  withFileTypes: true,
}).map((entry) => {
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(
      `${ARTIFACT_VERIFICATION_DIRECTORY} must contain only direct regular files`,
    );
  const canonicalKind = canonicalVerificationAssets.get(entry.name);
  const kind =
    canonicalKind ??
    (/^[a-f0-9]{64}\.attestation\.jsonl$/.test(entry.name)
      ? "provenance-bundle"
      : null);
  if (!kind)
    throw new Error(`unexpected artifact-verification material: ${entry.name}`);
  const path = join(ARTIFACT_VERIFICATION_DIRECTORY, entry.name);
  if (!lstatSync(path).isFile())
    throw new Error(`${path} is not a regular verification material`);
  return {
    kind,
    name: entry.name,
    path,
    sha256: digestOf(path),
  };
});
for (const [name] of CANONICAL_ARTIFACT_VERIFICATION_ASSETS) {
  if (!verificationAssets.some((asset) => asset.name === name))
    throw new Error(`missing artifact-verification material: ${name}`);
}
if (!verificationAssets.some((asset) => asset.kind === "provenance-bundle"))
  throw new Error("artifact-verification provenance bundles are missing");

const evidence = [];
const signingBindingsDirectory = join(
  dirname(reportsDirectory),
  "upload-bindings",
);
for (const readiness of ledger.release.readinessClaims) {
  for (const kind of readiness.requiredEvidenceKinds) {
    if (kind === "source") continue;
    if (kind === "ci") {
      evidence.push({
        claimId: readiness.claimId,
        kind,
        checkIds: CANONICAL_CI_EVIDENCE_CHECKS.get(readiness.claimId),
        repository,
        runId,
        runAttempt,
        ref,
        jobId: ciJob.id,
        jobName: ciJob.name,
        artifactId: ciArtifact.id,
        artifactName: ciArtifact.name,
        artifactSha256: String(ciArtifact.digest).replace(/^sha256:/, ""),
        reportPath: "artifacts/release-claims-ci/result.json",
        reportSha256: digestOf("artifacts/release-claims-ci/result.json"),
        commitSha: releaseCommit,
        conclusion: ciJob.conclusion,
        why: "Current tag-push CI result and its immutable evidence artifact",
      });
      continue;
    }

    const reportNames = machineReportNamesForClaim(readiness.claimId);
    for (const reportName of reportNames) {
      const reportPath = join(reportsDirectory, reportName);
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      let signingBinding = null;
      if (readiness.claimId === "release.signing") {
        const bindingPath = join(
          signingBindingsDirectory,
          `${reportName}.binding.json`,
        );
        signingBinding = JSON.parse(readFileSync(bindingPath, "utf8"));
        const expectedPlatform = reportName.split(".").at(-2);
        const expectedBindingKeys = [
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
          "reportName",
          "reportSha256",
          "sourceArtifactId",
          "sourceArtifactName",
          "sourceArtifactSha256",
        ].sort();
        if (
          JSON.stringify(Object.keys(signingBinding).sort()) !==
            JSON.stringify(expectedBindingKeys) ||
          signingBinding.schemaVersion !== 1 ||
          signingBinding.generatedBy !== "release-signing-upload-verifier" ||
          signingBinding.claimId !== "release.signing" ||
          signingBinding.platform !== expectedPlatform ||
          signingBinding.repository !== repository ||
          signingBinding.sourceCommit !== releaseCommit ||
          signingBinding.releaseTag !== tag ||
          signingBinding.ref !== ref ||
          signingBinding.runId !== runId ||
          signingBinding.runAttempt !== runAttempt ||
          signingBinding.reportName !== reportName ||
          signingBinding.reportSha256 !== digestOf(reportPath) ||
          !Number.isSafeInteger(signingBinding.sourceArtifactId) ||
          signingBinding.sourceArtifactId <= 0 ||
          signingBinding.sourceArtifactName !==
            `release-signing-report-${expectedPlatform}-attempt-${runAttempt}` ||
          !/^[0-9a-f]{64}$/.test(signingBinding.sourceArtifactSha256 ?? "")
        )
          throw new Error(
            `release signing upload binding is invalid for ${reportName}`,
          );
        const sourceArtifact = oneBy(
          artifactsPage.artifacts,
          "id",
          signingBinding.sourceArtifactId,
          `source signing report artifact for ${reportName}`,
        );
        if (
          sourceArtifact.name !== signingBinding.sourceArtifactName ||
          sourceArtifact.digest !==
            `sha256:${signingBinding.sourceArtifactSha256}` ||
          sourceArtifact.expired !== false ||
          sourceArtifact.workflow_run?.id !== runId ||
          sourceArtifact.workflow_run?.head_sha !== releaseCommit
        )
          throw new Error(
            `source signing report artifact is invalid for ${reportName}`,
          );
      }
      const producerJobName = machineProducerJobName(
        readiness.claimId,
        report.platform,
      );
      const producerJob = oneBy(
        jobsPage.jobs,
        "name",
        producerJobName,
        `machine evidence producer job for ${readiness.claimId}`,
      );
      if (producerJob.conclusion !== "success")
        throw new Error(
          `machine evidence producer job did not pass for ${readiness.claimId}`,
        );
      const releaseArtifact = oneBy(
        artifactsPage.artifacts,
        "id",
        report.releaseArtifactId,
        `release artifact for ${readiness.claimId}`,
      );
      evidence.push({
        claimId: readiness.claimId,
        kind,
        checkIds: CANONICAL_MACHINE_EVIDENCE_CHECKS.get(readiness.claimId),
        repository,
        runId,
        runAttempt,
        ref,
        evidenceArtifactId: machineArtifact.id,
        evidenceArtifactName: machineArtifact.name,
        evidenceArtifactSha256: String(machineArtifact.digest).replace(
          /^sha256:/,
          "",
        ),
        reportPath: `.release-evidence/reports/${reportName}`,
        reportSha256: digestOf(reportPath),
        ...(signingBinding
          ? {
              sourceReportArtifactId: signingBinding.sourceArtifactId,
              sourceReportArtifactName: signingBinding.sourceArtifactName,
              sourceReportArtifactSha256: signingBinding.sourceArtifactSha256,
            }
          : {}),
        sourceCommit: releaseCommit,
        releaseTag: tag,
        platform: report.platform,
        producerJobId: producerJob.id,
        producerJobName: producerJob.name,
        producerJobConclusion: producerJob.conclusion,
        verifierPath: report.verifierPath,
        verifierCommand: report.verifierCommand,
        verifierSha256: report.verifierSha256,
        releaseArtifactKind: report.releaseArtifactKind,
        releaseArtifactId: releaseArtifact.id,
        releaseArtifactName: releaseArtifact.name,
        releaseArtifactSha256: String(releaseArtifact.digest).replace(
          /^sha256:/,
          "",
        ),
        subjectName: report.subjectName,
        subjectPath: `artifacts/${releaseArtifact.name}/${report.subjectName}`,
        subjectSha256: report.subjectSha256,
        why: "Machine report bound to an immutable release artifact from this run",
      });
    }
  }
}

writeFileSync(
  resolve(outputPath),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      repository,
      releaseCommit,
      tag,
      ref,
      runId,
      runAttempt,
      releaseAssets,
      verificationAssets,
      evidence,
    },
    null,
    2,
  )}\n`,
);
