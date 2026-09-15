import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const POLICY_PATH = fileURLToPath(
  new URL("./dependency-audit-policy.json", import.meta.url),
);

const AUDIT_SCOPES = Object.freeze({
  production: ["audit", "--prod", "--json"],
  development: ["audit", "--dev", "--json"],
});

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseStrictUtcDate(value, label) {
  invariant(
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
    `${label} must be YYYY-MM-DD`,
  );
  const timestamp = `${value}T00:00:00.000Z`;
  const date = new Date(timestamp);
  invariant(
    !Number.isNaN(date.valueOf()) && date.toISOString() === timestamp,
    `${label} must be a real calendar date`,
  );
  return date;
}

function parsePackageSegment(segment) {
  const delimiter = segment.lastIndexOf("@");
  invariant(
    delimiter > 0,
    `audit path segment lacks an exact version: ${segment}`,
  );
  return {
    package: segment.slice(0, delimiter),
    version: segment.slice(delimiter + 1),
  };
}

function validatePath(path, constraint, ghsa) {
  invariant(
    typeof path === "string" && path.length > 0,
    `${ghsa} has an empty audit path`,
  );
  const segments = path.split(" > ");
  invariant(
    segments[0] === constraint.rootImporter,
    `${ghsa} escaped allowed importer ${constraint.rootImporter}: ${path}`,
  );
  invariant(
    segments.length > constraint.requiredSuffix.length,
    `${ghsa} audit path is shorter than its required suffix: ${path}`,
  );
  const suffix = segments
    .slice(-constraint.requiredSuffix.length)
    .map(parsePackageSegment);
  invariant(
    suffix.every(
      (segment, index) =>
        segment.package === constraint.requiredSuffix[index]?.package &&
        segment.version === constraint.requiredSuffix[index]?.version,
    ),
    `${ghsa} escaped its allowed dependency suffix: ${path}`,
  );
}

function severityCounts(advisories) {
  const counts = Object.fromEntries(
    SEVERITIES.map((severity) => [severity, 0]),
  );
  for (const advisory of advisories) {
    invariant(
      SEVERITIES.includes(advisory.severity),
      `unknown severity ${String(advisory.severity)}`,
    );
    counts[advisory.severity] += 1;
  }
  return counts;
}

export function loadDependencyAuditPolicy(path = POLICY_PATH) {
  const policy = JSON.parse(readFileSync(path, "utf8"));
  invariant(
    policy.schemaVersion === 1,
    "dependency audit policy must use schemaVersion 1",
  );
  parseStrictUtcDate(policy.expiresOn, "policy expiresOn");
  invariant(
    Array.isArray(policy.advisories),
    "policy advisories must be an array",
  );

  const identities = new Set();
  for (const entry of policy.advisories) {
    invariant(
      Object.hasOwn(AUDIT_SCOPES, entry.scope),
      `unsupported audit scope ${String(entry.scope)}`,
    );
    invariant(
      /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry.ghsa),
      "invalid GHSA",
    );
    invariant(
      /^CVE-\d{4}-\d+$/.test(entry.cve),
      `${entry.ghsa} has invalid CVE`,
    );
    invariant(
      typeof entry.package === "string" && entry.package.length > 0,
      `${entry.ghsa} lacks package`,
    );
    invariant(
      typeof entry.version === "string" && entry.version.length > 0,
      `${entry.ghsa} lacks version`,
    );
    invariant(
      SEVERITIES.includes(entry.severity),
      `${entry.ghsa} has invalid severity`,
    );
    invariant(
      typeof entry.title === "string" && entry.title.length > 0,
      `${entry.ghsa} lacks title`,
    );
    invariant(
      typeof entry.vulnerableVersions === "string" &&
        entry.vulnerableVersions.length > 0,
      `${entry.ghsa} lacks vulnerable versions`,
    );
    invariant(
      typeof entry.patchedVersions === "string" &&
        entry.patchedVersions.length > 0,
      `${entry.ghsa} lacks patched versions`,
    );
    invariant(
      typeof entry.recommendation === "string" &&
        entry.recommendation.length > 0,
      `${entry.ghsa} lacks recommendation`,
    );
    invariant(
      entry.cvss &&
        typeof entry.cvss === "object" &&
        !Array.isArray(entry.cvss) &&
        Object.keys(entry.cvss).length === 2 &&
        Object.hasOwn(entry.cvss, "score") &&
        Object.hasOwn(entry.cvss, "vectorString") &&
        Number.isFinite(entry.cvss.score) &&
        entry.cvss.score >= 0 &&
        entry.cvss.score <= 10 &&
        (entry.cvss.vectorString === null ||
          (typeof entry.cvss.vectorString === "string" &&
            entry.cvss.vectorString.length > 0)),
      `${entry.ghsa} lacks valid CVSS metadata`,
    );
    invariant(
      Array.isArray(entry.cwes) &&
        entry.cwes.length > 0 &&
        entry.cwes.every((cwe) => /^CWE-\d+$/.test(cwe)),
      `${entry.ghsa} lacks valid CWE metadata`,
    );
    invariant(
      entry.advisoryUrl === `https://github.com/advisories/${entry.ghsa}`,
      `${entry.ghsa} advisory URL drifted`,
    );
    invariant(
      /^https:\/\/github\.com\//.test(entry.upstreamTracking),
      `${entry.ghsa} lacks HTTPS upstream tracking`,
    );
    invariant(
      entry.expiresOn === policy.expiresOn,
      `${entry.ghsa} expiry must match the policy review date`,
    );
    invariant(
      typeof entry.rationale === "string" && entry.rationale.length >= 40,
      `${entry.ghsa} lacks rationale`,
    );
    invariant(
      typeof entry.pathConstraint?.rootImporter === "string" &&
        Array.isArray(entry.pathConstraint?.requiredSuffix) &&
        entry.pathConstraint.requiredSuffix.length > 0,
      `${entry.ghsa} lacks a dependency path constraint`,
    );
    invariant(
      !identities.has(entry.ghsa),
      `duplicate policy advisory ${entry.ghsa}`,
    );
    identities.add(entry.ghsa);
  }
  return policy;
}

