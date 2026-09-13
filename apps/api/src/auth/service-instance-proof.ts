import { createHmac } from "node:crypto";

export const SERVICE_INSTANCE_CHALLENGE_PATTERN = /^[a-f0-9]{64}$/;

/** Prove that this exact API spawn holds its unpersisted instance capability. */
export function createServiceInstanceProof(
  instanceCapability: string,
  challenge: string,
): string {
  return createHmac("sha256", instanceCapability)
    .update(`skytwin-api-instance-v1.${challenge}`)
    .digest("hex");
}
