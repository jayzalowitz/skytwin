import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS } from "./release-constants.mjs";
import {
  assertReleaseTagAbsent,
  assertReleaseTagTargetsCommit,
  publishVerifiedDraft,
} from "./publish-verified-draft.mjs";

const COMMIT = "a".repeat(40);
const MOVED_COMMIT = "f".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const roots = [];

function reportDigest(index) {
  return ((index + 1) % 16).toString(16).repeat(64);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("loads in a fresh runtime without node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "verified-draft-import-"));
  roots.push(root);
  for (const name of ["publish-verified-draft.mjs", "release-constants.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(root, name));
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('./publish-verified-draft.mjs')",
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdio: "pipe",
    },
  );
});

it("keeps publication runtime modules independent of the YAML checker", () => {
  for (const name of [
    "publish-verified-draft.mjs",
    "generate-evidence-manifest.mjs",
  ]) {
    expect(readFileSync(new URL(name, import.meta.url), "utf8")).not.toContain(
      "check-release-claims.mjs",
    );
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verified-draft-"));
  roots.push(root);
  const manifestPath = join(root, "manifest.json");
  const manifest = {
    repository: "owner/repo",
    tag: "v1.0.0-beta.1",
    releaseCommit: COMMIT,
    releaseAssets: [
      { subjects: [{ name: "app.dmg", sha256: "b".repeat(64) }] },
    ],
    evidence: [
      ...CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS.map((reportPath, index) => ({
        reportPath,
        reportSha256: reportDigest(index),
      })),
      {
        reportPath: CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS[0],
        reportSha256: "1".repeat(64),
      },
    ],
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  writeFileSync(manifestPath, bytes);
  return {
    manifestPath,
    manifestDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function response(body) {
  return {
    ok: true,
    status: 200,
    json: async () => structuredClone(body),
  };
}

function failingResponse(status) {
  return { ok: false, status, json: async () => ({}) };
}

function releaseBody(manifestDigest, overrides = {}) {
  return {
    id: 7,
    tag_name: "v1.0.0-beta.1",
    draft: true,
    prerelease: true,
    target_commitish: "ignored-when-the-tag-exists",
    assets: [
      { name: "app.dmg", digest: `sha256:${"b".repeat(64)}` },
      ...CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS.map((reportPath, index) => ({
        name: reportPath.split("/").at(-1),
        digest: `sha256:${reportDigest(index)}`,
      })),
      { name: "manifest.json", digest: `sha256:${manifestDigest}` },
    ],
    ...overrides,
  };
}

function githubFixture({
  manifestDigest,
  publishOutcome = "success",
  confirmationOutcome = "success",
  tagCommit = COMMIT,
  annotated = false,
  tagFailures = 0,
} = {}) {
  let release = releaseBody(manifestDigest);
  let publicationRequests = 0;
  let tagRequests = 0;
  let confirmationFailures = 0;
  const fetchImpl = vi.fn(async (url, options = {}) => {
    if (url.includes("/git/ref/tags/")) {
      tagRequests += 1;
      if (tagRequests <= tagFailures) throw new Error("temporary tag timeout");
      return response({
        object: annotated
          ? { type: "tag", sha: TAG_OBJECT }
          : { type: "commit", sha: tagCommit },
      });
    }
    if (url.endsWith(`/git/tags/${TAG_OBJECT}`))
      return response({ object: { type: "commit", sha: tagCommit } });
    if (url.endsWith("/releases/7") && !options.method) {
      if (!release.draft && confirmationOutcome !== "success") {
        confirmationFailures += 1;
        if (confirmationFailures <= 3) {
          if (confirmationOutcome === "malformed")
            return {
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError("malformed JSON");
              },
            };
          throw new Error("confirmation timeout");
        }
      }
      return response(release);
    }
    if (url.endsWith("/releases/7") && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      if (body.draft === false) {
        publicationRequests += 1;
        release = { ...release, draft: false };
        if (publishOutcome === "transport-loss")
          throw new Error("connection closed after request");
        if (publishOutcome === "malformed")
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("malformed JSON");
            },
          };
        return response(release);
      }
      release = { ...release, draft: true };
      return response(release);
    }
    if (url.includes("/releases/tags/")) return failingResponse(404);
    throw new Error(`unexpected request: ${options.method ?? "GET"} ${url}`);
  });
  return {
    fetchImpl,
    publicationRequests: () => publicationRequests,
    release: () => release,
  };
}

function publishContext(manifestPath, fetchImpl) {
  return {
    manifestPath,
    repository: "owner/repo",
    tag: "v1.0.0-beta.1",
    commit: COMMIT,
    releaseId: "7",
    token: "token",
    fetchImpl,
  };
}

it("allows draft creation only when the complete release inventory lacks the tag", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    tag_name: `v0.0.${index}`,
  }));
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(firstPage))
    .mockResolvedValueOnce(response([]));
  await assertReleaseTagAbsent({
    repository: "owner/repo",
    tag: "v1.0.0-beta.1",
    token: "token",
    fetchImpl,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "rejects an existing release whose draft state is %s",
  async (draft) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response([{ id: 7, tag_name: "v1.0.0-beta.1", draft }]),
      );
    await expect(
      assertReleaseTagAbsent({
        repository: "owner/repo",
        tag: "v1.0.0-beta.1",
        token: "token",
        fetchImpl,
      }),
    ).rejects.toThrow("already exists");
  },
);

