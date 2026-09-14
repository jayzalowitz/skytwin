import { expect, it, vi } from "vitest";
import { verifyReleaseEnvironment } from "./verify-release-environment.mjs";

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function validConfiguration() {
  return {
    protection_rules: [
      {
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [{ type: "User", reviewer: { login: "release-reviewer" } }],
      },
    ],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
}

const context = {
  repository: "owner/repo",
  environment: "release-publication",
  tag: "v0.7.0-beta",
  token: "token",
};

it("accepts a reviewed environment restricted to the release tag", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(validConfiguration()))
    .mockResolvedValueOnce(
      response({
        branch_policies: [{ name: "v*", type: "tag" }],
      }),
    );
  await verifyReleaseEnvironment({ ...context, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("retries transient read failures before accepting the environment", async () => {
  const fetchImpl = vi
    .fn()
    .mockRejectedValueOnce(new Error("transport reset"))
    .mockResolvedValueOnce(response(validConfiguration()))
    .mockRejectedValueOnce(new Error("temporary policy outage"))
    .mockResolvedValueOnce(
      response({
        branch_policies: [{ name: "v*", type: "tag" }],
      }),
    );
  await verifyReleaseEnvironment({ ...context, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const [, options] of fetchImpl.mock.calls)
    expect(options.signal).toBeInstanceOf(AbortSignal);
});

it("fails closed after bounded request timeouts are exhausted", async () => {
  const fetchImpl = vi.fn(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  await expect(
    verifyReleaseEnvironment({
      ...context,
      fetchImpl,
      requestTimeoutMs: 5,
    }),
  ).rejects.toThrow("release environment lookup failed after 3 attempts");
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it("fails closed when the named environment does not exist", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(response({}, { ok: false, status: 404 }));
  await expect(
    verifyReleaseEnvironment({ ...context, fetchImpl }),
  ).rejects.toThrow("release environment lookup returned HTTP 404");
});

it("fails closed without a required reviewer", async () => {
  const configuration = validConfiguration();
  configuration.protection_rules = [];
  const fetchImpl = vi.fn().mockResolvedValue(response(configuration));
  await expect(
    verifyReleaseEnvironment({ ...context, fetchImpl }),
  ).rejects.toThrow("must require at least one reviewer");
});

it.each([false, undefined])(
  "fails closed when prevent_self_review is %s",
  async (preventSelfReview) => {
    const configuration = validConfiguration();
    const reviewerRule = configuration.protection_rules[0];
    if (preventSelfReview === undefined)
      delete reviewerRule.prevent_self_review;
    else reviewerRule.prevent_self_review = preventSelfReview;
    const fetchImpl = vi.fn().mockResolvedValue(response(configuration));
    await expect(
      verifyReleaseEnvironment({ ...context, fetchImpl }),
    ).rejects.toThrow("must prevent self-review");
  },
);

it("rejects a branch policy or non-matching tag policy", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(validConfiguration()))
    .mockResolvedValueOnce(
      response({
        branch_policies: [
          { name: "v*", type: "branch" },
          { name: "candidate-*", type: "tag" },
        ],
      }),
    );
  await expect(
    verifyReleaseEnvironment({ ...context, fetchImpl }),
  ).rejects.toThrow("no tag deployment policy matching v0.7.0-beta");
});
