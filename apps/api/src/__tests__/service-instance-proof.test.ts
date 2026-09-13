import { describe, expect, it } from "vitest";
import {
  createServiceInstanceProof,
  SERVICE_INSTANCE_CHALLENGE_PATTERN,
} from "../auth/service-instance-proof.js";

describe("service instance proof", () => {
  it("uses the canonical proof domain and validates challenge shape", () => {
    const challenge = "a".repeat(64);
    expect(SERVICE_INSTANCE_CHALLENGE_PATTERN.test(challenge)).toBe(true);
    expect(createServiceInstanceProof("service-token", challenge)).toBe(
      "e55dbe2a3b9f99d95a0582a4c8b22ac22c65ac06d8b9469cdb19a4c2f8ec3ed8",
    );
    expect(SERVICE_INSTANCE_CHALLENGE_PATTERN.test("not-a-challenge")).toBe(
      false,
    );
  });
});