it("dereferences annotated tags and retries transient tag lookups", async () => {
  const { manifestDigest } = fixture();
  const github = githubFixture({
    manifestDigest,
    annotated: true,
    tagFailures: 2,
  });
  await assertReleaseTagTargetsCommit({
    repository: "owner/repo",
    tag: "v1.0.0-beta.1",
    commit: COMMIT,
    token: "token",
    fetchImpl: github.fetchImpl,
  });
  expect(github.fetchImpl).toHaveBeenCalledTimes(4);
});

it("rejects a tag moved away from the verified commit", async () => {
  const { manifestDigest } = fixture();
  const github = githubFixture({ manifestDigest, tagCommit: MOVED_COMMIT });
  await expect(
    assertReleaseTagTargetsCommit({
      repository: "owner/repo",
      tag: "v1.0.0-beta.1",
      commit: COMMIT,
      token: "token",
      fetchImpl: github.fetchImpl,
    }),
  ).rejects.toThrow(`resolves to ${MOVED_COMMIT}`);
});

it("loads a draft by release ID because GitHub's tag endpoint returns 404 for drafts", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const github = githubFixture({ manifestDigest });
  await publishVerifiedDraft(publishContext(manifestPath, github.fetchImpl));
  expect(github.publicationRequests()).toBe(1);
  expect(
    github.fetchImpl.mock.calls.some(([url]) =>
      url.includes("/releases/tags/"),
    ),
  ).toBe(false);
  expect(
    github.fetchImpl.mock.calls.some(([url]) => url.endsWith("/releases/7")),
  ).toBe(true);
  expect(
    github.fetchImpl.mock.calls.every(
      ([, options]) => options?.signal instanceof AbortSignal,
    ),
  ).toBe(true);
});

it.each(["transport-loss", "malformed"])(
  "reconciles a %s publication response by ID without republishing",
  async (publishOutcome) => {
    const { manifestPath, manifestDigest } = fixture();
    const github = githubFixture({ manifestDigest, publishOutcome });
    await publishVerifiedDraft(publishContext(manifestPath, github.fetchImpl));
    expect(github.publicationRequests()).toBe(1);
    expect(github.release().draft).toBe(false);
  },
);

it.each(["timeout", "malformed"])(
  "returns the release to draft when final confirmation has a %s",
  async (confirmationOutcome) => {
    const { manifestPath, manifestDigest } = fixture();
    const github = githubFixture({ manifestDigest, confirmationOutcome });
    await expect(
      publishVerifiedDraft(publishContext(manifestPath, github.fetchImpl)),
    ).rejects.toThrow("release was returned to draft");
    expect(github.publicationRequests()).toBe(1);
    expect(github.release().draft).toBe(true);
  },
);

