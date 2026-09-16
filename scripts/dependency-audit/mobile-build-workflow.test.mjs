import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/build.yml", import.meta.url),
  "utf8",
);

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`workflow job not found: ${name}`);
  const rest = workflow.slice(start + 1);
  const nextJob = rest.search(/\n  [a-z0-9-]+:/);
  return workflow.slice(
    start,
    nextJob < 0 ? workflow.length : start + 1 + nextJob,
  );
}

function stepSection(job, name) {
  const start = job.indexOf(`      - name: ${name}`);
  if (start < 0) throw new Error(`workflow step not found: ${name}`);
  const rest = job.slice(start + 1);
  const nextStep = rest.search(/\n      - (?:name:|uses:|run:)/);
  return job.slice(start, nextStep < 0 ? job.length : start + 1 + nextStep);
}

describe("mobile build workflow", () => {
  it.each([
    [
      "mobile-android",
      "SkyTwin-Android-apk",
      "apps/mobile/android/app/build/outputs/apk/release/*.apk",
      [
        "Prebuild Android project",
        "Install native dependencies",
        "Build Android APK",
      ],
    ],
    [
      "mobile-ios",
      "SkyTwin-iOS-simulator",
      "apps/mobile/SkyTwin-iOS-simulator.zip",
      [
        "Prebuild iOS project",
        "Install native dependencies",
        "Install CocoaPods",
        "Build iOS simulator app",
        "Package iOS simulator build",
      ],
    ],
  ])(
    "fails closed for %s build and artifact steps",
    (jobName, artifactName, artifactPath, requiredSteps) => {
      const section = jobSection(jobName);
      for (const stepName of requiredSteps) {
        expect(stepSection(section, stepName)).not.toContain(
          "continue-on-error: true",
        );
      }
      expect(section).toContain("if-no-files-found: error");
      expect(section).toContain(`name: ${artifactName}`);
      expect(section).toContain(`path: ${artifactPath}`);
    },
  );
});
