import { describe, expect, it } from "vitest";
import {
  loadDependencyAuditPolicy,
  parseAuditCommandResult,
  validateDependencyAuditReport,
} from "./check-dependency-audit.mjs";

const policy = loadDependencyAuditPolicy();
const beforeExpiry = new Date("2026-10-14T23:59:59.000Z");

function advisoryFromPolicy(entry) {
  const suffix = entry.pathConstraint.requiredSuffix
    .map((segment) => `${segment.package}@${segment.version}`)
    .join(" > ");
  return {
    github_advisory_id: entry.ghsa,
    module_name: entry.package,
    severity: entry.severity,
    title: entry.title,
    url: entry.advisoryUrl,
    vulnerable_versions: entry.vulnerableVersions,
    patched_versions: entry.patchedVersions,
    recommendation: entry.recommendation,
    cvss: clone(entry.cvss),
    cwe: clone(entry.cwes),
    cves: [entry.cve],
    findings: [
      {
        version: entry.version,
        paths: [
          `${entry.pathConstraint.rootImporter} > fixture-parent@1.0.0 > ${suffix}`,
        ],
      },
    ],
  };
}

function reportFor(scope) {
  const advisories = Object.fromEntries(
    policy.advisories
      .filter((entry) => entry.scope === scope)
      .map((entry, index) => [String(index + 1), advisoryFromPolicy(entry)]),
  );
  const vulnerabilities = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  for (const advisory of Object.values(advisories))
    vulnerabilities[advisory.severity] += 1;
  return { advisories, metadata: { vulnerabilities } };
}

function clone(value) {
  return structuredClone(value);
}

