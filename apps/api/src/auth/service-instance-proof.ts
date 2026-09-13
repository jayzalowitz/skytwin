import { createHmac } from "node:crypto";

export const SERVICE_INSTANCE_CHALLENGE_PATTERN = /^[a-f0-9]{64}$/;

/** Prove that an API process holds the loopback service credential. */
export function createServiceInstanceProof(
  serviceToken: string,
  challenge: string,
): string {
  return createHmac("sha256", serviceToken)
    .update(`skytwin-api-instance-v1.${challenge}`)
    .digest("hex");
}
