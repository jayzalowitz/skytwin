import { createHmac, timingSafeEqual } from "node:crypto";

const PROOF_PATTERN = /^[a-f0-9]{64}$/;

function proofFor(instanceCapability: string, challenge: string): string {
  return createHmac("sha256", instanceCapability)
    .update(`skytwin-api-instance-v1.${challenge}`)
    .digest("hex");
}

/** Verify that a health responder holds this spawn's instance capability. */
export function verifyServiceInstanceProof(
  instanceCapability: string,
  challenge: string,
  presentedProof: unknown,
): boolean {
  if (
    typeof presentedProof !== "string" ||
    !PROOF_PATTERN.test(presentedProof)
  ) {
    return false;
  }
  const expected = Buffer.from(proofFor(instanceCapability, challenge), "hex");
  const presented = Buffer.from(presentedProof, "hex");
  return timingSafeEqual(expected, presented);
}
