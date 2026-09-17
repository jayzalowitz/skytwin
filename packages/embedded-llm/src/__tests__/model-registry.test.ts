import { describe, expect, it } from "vitest";
import {
  MODEL_REGISTRY,
  checkForUpgrade,
  findById,
  listByBracket,
  recommendDefault,
  validateModelRegistry,
  type ModelEntry,
} from "../model-registry.js";

describe("MODEL_REGISTRY", () => {
  it("is a non-empty frozen list", () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
    expect(Object.isFrozen(MODEL_REGISTRY)).toBe(true);
  });

  it("every entry has a unique id", () => {
    const ids = new Set(MODEL_REGISTRY.map((m) => m.id));
    expect(ids.size).toBe(MODEL_REGISTRY.length);
  });

  it("every entry has maintained ranking, compatibility sentinel, and exact size", () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.recommendationPriority).toBeGreaterThanOrEqual(0);
      expect(m.qualityScore).toBe(0);
      expect(m.exactBytes).toBeGreaterThan(0);
      expect(m.approxBytes).toBe(m.exactBytes);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.workflowAuthoring.evaluatedRuntimeBuild).toBeGreaterThan(0);
      expect(m.workflowAuthoring.rationale.length).toBeGreaterThan(0);
    }
  });

  it("does not qualify a managed artifact until the real gate passes", () => {
    const qualified = MODEL_REGISTRY.filter(
      (model) => model.workflowAuthoring.status === "qualified",
    );
    expect(qualified).toHaveLength(0);
    expect(MODEL_REGISTRY[0]?.workflowAuthoring.rationale).toMatch(/failed/i);
  });
});

describe("findById", () => {
  it("returns the matching entry", () => {
    const first = MODEL_REGISTRY[0]!;
    expect(findById(first.id)).toEqual(first);
  });

  it("returns null for unknown id", () => {
    expect(findById("does-not-exist")).toBeNull();
  });
});

describe("listByBracket", () => {
  it("returns only entries in the requested bracket", () => {
    const four = listByBracket("4gb");
    expect(four.length).toBeGreaterThan(0);
    for (const m of four) {
      expect(m.ramBracket).toBe("4gb");
    }
  });

  it("returns a copy (mutation does not affect the registry)", () => {
    const list = listByBracket("4gb");
    const before = MODEL_REGISTRY.filter((m) => m.ramBracket === "4gb").length;
    list.pop();
    const after = MODEL_REGISTRY.filter((m) => m.ramBracket === "4gb").length;
    expect(before).toBe(after);
  });
});

