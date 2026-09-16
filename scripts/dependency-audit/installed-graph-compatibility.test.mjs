import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

function packageContext(parentRequire, packageName) {
  const entry = parentRequire.resolve(packageName);
  let directory = dirname(entry);
  while (true) {
    const packageJsonPath = join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (metadata.name === packageName) {
        return {
          metadata,
          require: createRequire(packageJsonPath),
          load: () => parentRequire(packageName),
        };
      }
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`could not locate package metadata for ${packageName}`);
    directory = parent;
  }
}

function follow(initialRequire, dependencyNames) {
  let context;
  let currentRequire = initialRequire;
  for (const dependencyName of dependencyNames) {
    context = packageContext(currentRequire, dependencyName);
    currentRequire = context.require;
  }
  if (!context) throw new Error("dependency chain must not be empty");
  return context;
}

function unwrapDefault(module) {
  let value = module;
  const seen = new Set();
  while (
    value &&
    typeof value === "object" &&
    "default" in value &&
    !seen.has(value)
  ) {
    seen.add(value);
    value = value.default;
  }
  return value;
}

const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const mobileRequire = createRequire(join(root, "apps/mobile/package.json"));
const appBuilder = follow(desktopRequire, [
  "electron-builder",
  "app-builder-lib",
]);

describe("installed dependency graph compatibility", () => {
  it.each([
    ["10.2.5", "5.0.12", ["minimatch"]],
    ["3.1.5", "1.1.21", ["@electron/asar", "minimatch"]],
    ["9.0.9", "2.1.7", ["@electron/universal", "minimatch"]],
    ["5.1.9", "2.1.7", ["ejs", "jake", "filelist", "minimatch"]],
  ])(
    "keeps minimatch %s brace expansion callable",
    (expectedVersion, expectedBraceVersion, chain) => {
      const context = follow(appBuilder.require, chain);
      const braceExpansion = follow(context.require, ["brace-expansion"]);
      expect(context.metadata.version).toBe(expectedVersion);
      expect(braceExpansion.metadata.version).toBe(expectedBraceVersion);
      const loaded = context.load();
      const minimatch =
        typeof loaded === "function" ? loaded : loaded.minimatch;
      expect(minimatch("src/file.ts", "src/*.{ts,js}")).toBe(true);
      expect(minimatch("src/file.md", "src/*.{ts,js}")).toBe(false);
      expect(loaded.braceExpand("a{b,c}d")).toEqual(["abd", "acd"]);
    },
  );

  it("keeps app-builder plist compatible with xmldom 0.9", () => {
    const plistContext = follow(appBuilder.require, ["plist"]);
    const xmldomContext = follow(plistContext.require, ["@xmldom/xmldom"]);
    expect(plistContext.metadata.version).toBe("3.1.1");
    expect(xmldomContext.metadata.version).toBe("0.9.12");
    const plist = plistContext.load();
    expect(
      plist.parse(plist.build({ name: "SkyTwin", enabled: true })),
    ).toEqual({
      name: "SkyTwin",
      enabled: true,
    });
  });

  it("keeps Expo plist on its compatible xmldom 0.8 line", () => {
    const expoCli = follow(mobileRequire, ["expo", "@expo/cli"]);
    const expoPlist = follow(mobileRequire, [
      "expo",
      "@expo/cli",
      "@expo/plist",
    ]);
    const xmldomContext = follow(expoPlist.require, ["@xmldom/xmldom"]);
    // Expo SDK 57's CLI declares @expo/plist ^0.8.1; keep this assertion tied
    // to that compatibility contract rather than a single lockfile patch.
    expect(expoCli.metadata.dependencies["@expo/plist"]).toBe("^0.8.1");
    expect(expoPlist.metadata.version).toMatch(/^0\.8\./);
    expect(expoPlist.metadata.dependencies["@xmldom/xmldom"]).toBe("^0.8.8");
    expect(xmldomContext.metadata.version).toMatch(/^0\.8\./);
    const plist = unwrapDefault(expoPlist.load());
    expect(
      plist.parse(plist.build({ name: "SkyTwin", enabled: true })),
    ).toEqual({
      name: "SkyTwin",
      enabled: true,
    });
  });

  it("keeps React Navigation query-string 7 on a callable CommonJS decoder", () => {
    const queryString = follow(mobileRequire, [
      "@react-navigation/native",
      "@react-navigation/core",
      "query-string",
    ]);
    const decoder = follow(queryString.require, ["decode-uri-component"]);
    expect(queryString.metadata.version).toBe("7.1.3");
    expect(decoder.metadata.version).toBe("0.2.2");
    expect(queryString.load().parse("route=approval%20detail")).toEqual({
      route: "approval detail",
    });
  });
});
