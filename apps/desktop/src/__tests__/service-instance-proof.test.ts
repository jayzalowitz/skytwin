import { describe, expect, it } from "vitest";
import { verifyServiceInstanceProof } from "../service-instance-proof.js";

describe("verifyServiceInstanceProof", () => {
  const challenge = "a".repeat(64);
  const proof =
    "e55dbe2a3b9f99d95a0582a4c8b22ac22c65ac06d8b9469cdb19a4c2f8ec3ed8";

  it("accepts only a proof made with the install service credential", () => {
    expect(verifyServiceInstanceProof("service-token", challenge, proof)).toBe(
      true,
    );
    expect(verifyServiceInstanceProof("other-token", challenge, proof)).toBe(
      false,
    );
    expect(
      verifyServiceInstanceProof("service-token", challenge, "malformed"),
    ).toBe(false);
  });
});
