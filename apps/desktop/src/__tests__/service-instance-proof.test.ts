import { describe, expect, it } from "vitest";
import { verifyServiceInstanceProof } from "../service-instance-proof.js";

describe("verifyServiceInstanceProof", () => {
  const challenge = "a".repeat(64);
  const proof =
    "66936c3fc3d1f40b2aac076eb9cfba4c68616144d57ef2909ee86b0f29540016";

  it("accepts only a proof made with the exact spawn capability", () => {
    expect(
      verifyServiceInstanceProof("instance-capability", challenge, proof),
    ).toBe(true);
    expect(
      verifyServiceInstanceProof("other-capability", challenge, proof),
    ).toBe(false);
    expect(
      verifyServiceInstanceProof("instance-capability", challenge, "malformed"),
    ).toBe(false);
  });
});
