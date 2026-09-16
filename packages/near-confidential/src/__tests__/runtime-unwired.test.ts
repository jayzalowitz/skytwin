import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function runtimeSourceFilesBelow(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      entry.name === "dist" ||
      entry.name === "node_modules" ||
      entry.name === "__tests__" ||
      entry.name === "near-confidential"
    ) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeSourceFilesBelow(path));
    } else if (entry.isFile()) {
      const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path);
      const testSource = /(?:\.test|\.spec|\.d)\.(?:[cm]?[jt]s|[jt]sx)$/u.test(
        path,
      );
      if (sourceExtension && !testSource) files.push(path);
    }
  }
  return files;
}

describe("confidential runtime activation guard", () => {
  it("keeps the fail-closed placeholder transport out of application composition", () => {
    const runtimeFiles = ["apps", "packages"].flatMap((directory) =>
      runtimeSourceFilesBelow(join(repositoryRoot, directory)),
    );
    const activationReferences = runtimeFiles.filter((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("UnavailableConfidentialTransport");
    });

    expect(activationReferences).toEqual([]);
  });
});
