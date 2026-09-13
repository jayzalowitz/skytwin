import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  new URL("../index.ts", import.meta.url),
  "utf8",
);

describe("worker scheduled-job generation admission inventory", () => {
  it.each([
    "runMetricsRollupJob",
    "runChangelogPollJob",
    "runDomainExtractionJob",
    "runCapabilityInferenceJob",
    "runWatchSchedulerJob",
    "runFederationSyncJob",
    "runEmbeddingBackfillJob",
    "runTierBackfillJob",
    "runRelationshipTierBackfillBatch",
    "runMemoryActionLoopJob",
    "runBriefingGeneratorJob",
    "runPromotionEligibilityCheckJob",
  ])("%s receives the live generation signal", (jobName) => {
    expect(workerSource).toMatch(
      new RegExp(
        `${jobName}\\([\\s\\S]{0,160}signal: generationAdmission\\.signal`,
      ),
    );
  });

  it("guards direct maintenance and rediscovery blocks before admission", () => {
    expect(workerSource).toContain(
      "if (generationAdmission.isActive() && pollCount % 10 === 0)",
    );
    expect(workerSource).toContain(
      "generationAdmission.isActive() &&\n      (userConnectors.length === 0 || pollCount % 10 === 0)",
    );
  });
});