describe("checkForUpgrade", () => {
  it("returns null when current model is unknown", () => {
    expect(checkForUpgrade("not-in-registry")).toBeNull();
  });

  it("returns null when current model is already best in bracket", () => {
    // Find the highest-quality model in any bracket and feed it back in.
    const buckets = new Set(MODEL_REGISTRY.map((m) => m.ramBracket));
    for (const b of buckets) {
      const inBracket = MODEL_REGISTRY.filter((m) => m.ramBracket === b);
      const best = inBracket.reduce((a, b) =>
        a.recommendationPriority > b.recommendationPriority ? a : b,
      );
      expect(checkForUpgrade(best.id)).toBeNull();
    }
  });

  it("recommends a higher-quality model in the same bracket", () => {
    // Construct a synthetic registry so the test is independent of
    // the real model list's ordering.
    const base = MODEL_REGISTRY[0]!;
    const synthRegistry: readonly ModelEntry[] = Object.freeze([
      {
        ...base,
        id: "old",
        displayName: "Old",
        ramBracket: "8gb",
        approxBytes: base.exactBytes,
        exactBytes: base.exactBytes,
        contextWindow: 4096,
        recommendationPriority: 1,
        version: 1,
      },
      {
        ...base,
        id: "new",
        displayName: "New",
        ramBracket: "8gb",
        approxBytes: base.exactBytes,
        exactBytes: base.exactBytes,
        contextWindow: 4096,
        recommendationPriority: 2,
        version: 1,
      },
    ]);
    const rec = checkForUpgrade("old", synthRegistry);
    expect(rec).not.toBeNull();
    expect(rec!.recommended.id).toBe("new");
    expect(rec!.qualityDeltaPct).toBe(0);
    expect(rec!.rationale).toContain("New");
    expect(rec!.rationale).toContain("No benchmark improvement is claimed");
  });

  it("does not cross brackets even when a better model exists in another bracket", () => {
    const base = MODEL_REGISTRY[0]!;
    const synthRegistry: readonly ModelEntry[] = Object.freeze([
      {
        ...base,
        id: "small",
        displayName: "Small",
        ramBracket: "8gb",
        approxBytes: base.exactBytes,
        exactBytes: base.exactBytes,
        contextWindow: 4096,
        recommendationPriority: 1,
        version: 1,
      },
      {
        ...base,
        id: "big",
        displayName: "Big",
        ramBracket: "16gb",
        approxBytes: base.exactBytes,
        exactBytes: base.exactBytes,
        contextWindow: 4096,
        recommendationPriority: 2,
        version: 1,
      },
    ]);
    expect(checkForUpgrade("small", synthRegistry)).toBeNull();
  });

  it("picks the highest-scoring candidate when multiple upgrades exist", () => {
    const base = MODEL_REGISTRY[0]!;
    const synth: readonly ModelEntry[] = Object.freeze([
      {
        ...base,
        id: "a",
        displayName: "A",
        ramBracket: "8gb",
        recommendationPriority: 1,
      },
      {
        ...base,
        id: "b",
        displayName: "B",
        ramBracket: "8gb",
        recommendationPriority: 2,
      },
      {
        ...base,
        id: "c",
        displayName: "C",
        ramBracket: "8gb",
        recommendationPriority: 3,
      },
    ]);
    const rec = checkForUpgrade("a", synth);
    expect(rec!.recommended.id).toBe("c");
  });
});

describe("recommendDefault", () => {
  it("falls back to the maintained smallest model for a larger bracket", () => {
    const def = recommendDefault("8gb");
    expect(def.id).toBe(MODEL_REGISTRY[0]!.id);
  });
});

describe("validateModelRegistry", () => {
  it("accepts the shipped registry", () => {
    expect(validateModelRegistry(MODEL_REGISTRY)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects non-default artifact ports and unsupported quality claims", () => {
    const valid = MODEL_REGISTRY[0]!;
    const result = validateModelRegistry([
      {
        ...valid,
        qualityScore: 1,
        source: {
          ...valid.source,
          downloadUrl: valid.source.downloadUrl.replace(
            "huggingface.co/",
            "huggingface.co:8443/",
          ),
        },
        downloadUrl: valid.downloadUrl.replace(
          "huggingface.co/",
          "huggingface.co:8443/",
        ),
      },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(["qualityScore", "source.downloadUrl"]),
    );
  });

  it("rejects placeholders, mutable URLs, duplicate ids and missing pinned licenses", () => {
    const valid = MODEL_REGISTRY[0]!;
    const broken: ModelEntry = {
      ...valid,
      sha256: "0".repeat(64),
      source: {
        ...valid.source,
        revision: "main",
        downloadUrl: valid.source.downloadUrl.replace(
          valid.source.revision,
          "main",
        ),
      },
      downloadUrl: valid.downloadUrl.replace(valid.source.revision, "main"),
      license: {
        ...valid.license,
        url: valid.license.url.replace(valid.source.revision, "main"),
      },
    };
    const result = validateModelRegistry([broken, broken]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.field)).toEqual(
      expect.arrayContaining([
        "id",
        "sha256",
        "source.revision",
        "source.downloadUrl",
        "license.url",
      ]),
    );
  });

  it("rejects an incomplete workflow-authoring qualification", () => {
    const valid = MODEL_REGISTRY[0]!;
    const result = validateModelRegistry([{
      ...valid,
      workflowAuthoring: { ...valid.workflowAuthoring, rationale: "" },
    }]);
    expect(result.errors.map((error) => error.field)).toContain("workflowAuthoring");
  });
});