export function validateDependencyAuditReport({
  report,
  scope,
  policy,
  now = new Date(),
}) {
  invariant(
    Object.hasOwn(AUDIT_SCOPES, scope),
    `unsupported audit scope ${scope}`,
  );
  const expiration = parseStrictUtcDate(policy.expiresOn, "policy expiration");
  invariant(
    now < expiration,
    `dependency advisory policy expired on ${policy.expiresOn}`,
  );
  invariant(
    report && typeof report === "object" && !Array.isArray(report),
    `${scope} audit did not return an object`,
  );
  invariant(
    !Object.hasOwn(report, "error"),
    `${scope} audit registry returned an error`,
  );
  invariant(
    report.advisories &&
      typeof report.advisories === "object" &&
      !Array.isArray(report.advisories),
    `${scope} audit omitted advisories`,
  );
  invariant(
    report.metadata?.vulnerabilities &&
      typeof report.metadata.vulnerabilities === "object" &&
      !Array.isArray(report.metadata.vulnerabilities),
    `${scope} audit omitted vulnerability metadata`,
  );

  const actual = Object.values(report.advisories);
  const expected = policy.advisories.filter((entry) => entry.scope === scope);
  const actualByGhsa = new Map();
  for (const advisory of actual) {
    const ghsa = advisory.github_advisory_id;
    invariant(
      typeof ghsa === "string",
      `${scope} advisory omitted github_advisory_id`,
    );
    invariant(!actualByGhsa.has(ghsa), `${scope} audit duplicated ${ghsa}`);
    actualByGhsa.set(ghsa, advisory);
  }
  invariant(
    actualByGhsa.size === expected.length,
    `${scope} audit advisory count changed: expected ${expected.length}, received ${actualByGhsa.size}`,
  );

  for (const entry of expected) {
    invariant(
      entry.expiresOn === policy.expiresOn,
      `${entry.ghsa} expiry must match the policy review date`,
    );
    const entryExpiration = parseStrictUtcDate(
      entry.expiresOn,
      `${entry.ghsa} expiration`,
    );
    invariant(
      now < entryExpiration,
      `${entry.ghsa} exception expired on ${entry.expiresOn}`,
    );
    const advisory = actualByGhsa.get(entry.ghsa);
    invariant(
      advisory,
      `${scope} audit no longer reports expected ${entry.ghsa}; remove or revise its exception`,
    );
    invariant(
      advisory.module_name === entry.package,
      `${entry.ghsa} package changed`,
    );
    invariant(
      advisory.severity === entry.severity,
      `${entry.ghsa} severity changed`,
    );
    invariant(advisory.title === entry.title, `${entry.ghsa} title changed`);
    invariant(advisory.url === entry.advisoryUrl, `${entry.ghsa} URL changed`);
    invariant(
      advisory.vulnerable_versions === entry.vulnerableVersions,
      `${entry.ghsa} vulnerable versions changed`,
    );
    invariant(
      advisory.patched_versions === entry.patchedVersions,
      `${entry.ghsa} patched versions changed`,
    );
    invariant(
      advisory.recommendation === entry.recommendation,
      `${entry.ghsa} recommendation changed`,
    );
    invariant(
      advisory.cvss &&
        typeof advisory.cvss === "object" &&
        !Array.isArray(advisory.cvss) &&
        Object.keys(advisory.cvss).length === 2 &&
        Object.hasOwn(advisory.cvss, "score") &&
        Object.hasOwn(advisory.cvss, "vectorString") &&
        advisory.cvss.score === entry.cvss.score &&
        advisory.cvss.vectorString === entry.cvss.vectorString,
      `${entry.ghsa} CVSS metadata changed`,
    );
    invariant(
      Array.isArray(advisory.cwe) &&
        advisory.cwe.length === entry.cwes.length &&
        advisory.cwe.every((cwe, index) => cwe === entry.cwes[index]),
      `${entry.ghsa} CWE metadata changed`,
    );
    invariant(
      Array.isArray(advisory.cves) &&
        advisory.cves.length === 1 &&
        advisory.cves[0] === entry.cve,
      `${entry.ghsa} CVE changed`,
    );
    invariant(
      Array.isArray(advisory.findings) && advisory.findings.length === 1,
      `${entry.ghsa} findings changed`,
    );
    const finding = advisory.findings[0];
    invariant(
      finding.version === entry.version,
      `${entry.ghsa} version changed`,
    );
    invariant(
      Array.isArray(finding.paths) && finding.paths.length > 0,
      `${entry.ghsa} has no dependency paths`,
    );
    for (const path of finding.paths)
      validatePath(path, entry.pathConstraint, entry.ghsa);
  }

  const expectedCounts = severityCounts(actual);
  for (const severity of SEVERITIES) {
    invariant(
      report.metadata.vulnerabilities[severity] === expectedCounts[severity],
      `${scope} audit ${severity} metadata does not match advisory records`,
    );
  }
  return { scope, advisories: actualByGhsa.size };
}