it("does not publish when the tag moves after draft creation", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const github = githubFixture({ manifestDigest, tagCommit: MOVED_COMMIT });
  await expect(
    publishVerifiedDraft(publishContext(manifestPath, github.fetchImpl)),
  ).rejects.toThrow(`resolves to ${MOVED_COMMIT}`);
  expect(github.publicationRequests()).toBe(0);
  expect(github.release().draft).toBe(true);
});

it("returns a release to draft when the tag moves after publication", async () => {
  const { manifestPath, manifestDigest } = fixture();
  let tagReads = 0;
  const github = githubFixture({ manifestDigest });
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.includes("/git/ref/tags/")) {
      tagReads += 1;
      return response({
        object: {
          type: "commit",
          sha: tagReads === 1 ? COMMIT : MOVED_COMMIT,
        },
      });
    }
    return github.fetchImpl(url, options);
  });
  await expect(
    publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
  ).rejects.toThrow("release was returned to draft");
  expect(github.publicationRequests()).toBe(1);
  expect(github.release().draft).toBe(true);
});

it("does not publish a draft with a changed asset digest", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const changed = releaseBody(manifestDigest, {
    assets: [
      { name: "app.dmg", digest: `sha256:${"c".repeat(64)}` },
      { name: "manifest.json", digest: `sha256:${manifestDigest}` },
    ],
  });
  const fetchImpl = vi.fn().mockResolvedValue(response(changed));
  await expect(
    publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
  ).rejects.toThrow("do not exactly match");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("requires the exact draft release ID emitted by the creator action", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const github = githubFixture({ manifestDigest });
  await expect(
    publishVerifiedDraft({
      ...publishContext(manifestPath, github.fetchImpl),
      releaseId: "not-an-id",
    }),
  ).rejects.toThrow("positive GitHub release ID");
  expect(github.fetchImpl).not.toHaveBeenCalled();
});

it("deduplicates identical CI report references in the evidence manifest", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const github = githubFixture({ manifestDigest });
  await publishVerifiedDraft(publishContext(manifestPath, github.fetchImpl));
  const draftLookup = github.fetchImpl.mock.results[0];
  expect(draftLookup.type).toBe("return");
  expect(github.publicationRequests()).toBe(1);
});

it("rejects conflicting duplicate evidence digests before any API call", async () => {
  const { manifestPath } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.evidence.at(-1).reportSha256 = "e".repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const fetchImpl = vi.fn();
  await expect(
    publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
  ).rejects.toThrow("conflicting durable evidence digests");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("rejects missing or unexpected durable evidence paths", async () => {
  for (const mutation of [
    (manifest) => {
      manifest.evidence = manifest.evidence.filter(
        ({ reportPath }) =>
          reportPath !== CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS.at(-1),
      );
    },
    (manifest) =>
      manifest.evidence.push({
        reportPath: ".release-evidence/reports/unexpected.json",
        reportSha256: "e".repeat(64),
      }),
  ]) {
    const { manifestPath } = fixture();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutation(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const fetchImpl = vi.fn();
    await expect(
      publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
    ).rejects.toThrow(/(?:missing|unexpected) durable evidence/);
    expect(fetchImpl).not.toHaveBeenCalled();
  }
});

it("rejects a missing or digest-changed durable evidence release asset", async () => {
  const { manifestPath, manifestDigest } = fixture();
  for (const mutate of [
    (assets) => assets.filter(({ name }) => name !== "release.signing.json"),
    (assets) =>
      assets.map((asset) =>
        asset.name === "release.signing.json"
          ? { ...asset, digest: `sha256:${"e".repeat(64)}` }
          : asset,
      ),
  ]) {
    const changed = releaseBody(manifestDigest);
    changed.assets = mutate(changed.assets);
    const fetchImpl = vi.fn().mockResolvedValue(response(changed));
    await expect(
      publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
    ).rejects.toThrow("do not exactly match");
  }
});

it("rejects evidence basenames that collide with package subjects", async () => {
  const { manifestPath } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.releaseAssets[0].subjects[0].name = "result.json";
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const fetchImpl = vi.fn();
  await expect(
    publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
  ).rejects.toThrow("durable evidence asset name conflicts");
  expect(fetchImpl).not.toHaveBeenCalled();
});