describe("dependency advisory policy", () => {
  it("accepts the exact reviewed production and empty development reports", () => {
    expect(
      validateDependencyAuditReport({
        report: reportFor("production"),
        scope: "production",
        policy,
        now: beforeExpiry,
      }),
    ).toEqual({ scope: "production", advisories: 3 });
    expect(
      validateDependencyAuditReport({
        report: reportFor("development"),
        scope: "development",
        policy,
        now: beforeExpiry,
      }),
    ).toEqual({ scope: "development", advisories: 0 });
  });

  it.each([
    ["module_name", "other-package"],
    ["severity", "critical"],
    ["title", "changed title"],
    ["url", "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx"],
  ])("rejects changed advisory %s metadata", (field, value) => {
    const report = reportFor("production");
    report.advisories["1"][field] = value;
    expect(() =>
      validateDependencyAuditReport({
        report,
        scope: "production",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow();
  });

  it("rejects changed versions, CVEs, importers, and dependency suffixes", () => {
    for (const mutate of [
      (report) => {
        report.advisories["1"].findings[0].version = "2.0.2";
      },
      (report) => {
        report.advisories["1"].cves = ["CVE-2099-1"];
      },
      (report) => {
        report.advisories["1"].findings[0].paths[0] = report.advisories[
          "1"
        ].findings[0].paths[0].replace("apps/mobile", "apps/desktop");
      },
      (report) => {
        report.advisories["1"].findings[0].paths[0] = report.advisories[
          "1"
        ].findings[0].paths[0].replace("metro@0.84.4", "other@0.84.4");
      },
    ]) {
      const report = reportFor("production");
      mutate(report);
      expect(() =>
        validateDependencyAuditReport({
          report,
          scope: "production",
          policy,
          now: beforeExpiry,
        }),
      ).toThrow();
    }
  });

  it("rejects changed remediation and risk metadata", () => {
    for (const mutate of [
      (advisory) => {
        advisory.vulnerable_versions = "<0.0.0";
      },
      (advisory) => {
        advisory.patched_versions = ">=2.0.3";
      },
      (advisory) => {
        advisory.recommendation = "Upgrade to version 2.0.3 or later";
      },
      (advisory) => {
        advisory.cvss.score = 9.8;
      },
      (advisory) => {
        advisory.cvss.vectorString =
          "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
      },
      (advisory) => {
        advisory.cvss.unreviewedScore = 10;
      },
      (advisory) => {
        advisory.cwe = ["CWE-400"];
      },
    ]) {
      const report = reportFor("production");
      mutate(report.advisories["1"]);
      expect(() =>
        validateDependencyAuditReport({
          report,
          scope: "production",
          policy,
          now: beforeExpiry,
        }),
      ).toThrow();
    }
  });

  it.each(["2026-02-31", "2026-13-01", "2025-02-29", "2026-02-00"])(
    "rejects impossible policy date %s",
    (expiresOn) => {
      const invalidPolicy = clone(policy);
      invalidPolicy.expiresOn = expiresOn;
      for (const advisory of invalidPolicy.advisories)
        advisory.expiresOn = expiresOn;
      expect(() =>
        validateDependencyAuditReport({
          report: reportFor("production"),
          scope: "production",
          policy: invalidPolicy,
          now: new Date("2026-02-01T00:00:00.000Z"),
        }),
      ).toThrow(/real calendar date/);
    },
  );

  it("rejects advisory expiry that drifts from the policy review date", () => {
    const driftedPolicy = clone(policy);
    driftedPolicy.advisories[0].expiresOn = "2026-10-14";
    expect(() =>
      validateDependencyAuditReport({
        report: reportFor("production"),
        scope: "production",
        policy: driftedPolicy,
        now: beforeExpiry,
      }),
    ).toThrow(/expiry must match/);
  });

  it("rejects missing, extra, and duplicate advisory identities", () => {
    const missing = reportFor("production");
    delete missing.advisories["1"];
    missing.metadata.vulnerabilities.high -= 1;
    expect(() =>
      validateDependencyAuditReport({
        report: missing,
        scope: "production",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow();

    const extra = reportFor("production");
    extra.advisories["4"] = {
      ...clone(extra.advisories["1"]),
      github_advisory_id: "GHSA-1111-2222-3333",
    };
    extra.metadata.vulnerabilities.high += 1;
    expect(() =>
      validateDependencyAuditReport({
        report: extra,
        scope: "production",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow();

    const duplicate = reportFor("production");
    duplicate.advisories["4"] = clone(duplicate.advisories["1"]);
    duplicate.metadata.vulnerabilities.high += 1;
    expect(() =>
      validateDependencyAuditReport({
        report: duplicate,
        scope: "production",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/duplicated/);
  });

  it("rejects stale policy and inconsistent registry metadata", () => {
    expect(() =>
      validateDependencyAuditReport({
        report: reportFor("production"),
        scope: "production",
        policy,
        now: new Date("2026-10-15T00:00:00.000Z"),
      }),
    ).toThrow(/expired/);
    const report = reportFor("production");
    report.metadata.vulnerabilities.high = 99;
    expect(() =>
      validateDependencyAuditReport({
        report,
        scope: "production",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/metadata/);
  });

  it("fails closed on registry/tool errors and exit/report disagreement", () => {
    const valid = JSON.stringify(reportFor("production"));
    const baseResult = {
      error: undefined,
      signal: null,
      status: 1,
      stdout: valid,
      stderr: "",
    };
    expect(
      parseAuditCommandResult({
        scope: "production",
        result: baseResult,
        policy,
        now: beforeExpiry,
      }),
    ).toEqual({
      scope: "production",
      advisories: 3,
    });
    expect(() =>
      parseAuditCommandResult({
        scope: "production",
        result: { ...baseResult, status: 2 },
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/exited/);
    expect(() =>
      parseAuditCommandResult({
        scope: "production",
        result: { ...baseResult, stdout: "not json" },
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/invalid JSON/);
    expect(() =>
      parseAuditCommandResult({
        scope: "production",
        result: {
          ...baseResult,
          stdout: JSON.stringify({
            error: { summary: "registry unavailable" },
          }),
        },
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/registry/);
    expect(() =>
      parseAuditCommandResult({
        scope: "production",
        result: {
          ...baseResult,
          stderr: "ERR_PNPM_META_FETCH_FAIL registry unavailable",
        },
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/registry or tool error/);
    expect(() =>
      parseAuditCommandResult({
        scope: "production",
        result: { ...baseResult, status: 0 },
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/exit status/);
  });

  it("rejects array-shaped advisory and vulnerability collections", () => {
    const arrayAdvisories = reportFor("development");
    arrayAdvisories.advisories = [];
    expect(() =>
      validateDependencyAuditReport({
        report: arrayAdvisories,
        scope: "development",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/omitted advisories/);

    const arrayMetadata = reportFor("development");
    arrayMetadata.metadata.vulnerabilities = [];
    expect(() =>
      validateDependencyAuditReport({
        report: arrayMetadata,
        scope: "development",
        policy,
        now: beforeExpiry,
      }),
    ).toThrow(/omitted vulnerability metadata/);
  });
});