export function parseAuditCommandResult({ scope, result, policy, now }) {
  const stderr = String(result.stderr ?? "");
  invariant(
    !result.error,
    `${scope} audit tool failed to start: ${result.error?.message ?? "unknown error"}`,
  );
  invariant(
    result.signal === null,
    `${scope} audit tool terminated via ${String(result.signal)}`,
  );
  invariant(
    result.status === 0 || result.status === 1,
    `${scope} audit tool exited ${String(result.status)}: ${stderr.trim()}`,
  );
  invariant(
    !/(?:ERR_PNPM|ECONN|ENOTFOUND|ETIMEDOUT|registry[^\n]*(?:error|fail|unavailable)|audit endpoint[^\n]*(?:error|fail))/i.test(
      stderr,
    ),
    `${scope} audit reported a registry or tool error: ${stderr.trim()}`,
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${scope} audit returned invalid JSON: ${stderr.trim()}`);
  }
  const validation = validateDependencyAuditReport({
    report,
    scope,
    policy,
    now,
  });
  const hasAdvisories = validation.advisories > 0;
  invariant(
    result.status === (hasAdvisories ? 1 : 0),
    `${scope} audit exit status disagrees with its advisory report`,
  );
  return validation;
}

export function runDependencyAudit({
  policy = loadDependencyAuditPolicy(),
  now = new Date(),
} = {}) {
  const pnpmEntry = process.env.npm_execpath;
  invariant(
    typeof pnpmEntry === "string" && isAbsolute(pnpmEntry),
    "run through `pnpm audit:check` so the repository-pinned pnpm entry is explicit",
  );
  const results = [];
  for (const [scope, args] of Object.entries(AUDIT_SCOPES)) {
    const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
      shell: false,
    });
    results.push(parseAuditCommandResult({ scope, result, policy, now }));
  }
  return results;
}

function main() {
  const results = runDependencyAudit();
  for (const result of results) {
    console.log(
      `[dependency-audit] ${result.scope}: ${result.advisories} reviewed advisory record(s)`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `[dependency-audit] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
