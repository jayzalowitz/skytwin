#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CANONICAL_CI_EVIDENCE_CHECKS,
  CANONICAL_MACHINE_EVIDENCE_CHECKS,
  CANONICAL_RELEASE_ASSETS,
  machineReportNamesForClaim,
} from "./release-constants.mjs";

const [ledgerPath, reportsDirectory, outputPath] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const releaseCommit = process.env.GITHUB_SHA;
const tag = process.env.GITHUB_REF_NAME;
const ref = process.env.GITHUB_REF;
const token = process.env.GITHUB_TOKEN;
const runId = Number(process.env.GITHUB_RUN_ID);

if (!ledgerPath || !reportsDirectory || !outputPath)
  throw new Error(
    "usage: generate-evidence-manifest.mjs LEDGER REPORTS_DIRECTORY OUTPUT",
  );
if (!repository || !releaseCommit || !tag || !ref || !token || !runId)
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
  run.repository?.full_name !== repository
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
      if (!lstatSync(path).isFile())
        throw new Error(`${path} is not a regular release subject`);
      return {
        name: entry.name,
        path,
        sha256: digestOf(path),
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

const evidence = [];
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
      ref,
      evidenceArtifactId: machineArtifact.id,
      evidenceArtifactName: machineArtifact.name,
      evidenceArtifactSha256: String(machineArtifact.digest).replace(
        /^sha256:/,
        "",
      ),
      reportPath: `.release-evidence/reports/${reportName}`,
      reportSha256: digestOf(reportPath),
      sourceCommit: releaseCommit,
      releaseTag: tag,
      platform: report.platform,
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
      releaseAssets,
      evidence,
    },
    null,
    2,
  )}\n`,
);
