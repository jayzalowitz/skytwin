import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../../.github/workflows/build.yml", import.meta.url),
  "utf8",
);
const contract = JSON.parse(
  readFileSync(
    new URL("../../docs/release-artifact-contract.json", import.meta.url),
    "utf8",
  ),
);
const releaseJob = workflow.slice(workflow.indexOf("\n  release:\n"));
const releaseIntegrityJob = workflow.slice(
  workflow.indexOf("\n  release-integrity:\n"),
  workflow.indexOf("\n  # ─", workflow.indexOf("\n  release-integrity:\n")),
);

describe("desktop release integrity workflow contract", () => {
  it("pins SBOM and attestation producers and grants only required attestation permissions", () => {
    expect(workflow).toContain(
      "anchore/sbom-action@3ad7283483fc7af8ff2b4ea19663c2d5ca935e26 # v0.24.2",
    );
    expect(workflow).toContain(
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
    );
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).not.toContain("artifact-metadata: write");
    expect(workflow).toContain(
      ".release-integrity/release-manifest.json\n            .release-integrity/SHA256SUMS\n            .release-integrity/release-sbom.cdx.json\n            .release-integrity/sboms/*",
    );
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v[0-9]+(?:\s|$)/u);
    expect(releaseJob).toContain("fail_on_unmatched_files: true");
  });

  it("gates release creation on sample and integrity evidence", () => {
    expect(releaseJob).toContain("- sample-evidence");
    expect(releaseJob).toContain("- release-integrity");
    expect(releaseJob).toContain("draft: true");
  });

  it("derives the packaged app version inside the integrity job", () => {
    expect(releaseIntegrityJob).toContain("Derive packaged app version");
    expect(releaseIntegrityJob).toContain(
      "bash .github/scripts/derive-app-version.sh",
    );
    expect(releaseIntegrityJob).toContain('--appVersion "$APP_VERSION"');
    expect(releaseIntegrityJob).toContain('--app-version "$APP_VERSION"');
  });

  it("publishes only the integrity-staged desktop set and its verification metadata", () => {
    expect(releaseJob).toContain("artifacts/release-integrity/assets/*");
    expect(releaseJob).toContain(
      "artifacts/release-integrity/release-manifest.json",
    );
    expect(releaseJob).toContain("artifacts/release-integrity/SHA256SUMS");
    expect(releaseJob).toContain(
      "artifacts/release-integrity/release-sbom.cdx.json",
    );
    expect(releaseJob).not.toContain("artifacts/SkyTwin-Android");
    expect(releaseJob).not.toContain("artifacts/SkyTwin-iOS");
    expect(releaseJob).not.toContain("artifacts/SkyTwin-macOS-dmg");
  });

  it("requires the complete desktop binary and update-manifest set", () => {
    expect(contract.schemaVersion).toBe(1);
    expect(contract.releaseSurface).toBe("desktop");
    expect(contract.artifacts).toHaveLength(9);
    expect(
      new Set(contract.artifacts.map((entry) => entry.artifactName)).size,
    ).toBe(9);
    expect(new Set(contract.artifacts.map((entry) => entry.platform))).toEqual(
      new Set(["macos", "windows", "linux"]),
    );
    expect(
      contract.artifacts.filter((entry) => entry.kind === "update-manifest"),
    ).toHaveLength(3);

    const expectedPackagerNames = new Map([
      ["SkyTwin-Windows-installer", "SkyTwin Setup 0.6.10200.exe"],
      ["SkyTwin-Linux-deb", "skytwin-desktop_0.6.10200_amd64.deb"],
      ["SkyTwin-Linux-rpm", "skytwin-desktop-0.6.10200.x86_64.rpm"],
    ]);
    for (const [artifactName, filename] of expectedPackagerNames) {
      const entry = contract.artifacts.find(
        (candidate) => candidate.artifactName === artifactName,
      );
      expect(entry, artifactName).toBeDefined();
      expect(filename).toMatch(new RegExp(entry.filenamePattern, "u"));
    }
  });
});
