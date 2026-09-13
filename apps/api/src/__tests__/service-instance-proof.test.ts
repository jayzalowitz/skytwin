import { describe, expect, it } from "vitest";
import {
  createServiceInstanceProof,
  SERVICE_INSTANCE_CHALLENGE_PATTERN,
} from "../auth/service-instance-proof.js";

describe("service instance proof", () => {
  it("uses the canonical proof domain and validates challenge shape", () => {
    const challenge = "a".repeat(64);
    expect(SERVICE_INSTANCE_CHALLENGE_PATTERN.test(challenge)).toBe(true);
    expect(createServiceInstanceProof("instance-capability", challenge)).toBe(
      "66936c3fc3d1f40b2aac076eb9cfba4c68616144d57ef2909ee86b0f29540016",
    );
    expect(SERVICE_INSTANCE_CHALLENGE_PATTERN.test("not-a-challenge")).toBe(
      false,
    );
  });
});
