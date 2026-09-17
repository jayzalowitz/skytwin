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
import {
  ARTIFACT_VERIFICATION_DIRECTORY,
  CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS,
  CANONICAL_RELEASE_SAFETY_ASSET_PATHS,
  RELEASE_CLAIM_CI_ARTIFACT_FILES,
} from "./release-constants.mjs";
import {
  assertReleaseCommitOnMain,
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
    verificationAssets: [
      ["checksums", "SHA256SUMS", "c"],
      ["sbom", "release.spdx.json", "d"],
      ["verification-instructions", "VERIFY.md", "e"],
      ["provenance-bundle", `${"b".repeat(64)}.attestation.jsonl`, "f"],
    ].map(([kind, name, digest]) => ({
      kind,
      name,
      path: `${ARTIFACT_VERIFICATION_DIRECTORY}/${name}`,
      sha256: digest.repeat(64),
    })),
    ciEvidenceArtifact: {
      files: RELEASE_CLAIM_CI_ARTIFACT_FILES.map(
        ({ role, downloadedPath }, index) => ({
          role,
          path: downloadedPath,
          sha256:
            role === "claim-result"
              ? reportDigest(0)
              : (index + 6).toString(16).repeat(64),
          sizeBytes: index + 1,
        }),
      ),
    },
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
      { name: "SHA256SUMS", digest: `sha256:${"c".repeat(64)}` },
      { name: "release.spdx.json", digest: `sha256:${"d".repeat(64)}` },
      { name: "VERIFY.md", digest: `sha256:${"e".repeat(64)}` },
      {
        name: `${"b".repeat(64)}.attestation.jsonl`,
        digest: `sha256:${"f".repeat(64)}`,
      },
      ...CANONICAL_DURABLE_EVIDENCE_REPORT_PATHS.map((reportPath, index) => ({
        name: reportPath.split("/").at(-1),
        digest: `sha256:${reportDigest(index)}`,
      })),
      ...CANONICAL_RELEASE_SAFETY_ASSET_PATHS.map((path, index) => ({
        name: path.split("/").at(-1),
        digest: `sha256:${(index + 7).toString(16).repeat(64)}`,
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
  mainStatus = "ahead",
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
    if (url.includes(`/compare/${COMMIT}...main`))
      return response({
        status: mainStatus,
        merge_base_commit: {
          sha: mainStatus === "diverged" ? MOVED_COMMIT : COMMIT,
        },
      });
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
    expectedManifestSha256: createHash("sha256")
      .update(readFileSync(manifestPath))
      .digest("hex"),
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

it("rejects a release commit that is not merged into main", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    response({
      status: "diverged",
      merge_base_commit: { sha: MOVED_COMMIT },
    }),
  );
  await expect(
    assertReleaseCommitOnMain({
      repository: "owner/repo",
      commit: COMMIT,
      token: "token",
      fetchImpl,
    }),
  ).rejects.toThrow("is not an ancestor of the current main branch");
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

it("does not publish when the tagged commit is outside main", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const github = githubFixture({ manifestDigest, mainStatus: "diverged" });
  await expect(
    publishVerifiedDraft(publishContext(manifestPath, github.fetchImpl)),
  ).rejects.toThrow("is not an ancestor of the current main branch");
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

it("returns a release to draft when main ancestry no longer verifies", async () => {
  const { manifestPath, manifestDigest } = fixture();
  let ancestryReads = 0;
  const github = githubFixture({ manifestDigest });
  const fetchImpl = vi.fn(async (url, options) => {
    if (url.includes(`/compare/${COMMIT}...main`)) {
      ancestryReads += 1;
      return response({
        status: ancestryReads === 1 ? "ahead" : "diverged",
        merge_base_commit: {
          sha: ancestryReads === 1 ? COMMIT : MOVED_COMMIT,
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

it("rejects a manifest changed after the publication evidence gate", async () => {
  const { manifestPath, manifestDigest } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.tag = "v1.0.0-beta.2";
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const fetchImpl = vi.fn();
  await expect(
    publishVerifiedDraft({
      ...publishContext(manifestPath, fetchImpl),
      expectedManifestSha256: manifestDigest,
    }),
  ).rejects.toThrow("changed after publication verification");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("requires every CI safety sidecar with its manifest-bound digest", async () => {
  const { manifestPath, manifestDigest } = fixture();
  for (const mutate of [
    (assets) =>
      assets.filter(({ name }) => name !== "release-safety-evidence.json"),
    (assets) =>
      assets.map((asset) =>
        asset.name === "adversarial-evidence.json"
          ? { ...asset, digest: `sha256:${"0".repeat(64)}` }
          : asset,
      ),
  ]) {
    const changed = releaseBody(manifestDigest);
    changed.assets = mutate(changed.assets);
    await expect(
      publishVerifiedDraft(
        publishContext(
          manifestPath,
          vi.fn().mockResolvedValue(response(changed)),
        ),
      ),
    ).rejects.toThrow("do not exactly match");
  }
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
    (assets) =>
      assets.filter(({ name }) => name !== "release.signing.macos.json"),
    (assets) =>
      assets.map((asset) =>
        asset.name === "release.signing.macos.json"
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

it("rejects missing, digest-changed, or unpublished verification materials", async () => {
  const { manifestPath, manifestDigest } = fixture();
  for (const mutate of [
    (assets) => assets.filter(({ name }) => name !== "release.spdx.json"),
    (assets) =>
      assets.map((asset) =>
        asset.name === "VERIFY.md"
          ? { ...asset, digest: `sha256:${"0".repeat(64)}` }
          : asset,
      ),
    (assets) => [
      ...assets,
      { name: "unpublished.txt", digest: `sha256:${"1".repeat(64)}` },
    ],
  ]) {
    const changed = releaseBody(manifestDigest);
    changed.assets = mutate(changed.assets);
    await expect(
      publishVerifiedDraft(
        publishContext(
          manifestPath,
          vi.fn().mockResolvedValue(response(changed)),
        ),
      ),
    ).rejects.toThrow("do not exactly match");
  }
});

it("rejects extra or duplicate verification materials in the manifest", async () => {
  for (const mutate of [
    (manifest) =>
      manifest.verificationAssets.push({
        kind: "sbom",
        name: "unexpected.json",
        path: `${ARTIFACT_VERIFICATION_DIRECTORY}/unexpected.json`,
        sha256: "1".repeat(64),
      }),
    (manifest) =>
      manifest.verificationAssets.push(
        structuredClone(manifest.verificationAssets[0]),
      ),
  ]) {
    const { manifestPath } = fixture();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutate(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const fetchImpl = vi.fn();
    await expect(
      publishVerifiedDraft(publishContext(manifestPath, fetchImpl)),
    ).rejects.toThrow(/(?:invalid|conflicts)/);
    expect(fetchImpl).not.toHaveBeenCalled();
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
