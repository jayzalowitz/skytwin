import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import type {
  AttestationPolicy,
  ConfidentialFailure,
  ConfidentialModel,
  ConfidentialResult,
  ConfidentialTransport,
  ExactResponse,
  NormalizedResponseSignatureRecord,
  VerifiedChannel,
} from "./types.js";

const DIRECT_ENDPOINT_SUFFIX = ".completions.near.ai";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const REPORT_DATA_SCHEME =
  "sha256(signing_identity||tls_spki_sha256)||nonce" as const;
const FAILURE_CODES = new Set<ConfidentialFailure["code"]>([
  "invalid_policy",
  "verifier_unavailable",
  "catalog_unavailable",
  "catalog_ambiguous",
  "model_ineligible",
  "endpoint_ineligible",
  "attestation_invalid",
  "attestation_stale",
  "attestation_policy_mismatch",
  "tls_binding_invalid",
  "transport_failed",
  "signature_unavailable",
  "response_signature_invalid",
  "response_signer_mismatch",
  "response_provenance_mismatch",
]);

function failure(
  code: ConfidentialFailure["code"],
  message: string,
  promptTransmitted = false,
): ConfidentialFailure {
  return { ok: false, code, message, promptTransmitted };
}
function isFailure(value: unknown): value is ConfidentialFailure {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      "ok" in value &&
      value.ok === false
    );
  } catch {
    return false;
  }
}
function snapshotPreTransmissionFailure(
  value: ConfidentialFailure,
): ConfidentialFailure | null {
  try {
    const code = value.code;
    const message = value.message;
    if (!FAILURE_CODES.has(code) || typeof message !== "string") return null;
    return failure(code, message, false);
  } catch {
    return null;
  }
}
function isEligibleEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.port === "" &&
      endpoint.pathname.replace(/\/$/, "") === "/v1" &&
      endpoint.search === "" &&
      endpoint.hash === "" &&
      endpoint.hostname.endsWith(DIRECT_ENDPOINT_SUFFIX) &&
      endpoint.hostname.length > DIRECT_ENDPOINT_SUFFIX.length
    );
  } catch {
    return false;
  }
}
function validPolicy(policy: AttestationPolicy): boolean {
  return (
    policy.modelId.trim() !== "" &&
    policy.verifierVersion.trim() !== "" &&
    Number.isFinite(policy.maxAgeMs) &&
    policy.maxAgeMs > 0 &&
    policy.approvedMeasurements.length > 0 &&
    policy.approvedMeasurements.every(
      (measurement) => measurement.trim() !== "",
    ) &&
    isEligibleEndpoint(policy.directEndpoint) &&
    (policy.signatureAlgorithm === "ecdsa-secp256k1" ||
      policy.signatureAlgorithm === "ed25519") &&
    policy.signatureProvenance === "provider_tee"
  );
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function signedHashesMatch(
  signedText: string,
  format: "model:request_sha256:response_sha256",
  modelId: string,
  request: Uint8Array,
  response: Uint8Array,
): boolean {
  const parts = signedText.split(":");
  if (format !== "model:request_sha256:response_sha256" || parts.length !== 3)
    return false;
  return (
    parts[0] === modelId &&
    parts[1] === sha256(request) &&
    parts[2] === sha256(response)
  );
}
function snapshotPolicy(policy: AttestationPolicy): AttestationPolicy {
  const rawApprovedMeasurements = policy.approvedMeasurements;
  if (!Array.isArray(rawApprovedMeasurements)) {
    throw new Error("Approved measurements must be an array");
  }
  const approvedMeasurements = Object.freeze(
    Array.from(rawApprovedMeasurements),
  );
  return Object.freeze({
    modelId: policy.modelId,
    directEndpoint: policy.directEndpoint,
    approvedMeasurements,
    maxAgeMs: policy.maxAgeMs,
    verifierVersion: policy.verifierVersion,
    signatureAlgorithm: policy.signatureAlgorithm,
    signatureProvenance: policy.signatureProvenance,
  });
}

function snapshotEvidence(
  evidence: VerifiedChannel["evidence"],
): VerifiedChannel["evidence"] {
  const attestation = evidence.attestation;
  const reportData = attestation.reportData;
  const tdxQuote = attestation.tdxQuote;
  const gpuEvidence = attestation.gpuEvidence;
  if (
    !(tdxQuote instanceof Uint8Array) ||
    !(gpuEvidence instanceof Uint8Array)
  ) {
    throw new Error("Attestation proof bytes are malformed");
  }
  const snapshot = {
    modelId: evidence.modelId,
    directEndpoint: evidence.directEndpoint,
    verifiedAt: evidence.verifiedAt,
    verifierVersion: evidence.verifierVersion,
    signingIdentity: evidence.signingIdentity,
    signatureAlgorithm: evidence.signatureAlgorithm,
    signatureProvenance: evidence.signatureProvenance,
    tlsSpkiSha256: evidence.tlsSpkiSha256,
    sameConnection: evidence.sameConnection,
    attestation: Object.freeze({
      tdxQuote: Uint8Array.from(tdxQuote),
      tdxVerified: attestation.tdxVerified,
      gpuEvidence: Uint8Array.from(gpuEvidence),
      gpuVerified: attestation.gpuVerified,
      measurement: attestation.measurement,
      modelName: attestation.modelName,
      reportData: Object.freeze({
        scheme: reportData.scheme,
        signingIdentity: reportData.signingIdentity,
        tlsSpkiSha256: reportData.tlsSpkiSha256,
        nonceHex: reportData.nonceHex,
      }),
    }),
  };
  const scalarValues: unknown[] = [
    snapshot.modelId,
    snapshot.directEndpoint,
    snapshot.verifiedAt,
    snapshot.verifierVersion,
    snapshot.signingIdentity,
    snapshot.signatureAlgorithm,
    snapshot.signatureProvenance,
    snapshot.tlsSpkiSha256,
    snapshot.attestation.measurement,
    snapshot.attestation.modelName,
    snapshot.attestation.reportData.scheme,
    snapshot.attestation.reportData.signingIdentity,
    snapshot.attestation.reportData.tlsSpkiSha256,
    snapshot.attestation.reportData.nonceHex,
  ];
  if (
    scalarValues.some((value) => typeof value !== "string") ||
    typeof snapshot.sameConnection !== "boolean" ||
    typeof snapshot.attestation.tdxVerified !== "boolean" ||
    typeof snapshot.attestation.gpuVerified !== "boolean"
  ) {
    throw new Error("Attestation evidence contains malformed scalar fields");
  }
  return Object.freeze(snapshot);
}

function snapshotModel(model: ConfidentialModel): Readonly<ConfidentialModel> {
  return Object.freeze({
    id: model.id,
    directEndpoint: model.directEndpoint,
    verifiable: model.verifiable,
    attestationSupported: model.attestationSupported,
    vllmCompatible: model.vllmCompatible,
  });
}

function snapshotCatalog(
  models: readonly ConfidentialModel[],
): readonly Readonly<ConfidentialModel>[] {
  if (!Array.isArray(models)) throw new Error("Catalog is not an array");
  return Object.freeze(models.map(snapshotModel));
}

function snapshotResponse(
  response: ExactResponse,
): Readonly<ExactResponse> | null {
  try {
    const bytes = response.bytes;
    const chatId = response.chatId;
    const modelId = response.modelId;
    if (
      !(bytes instanceof Uint8Array) ||
      typeof chatId !== "string" ||
      typeof modelId !== "string"
    )
      return null;
    return Object.freeze({
      bytes: Uint8Array.from(bytes),
      chatId,
      modelId,
    });
  } catch {
    return null;
  }
}

function snapshotSignature(
  signature: NormalizedResponseSignatureRecord,
): Readonly<NormalizedResponseSignatureRecord> | null {
  try {
    const snapshot = {
      chatId: signature.chatId,
      modelId: signature.modelId,
      signedText: signature.signedText,
      signature: signature.signature,
      signingIdentity: signature.signingIdentity,
      algorithm: signature.algorithm,
      scheme: signature.scheme,
      signedTextFormat: signature.signedTextFormat,
      provenance: signature.provenance,
    };
    if (Object.values(snapshot).some((value) => typeof value !== "string"))
      return null;
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

export function isEligibleDirectModel(model: ConfidentialModel): boolean {
  try {
    return (
      model.verifiable === true &&
      model.attestationSupported === true &&
      model.vllmCompatible === true &&
      typeof model.id === "string" &&
      model.id.trim() !== "" &&
      typeof model.directEndpoint === "string" &&
      isEligibleEndpoint(model.directEndpoint)
    );
  } catch {
    return false;
  }
}

export interface StrictConfidentialClientOptions {
  now?: () => number;
  nonce?: () => Uint8Array;
}

/** Strict confidential orchestration with no ordinary HTTP implementation or fallback. */
export class StrictConfidentialClient {
  private readonly now: () => number;
  private readonly nonce: () => Uint8Array;

  constructor(
    private readonly transport: ConfidentialTransport,
    options: StrictConfidentialClientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(32));
  }

  private async closeIgnoringFailure(
    channel: Pick<VerifiedChannel, "close">,
  ): Promise<void> {
    try {
      await channel.close();
    } catch {
      /* the security result is already final */
    }
  }

  async generate(
    requestBytes: Uint8Array,
    policy: AttestationPolicy,
  ): Promise<ConfidentialResult> {
    let requestSnapshot: Uint8Array;
    try {
      requestSnapshot = Uint8Array.from(requestBytes);
      policy = snapshotPolicy(policy);
      if (!validPolicy(policy))
        return failure(
          "invalid_policy",
          "The confidential inference policy is incomplete or invalid.",
        );
    } catch {
      return failure(
        "invalid_policy",
        "The confidential inference policy is incomplete or invalid.",
      );
    }

    let models: readonly ConfidentialModel[];
    try {
      models = snapshotCatalog(await this.transport.discoverModels());
    } catch {
      return failure(
        "catalog_unavailable",
        "The live confidential model catalog could not be verified.",
      );
    }

    const matches = models.filter(
      (candidate) => candidate.id === policy.modelId,
    );
    if (matches.length > 1)
      return failure(
        "catalog_ambiguous",
        "The live catalog contains duplicate model identities.",
      );
    const model = matches[0];
    if (!model || !isEligibleDirectModel(model))
      return failure(
        "model_ineligible",
        "The selected model is not currently eligible for strict confidential inference.",
      );
    if (model.directEndpoint !== policy.directEndpoint)
      return failure(
        "endpoint_ineligible",
        "The selected direct endpoint does not match the live catalog.",
      );

    let clientNonce: Uint8Array;
    try {
      clientNonce = Uint8Array.from(this.nonce());
    } catch {
      return failure(
        "verifier_unavailable",
        "A fresh attestation nonce could not be generated.",
      );
    }
    if (clientNonce.byteLength !== 32)
      return failure(
        "invalid_policy",
        "The attestation nonce generator must return 32 bytes.",
      );

    let channel: VerifiedChannel | ConfidentialFailure;
    try {
      channel = await this.transport.openVerifiedChannel({
        policy: snapshotPolicy(policy),
        nonce: Uint8Array.from(clientNonce),
      });
    } catch {
      return failure(
        "verifier_unavailable",
        "The confidential verifier could not establish a verified channel.",
      );
    }
    if (isFailure(channel)) {
      return (
        snapshotPreTransmissionFailure(channel) ??
        failure(
          "verifier_unavailable",
          "The confidential verifier returned a malformed failure.",
        )
      );
    }

    try {
      let evidence: VerifiedChannel["evidence"];
      try {
        evidence = snapshotEvidence(channel.evidence);
      } catch {
        return failure(
          "attestation_invalid",
          "Hardware attestation proof is malformed or unavailable.",
        );
      }

      let now: number;
      try {
        now = this.now();
      } catch {
        return failure(
          "verifier_unavailable",
          "The attestation clock is unavailable.",
        );
      }
      const ageMs = now - Date.parse(evidence.verifiedAt);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > policy.maxAgeMs) {
        return failure(
          "attestation_stale",
          "Attestation evidence is outside the configured freshness window.",
        );
      }
      if (
        evidence.attestation.tdxVerified !== true ||
        evidence.attestation.gpuVerified !== true ||
        evidence.attestation.tdxQuote.byteLength === 0 ||
        evidence.attestation.gpuEvidence.byteLength === 0
      ) {
        return failure(
          "attestation_invalid",
          "Hardware attestation proof is incomplete or invalid.",
        );
      }
      const reportData = evidence.attestation.reportData;
      if (
        evidence.sameConnection !== true ||
        reportData.scheme !== REPORT_DATA_SCHEME ||
        reportData.nonceHex !== Buffer.from(clientNonce).toString("hex") ||
        reportData.signingIdentity !== evidence.signingIdentity ||
        reportData.tlsSpkiSha256 !== evidence.tlsSpkiSha256 ||
        !SHA256_HEX.test(evidence.tlsSpkiSha256)
      ) {
        return failure(
          "tls_binding_invalid",
          "Attestation does not bind the client nonce, signer, and live TLS key.",
        );
      }
      if (
        evidence.modelId !== policy.modelId ||
        evidence.directEndpoint !== policy.directEndpoint ||
        evidence.verifierVersion !== policy.verifierVersion ||
        evidence.signatureAlgorithm !== policy.signatureAlgorithm ||
        evidence.signatureProvenance !== policy.signatureProvenance ||
        evidence.attestation.modelName !== policy.modelId ||
        !policy.approvedMeasurements.includes(evidence.attestation.measurement)
      ) {
        return failure(
          "attestation_policy_mismatch",
          "Attestation evidence does not satisfy the configured policy.",
        );
      }

      const wireResponse = snapshotResponse(
        await channel.send(Uint8Array.from(requestSnapshot)),
      );
      if (
        !wireResponse ||
        wireResponse.chatId.length === 0 ||
        wireResponse.modelId !== policy.modelId
      ) {
        return failure(
          "response_signature_invalid",
          "The response identity does not match the request.",
          true,
        );
      }
      const responseSnapshot = Uint8Array.from(wireResponse.bytes);

      let signature: Readonly<NormalizedResponseSignatureRecord> | null;
      try {
        signature = snapshotSignature(
          await channel.retrieveSignature({
            chatId: wireResponse.chatId,
            modelId: policy.modelId,
            algorithm: policy.signatureAlgorithm,
          }),
        );
      } catch {
        return failure(
          "signature_unavailable",
          "The response signature record could not be retrieved.",
          true,
        );
      }
      if (!signature)
        return failure(
          "response_signature_invalid",
          "The response signature record is malformed.",
          true,
        );
      if (
        signature.chatId !== wireResponse.chatId ||
        signature.modelId !== policy.modelId ||
        signature.algorithm !== policy.signatureAlgorithm
      ) {
        return failure(
          "response_signature_invalid",
          "The signature record is not bound to this model and chat.",
          true,
        );
      }
      if (signature.provenance !== evidence.signatureProvenance)
        return failure(
          "response_provenance_mismatch",
          "The response signature has the wrong provenance.",
          true,
        );
      if (signature.signingIdentity !== evidence.signingIdentity)
        return failure(
          "response_signer_mismatch",
          "The response signer is not the TLS-attested signer.",
          true,
        );
      const expectedScheme =
        policy.signatureAlgorithm === "ecdsa-secp256k1"
          ? "eip191-personal-sign"
          : "ed25519-raw";
      if (
        signature.scheme !== expectedScheme ||
        !signedHashesMatch(
          signature.signedText,
          signature.signedTextFormat,
          policy.modelId,
          requestSnapshot,
          responseSnapshot,
        )
      ) {
        return failure(
          "response_signature_invalid",
          "The signed text does not bind the exact request and response bytes.",
          true,
        );
      }

      const verified = await channel.verifyExactResponse({
        requestBytes: Uint8Array.from(requestSnapshot),
        responseBytes: Uint8Array.from(responseSnapshot),
        response: Object.freeze({
          ...wireResponse,
          bytes: Uint8Array.from(responseSnapshot),
        }),
        signature: Object.freeze({ ...signature }),
      });
      if (verified !== true)
        return failure(
          "response_signature_invalid",
          "The exact response bytes failed signature verification.",
          true,
        );
      return {
        ok: true,
        bytes: Uint8Array.from(responseSnapshot),
        chatId: wireResponse.chatId,
        evidence,
      };
    } catch {
      return failure(
        "transport_failed",
        "The verified confidential request failed.",
        true,
      );
    } finally {
      await this.closeIgnoringFailure(channel);
    }
  }
}
