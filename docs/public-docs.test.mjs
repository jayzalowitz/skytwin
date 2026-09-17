import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const normalized = (value) => value.replace(/\s+/g, " ");
const readme = read("README.md");
const index = read("docs/index.html");
const start = read("docs/start.html");
const agents = read("docs/agents.html");
const llms = read("docs/llms.txt");
const docsHome = read("docs/docs.html");
const howToUse = read("docs/how-to-use.html");
const faq = read("docs/faq.html");
const workflows = read("docs/workflows.html");
const demo = read("docs/demo.html");
const claimLedger = read("docs/beta-claim-ledger.json");
const docsRoot = resolve(root, "docs");
const htmlFiles = readdirSync(docsRoot)
  .filter((file) => file.endsWith(".html"))
  .sort();

function localAttributes(html) {
  return [
    ...html.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
  ].map((match) => match[1] ?? match[2]);
}

function ids(html) {
  return new Set(
    [...html.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
      (match) => match[1] ?? match[2],
    ),
  );
}

describe("public developer-preview documentation", () => {
  it("resolves every local page, asset, and fragment without leaving docs", () => {
    for (const page of htmlFiles) {
      const sourcePath = resolve(docsRoot, page);
      const html = readFileSync(sourcePath, "utf8");

      expect(
        html.match(/<title>[^<]+<\/title>/gi) ?? [],
        `${page} title`,
      ).toHaveLength(1);
      expect(
        html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi) ?? [],
        `${page} canonical`,
      ).toHaveLength(1);

      for (const value of localAttributes(html)) {
        expect(
          value.toLowerCase().startsWith("javascript:"),
          `${page} -> ${value}`,
        ).toBe(false);
        if (
          /^(?:[a-z]+:)?\/\//i.test(value) ||
          /^(?:mailto|tel|data):/i.test(value)
        )
          continue;

        expect(value.split(/[?#]/, 1)[0].endsWith(".md"), `${page} -> ${value}`).toBe(
          false,
        );

        const [pathAndQuery = "", encodedFragment = ""] = value.split("#", 2);
        const pathPart = pathAndQuery.split("?", 1)[0];
        const targetPath = resolve(
          dirname(sourcePath),
          decodeURIComponent(pathPart || page),
        );
        const escaped = relative(docsRoot, targetPath);

        expect(
          escaped === ".." || escaped.startsWith("../"),
          `${page} -> ${value}`,
        ).toBe(false);
        expect(existsSync(targetPath), `${page} -> ${value}`).toBe(true);
        expect(
          lstatSync(targetPath).isSymbolicLink(),
          `${page} -> ${value}`,
        ).toBe(false);

        if (encodedFragment) {
          const fragment = decodeURIComponent(encodedFragment);
          expect(targetPath.endsWith(".html"), `${page} -> ${value}`).toBe(
            true,
          );
          expect(
            ids(readFileSync(targetPath, "utf8")).has(fragment),
            `${page} -> ${value}`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps the human and machine paths published together", () => {
    for (const path of [
      "docs/index.html",
      "docs/start.html",
      "docs/how-to-use.html",
      "docs/faq.html",
      "docs/data.html",
      "docs/integrations.html",
      "docs/troubleshooting.html",
      "docs/glossary.html",
      "docs/docs.html",
      "docs/architecture.html",
      "docs/safety.html",
      "docs/inference.html",
      "docs/agents.html",
      "docs/operations.html",
      "docs/release.html",
      "docs/contributing.html",
      "docs/reference.html",
      "docs/workflows.html",
      "docs/llms.txt",
      "docs/guides.css",
    ]) {
      expect(existsSync(resolve(root, path))).toBe(true);
    }
    expect(index).toContain('href="start.html"');
    expect(index).toContain('href="agents.html"');
    expect(index).toContain('href="reference.html"');
    expect(index).toContain('href="llms.txt"');
    expect(agents).toContain("local MCP server");
    expect(llms).toContain("Agent safety requirements");
    expect(docsHome).toContain("architecture.html");
    expect(docsHome).toContain("release.html");
    expect(howToUse).toContain(
      "assets/demo-current/onboarding-source-demo.png",
    );
    expect(workflows).toContain(
      "assets/demo-current/watches-source-demo.png",
    );
    expect(index).toContain('href="faq.html"');
    expect(index).toContain('href="workflows.html"');
    expect(index).toContain("agents.html#connect");
    expect(faq).toContain("v0.7.0-beta");
  });

  it("keeps source evaluation and release boundaries explicit", () => {
    expect(index).toContain(
      "Published installers predate the guarded account-free sample now in source.",
    );
    expect(index).toContain("v0.7.0-beta");
    expect(start).toContain("not a supported installer path");
    expect(start).toContain("git checkout &lt;reviewed-commit&gt;");
    expect(start).toContain("SKYTWIN_SOURCE_ARCHIVE=true ./install.sh");
    expect(start).toContain(
      "Google and Microsoft account connections are unavailable",
    );
    expect(agents).toContain("Do not execute around policy.");
    expect(agents).toContain("Missing action provenance is");
    expect(agents).toContain(
      "A failed audit write is logged but does not replace the tool's own result or error",
    );
    expect(agents).toContain(
      "does not run policy evaluation or create an actionable approval request",
    );
    expect(agents).toContain(
      "other sensitive free text is returned as stored",
    );
    expect(read("docs/twin-mcp-protocol.md")).toContain(
      "Every dispatched registered handler attempts a provenance write",
    );
    expect(read("docs/twin-mcp-protocol.md")).not.toContain(
      "Every tool call writes a provenance node",
    );
    expect(read("docs/twin-mcp-protocol.md")).toContain(
      'status: "recorded_non_executing"',
    );
    expect(howToUse).toContain("fictional sample data");
    expect(normalized(howToUse)).toContain(
      "Settings and Watches are deliberately outside its narrow authority",
    );
    expect(normalized(howToUse)).toContain(
      "Settings and Watches do not accept the disposable sample credential",
    );
    expect(read("docs/integrations.html")).toContain("execution: null");
    expect(read("docs/data.html")).toContain(
      "legacy plaintext token storage remains",
    );
  });

  it("keeps verified-private routing fail-closed and provider-specific", () => {
    expect(index).toContain("Verified private cloud");
    expect(index).toContain(
      "TrustedRouter is admitted only for explicit interactive calls",
    );
    expect(agents).toContain(
      "currently admits only explicit interactive TrustedRouter calls",
    );
    expect(agents).toContain(
      "NEAR AI remains verification-pending and unavailable",
    );
    expect(llms).toContain(
      "does not itself make a SkyTwin inference call confidential",
    );
    expect(normalized(readme)).toContain(
      "verified-private boundary admits only explicit interactive TrustedRouter calls",
    );
    expect(readme).toContain("NEAR AI remains unavailable");
    expect(readme).not.toContain(
      "Remote attested inference is unavailable until SkyTwin can verify it itself",
    );
    expect(claimLedger).toContain(
      "the release-wide verified-private claim remains blocked",
    );
    expect(claimLedger).not.toContain(
      "verified-private admission remains unavailable",
    );
    for (const path of [
      "agents.html",
      "docs.html",
      "faq.html",
      "how-to-use.html",
      "index.html",
      "inference.html",
      "reference.html",
    ]) {
      const html = read(`docs/${path}`);
      expect(html).not.toContain(
        "remote attested inference is deliberately unavailable",
      );
      expect(html).not.toContain(
        "remote-attested route that SkyTwin intentionally does not offer yet",
      );
    }
  });

  it("publishes a reference center that distinguishes current from unavailable inference routes", () => {
    const reference = read("docs/reference.html");
    expect(reference).toContain("Verified-private remote route");
    expect(reference).toContain("NEAR AI remains unavailable");
    expect(reference).toContain("docs/beta-claim-ledger.json");
    expect(reference).toContain("docs/technical-spec.md");
    expect(reference).toContain("agents.html#connect");
  });

  it("keeps the full guide set source-grounded and clear about supported boundaries", () => {
    expect(read("docs/architecture.html")).toContain("typed candidate action");
    expect(read("docs/safety.html")).toContain("Missing action provenance is");
    expect(read("docs/inference.html")).toContain(
      "verified-private inference is fail-closed and provider-specific",
    );
    expect(read("docs/operations.html")).toContain("skytwin_db_pool_waiting");
    expect(read("docs/release.html")).toContain("v0.7.0-beta");
    expect(read("docs/contributing.html")).toContain(
      "Never auto-execute without a policy check.",
    );
  });

  it("documents the current versioned workflow and its model and database boundaries", () => {
    expect(workflows).toContain("signal_digest.v1");
    expect(workflows).toContain("Activate explicitly");
    expect(workflows).toContain("CockroachDB is the source of truth");
    expect(workflows).toContain("Cold start fails closed.");
    expect(normalized(workflows)).toContain(
      "This seeded source-development profile has no qualified local model artifact.",
    );
    expect(normalized(workflows)).toContain(
      "maintained embedded model is available for ordinary local inference but is not qualified for workflow authoring",
    );
    expect(normalized(read("docs/data.html"))).toContain("Backup schema v6");
    expect(normalized(read("docs/data.html"))).toContain(
      "Watch run history and exact run evidence remain installation-local",
    );
    expect(normalized(read("docs/data.html"))).not.toContain(
      "activation history, run evidence, and the active Watch projection",
    );
    expect(normalized(demo)).toContain(
      "current-source captures published in the walkthrough and workflow guide were re-audited",
    );
    expect(normalized(read("docs/architecture.html"))).toContain(
      "/api/adaptive-workflows/:userId/signal-digest-drafts",
    );
    expect(llms).toContain("Versioned workflows");
  });

  it("keeps the gbrain boundary precise", () => {
    const data = read("docs/data.html");
    expect(data).toContain("SkyTwin's gbrain-compatible");
    expect(data).toContain("Upstream gbrain itself supports");
    expect(normalized(data)).toContain(
      "never selects that CLI adapter at runtime",
    );
  });
});
