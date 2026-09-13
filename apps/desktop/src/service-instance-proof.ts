import { createHmac, timingSafeEqual } from "node:crypto";

const PROOF_PATTERN = /^[a-f0-9]{64}$/;

function proofFor(serviceToken: string, challenge: string): string {
  return createHmac("sha256", serviceToken)
    .update(`skytwin-api-instance-v1.${challenge}`)
    .digest("hex");
}

/** Verify that a health responder holds this install's service credential. */
export function verifyServiceInstanceProof(
  serviceToken: string,
  challenge: string,
  presentedProof: unknown,
): boolean {
  if (
    typeof presentedProof !== "string" ||
    !PROOF_PATTERN.test(presentedProof)
  ) {
    return false;
  }
  const expected = Buffer.from(proofFor(serviceToken, challenge), "hex");
  const presented = Buffer.from(presentedProof, "hex");
  return timingSafeEqual(expected, presented);
}
