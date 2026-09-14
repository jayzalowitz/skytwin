#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const READ_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function matchesPolicy(pattern, value) {
  const expression = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");
  return new RegExp(`^${expression}$`).test(value);
}

async function fetchJson(fetchImpl, url, headers, label, requestTimeoutMs) {
  let lastError;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok)
        throw new Error(`${label} returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `${label} failed after ${READ_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export async function verifyReleaseEnvironment({
  repository,
  environment = "release-publication",
  tag,
  token,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  if (!repository || !environment || !tag || !token)
    throw new Error("GitHub release environment context is required");

  const headers = githubHeaders(token);
  const api = `https://api.github.com/repos/${repository}/environments/${encodeURIComponent(environment)}`;
  const configuration = await fetchJson(
    fetchImpl,
    api,
    headers,
    "release environment lookup",
    requestTimeoutMs,
  );
  const reviewerRule = configuration?.protection_rules?.find(
    (rule) => rule?.type === "required_reviewers",
  );
  if (
    !Array.isArray(reviewerRule?.reviewers) ||
    reviewerRule.reviewers.length < 1
  )
    throw new Error("release environment must require at least one reviewer");
  if (reviewerRule.prevent_self_review !== true)
    throw new Error("release environment must prevent self-review");
  if (configuration?.can_admins_bypass !== false)
    throw new Error("release environment must disable administrator bypass");
  if (configuration?.deployment_branch_policy?.custom_branch_policies !== true)
    throw new Error("release environment must use custom deployment policies");

  const policies = await fetchJson(
    fetchImpl,
    `${api}/deployment-branch-policies?per_page=100`,
    headers,
    "release environment deployment-policy lookup",
    requestTimeoutMs,
  );
  if (
    !Array.isArray(policies?.branch_policies) ||
    !policies.branch_policies.some(
      (policy) =>
        policy?.type === "tag" &&
        typeof policy.name === "string" &&
        matchesPolicy(policy.name, tag),
    )
  )
    throw new Error(
      `release environment has no tag deployment policy matching ${tag}`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyReleaseEnvironment({
    repository: process.env.GITHUB_REPOSITORY,
    environment: process.env.RELEASE_ENVIRONMENT ?? "release-publication",
    tag: process.env.GITHUB_REF_NAME,
    token: process.env.GITHUB_TOKEN,
  });
}
