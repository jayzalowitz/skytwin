import { createHash, randomBytes } from "node:crypto";
import { URL } from "node:url";
import type {
  AttestationPolicy,
  ConfidentialFailure,
  ConfidentialModel,
  ConfidentialOperationContext,
  ConfidentialResourceLimits,
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
const DEFAULT_STAGE_TIMEOUT_MS = 120_000;
const MAX_STAGE_TIMEOUT_MS = 300_000;
export const CONFIDENTIAL_RESOURCE_LIMITS: Readonly<ConfidentialResourceLimits> =
  Object.freeze({
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 8_388_608,
    maxCatalogModels: 256,
    maxApprovedMeasurements: 128,
    maxAttestationProofBytes: 4_194_304,
    maxStringChars: 16_384,
    maxSignatureChars: 65_536,
  });
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
  "resource_limit_exceeded",
]);

function failure(
  code: ConfidentialFailure["code"],
  message: string,
  promptTransmitted = false,
): ConfidentialFailure {
  return { ok: false, code, message, promptTransmitted };
}

class ResourceLimitError extends Error {}

interface StageSuccess<T> {
  timedOut: false;
  value: T;
}

interface StageTimeout {
  timedOut: true;
}

type StageResult<T> = StageSuccess<T> | StageTimeout;

async function runStage<T>(
  timeoutMs: number,
  operation: (context: ConfidentialOperationContext) => Promise<T>,
): Promise<StageResult<T>> {
  const controller = new AbortController();
  const context = Object.freeze({
    signal: controller.signal,
    timeoutMs,
    limits: CONFIDENTIAL_RESOURCE_LIMITS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StageTimeout>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => operation(context))
        .then((value): StageSuccess<T> => ({ timedOut: false, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function representableModelId(value: string): boolean {
  return value.trim() !== "" && !value.includes(":");
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
    representableModelId(policy.modelId) &&
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
  if (
    rawApprovedMeasurements.length >
    CONFIDENTIAL_RESOURCE_LIMITS.maxApprovedMeasurements
  ) {
    throw new ResourceLimitError("Too many approved measurements");
  }
  const approvedMeasurements = Array.from(rawApprovedMeasurements);
  const modelId = policy.modelId;
  const directEndpoint = policy.directEndpoint;
  const maxAgeMs = policy.maxAgeMs;
  const verifierVersion = policy.verifierVersion;
  const signatureAlgorithm = policy.signatureAlgorithm;
  const signatureProvenance = policy.signatureProvenance;
  const scalarValues: unknown[] = [
    modelId,
    directEndpoint,
    verifierVersion,
    ...approvedMeasurements,
  ];
  if (scalarValues.some((value) => typeof value !== "string")) {
    throw new Error("Confidential policy strings are malformed");
  }
  const stringValues = scalarValues as string[];
  if (
    stringValues.some(
      (value) => value.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars,
    )
  ) {
    throw new ResourceLimitError("Confidential policy strings are too large");
  }
  return Object.freeze({
    modelId,
    directEndpoint,
    approvedMeasurements: Object.freeze(approvedMeasurements),
    maxAgeMs,
    verifierVersion,
    signatureAlgorithm,
    signatureProvenance,
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
  if (
    tdxQuote.byteLength >
      CONFIDENTIAL_RESOURCE_LIMITS.maxAttestationProofBytes ||
    gpuEvidence.byteLength >
      CONFIDENTIAL_RESOURCE_LIMITS.maxAttestationProofBytes
  ) {
    throw new ResourceLimitError("Attestation proof bytes are too large");
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
  if (scalarValues.some((value) => typeof value !== "string")) {
    throw new Error("Attestation evidence contains malformed scalar fields");
  }
  const stringValues = scalarValues as string[];
  if (
    stringValues.some(
      (value) => value.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars,
    )
  ) {
    throw new ResourceLimitError("Attestation evidence strings are too large");
  }
  if (
    typeof snapshot.sameConnection !== "boolean" ||
    typeof snapshot.attestation.tdxVerified !== "boolean" ||
    typeof snapshot.attestation.gpuVerified !== "boolean"
  ) {
    throw new Error("Attestation evidence contains malformed scalar fields");
  }
  return Object.freeze(snapshot);
}

function snapshotModel(model: ConfidentialModel): Readonly<ConfidentialModel> {
  const snapshot = {
    id: model.id,
    directEndpoint: model.directEndpoint,
    verifiable: model.verifiable,
    attestationSupported: model.attestationSupported,
    vllmCompatible: model.vllmCompatible,
  };
  if (
    typeof snapshot.id !== "string" ||
    typeof snapshot.directEndpoint !== "string"
  ) {
    throw new Error("Catalog model fields are malformed");
  }
  if (
    snapshot.id.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars ||
    snapshot.directEndpoint.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars
  ) {
    throw new ResourceLimitError("Catalog model fields are too large");
  }
  return Object.freeze(snapshot);
}

function snapshotCatalog(
  models: readonly ConfidentialModel[],
): readonly Readonly<ConfidentialModel>[] {
  if (!Array.isArray(models)) throw new Error("Catalog is not an array");
  if (models.length > CONFIDENTIAL_RESOURCE_LIMITS.maxCatalogModels) {
    throw new ResourceLimitError("Catalog is too large");
  }
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
    if (
      bytes.byteLength > CONFIDENTIAL_RESOURCE_LIMITS.maxResponseBytes ||
      chatId.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars ||
      modelId.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars
    ) {
      throw new ResourceLimitError("Confidential response is too large");
    }
    return Object.freeze({
      bytes: Uint8Array.from(bytes),
      chatId,
      modelId,
    });
  } catch (error) {
    if (error instanceof ResourceLimitError) throw error;
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
    if (
      snapshot.signature.length >
        CONFIDENTIAL_RESOURCE_LIMITS.maxSignatureChars ||
      Object.entries(snapshot).some(
        ([key, value]) =>
          key !== "signature" &&
          value.length > CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars,
      )
    ) {
      throw new ResourceLimitError("Signature record is too large");
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof ResourceLimitError) throw error;
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
      model.id.length <= CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars &&
      representableModelId(model.id) &&
      typeof model.directEndpoint === "string" &&
      model.directEndpoint.length <=
        CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars &&
      isEligibleEndpoint(model.directEndpoint)
    );
  } catch {
    return false;
  }
}

export interface StrictConfidentialClientOptions {
  now?: () => number;
  nonce?: () => Uint8Array;
  /** Testable per-stage deadline, capped at five minutes. */
  stageTimeoutMs?: number;
}

interface BoundVerifiedChannel {
  send: VerifiedChannel["send"];
  retrieveSignature: VerifiedChannel["retrieveSignature"];
  verifyExactResponse: VerifiedChannel["verifyExactResponse"];
  close: VerifiedChannel["close"];
}

function bindVerifiedChannel(channel: VerifiedChannel): BoundVerifiedChannel {
  const send = channel.send;
  const retrieveSignature = channel.retrieveSignature;
  const verifyExactResponse = channel.verifyExactResponse;
  const close = channel.close;
  if (
    typeof send !== "function" ||
    typeof retrieveSignature !== "function" ||
    typeof verifyExactResponse !== "function" ||
    typeof close !== "function"
  ) {
    throw new Error("Verified channel methods are malformed");
  }
  return Object.freeze({
    send: send.bind(channel),
    retrieveSignature: retrieveSignature.bind(channel),
    verifyExactResponse: verifyExactResponse.bind(channel),
    close: close.bind(channel),
  });
}

/** Strict confidential orchestration with no ordinary HTTP implementation or fallback. */
export class StrictConfidentialClient {
  private readonly now: () => number;
  private readonly nonce: () => Uint8Array;
  private readonly discoverModels: ConfidentialTransport["discoverModels"];
  private readonly openVerifiedChannel: ConfidentialTransport["openVerifiedChannel"];
  private readonly stageTimeoutMs: number;

  constructor(
    transport: ConfidentialTransport,
    options: StrictConfidentialClientOptions = {},
  ) {
    let discoverModels: ConfidentialTransport["discoverModels"] | undefined;
    let openVerifiedChannel:
      ConfidentialTransport["openVerifiedChannel"] | undefined;
    try {
      discoverModels = transport.discoverModels;
      openVerifiedChannel = transport.openVerifiedChannel;
    } catch {
      discoverModels = undefined;
      openVerifiedChannel = undefined;
    }
    this.discoverModels =
      typeof discoverModels === "function"
        ? discoverModels.bind(transport)
        : async () => {
            throw new Error("Catalog discovery is unavailable");
          };
    this.openVerifiedChannel =
      typeof openVerifiedChannel === "function"
        ? openVerifiedChannel.bind(transport)
        : async () => {
            throw new Error("Confidential verifier is unavailable");
          };
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(32));
    const requestedTimeout = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    this.stageTimeoutMs =
      Number.isInteger(requestedTimeout) &&
      requestedTimeout > 0 &&
      requestedTimeout <= MAX_STAGE_TIMEOUT_MS
        ? requestedTimeout
        : DEFAULT_STAGE_TIMEOUT_MS;
  }

  private async closeChannel(channel: BoundVerifiedChannel): Promise<boolean> {
    try {
      const closed = await runStage(this.stageTimeoutMs, (context) =>
        channel.close(context),
      );
      return !closed.timedOut;
    } catch {
      return false;
    }
  }

  private async finishChannel(
    channel: BoundVerifiedChannel,
    result: ConfidentialResult,
    promptTransmitted: boolean,
  ): Promise<ConfidentialResult> {
    if (await this.closeChannel(channel)) return result;
    if (!result.ok) return result;
    return failure(
      "transport_failed",
      "The verified channel could not be closed within its deadline.",
      promptTransmitted,
    );
  }

  async generate(
    requestBytes: Uint8Array,
    policy: AttestationPolicy,
  ): Promise<ConfidentialResult> {
    let requestSnapshot: Uint8Array;
    try {
      if (!(requestBytes instanceof Uint8Array)) {
        throw new Error("Request bytes are malformed");
      }
      if (
        requestBytes.byteLength > CONFIDENTIAL_RESOURCE_LIMITS.maxRequestBytes
      ) {
        return failure(
          "resource_limit_exceeded",
          "The confidential request exceeds the byte limit.",
        );
      }
      requestSnapshot = Uint8Array.from(requestBytes);
      policy = snapshotPolicy(policy);
      if (!validPolicy(policy))
        return failure(
          "invalid_policy",
          "The confidential inference policy is incomplete or invalid.",
        );
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        return failure(
          "resource_limit_exceeded",
          "The confidential inference policy exceeds its resource limits.",
        );
      }
      return failure(
        "invalid_policy",
        "The confidential inference policy is incomplete or invalid.",
      );
    }

    let models: readonly ConfidentialModel[];
    try {
      const catalog = await runStage(this.stageTimeoutMs, (context) =>
        this.discoverModels(context),
      );
      if (catalog.timedOut) {
        return failure(
          "catalog_unavailable",
          "The live confidential model catalog timed out.",
        );
      }
      models = snapshotCatalog(catalog.value);
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        return failure(
          "resource_limit_exceeded",
          "The live confidential model catalog exceeds its resource limits.",
        );
      }
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
      const opened = await runStage(this.stageTimeoutMs, (context) =>
        this.openVerifiedChannel(
          {
            policy: snapshotPolicy(policy),
            nonce: Uint8Array.from(clientNonce),
          },
          context,
        ),
      );
      if (opened.timedOut) {
        return failure(
          "verifier_unavailable",
          "The confidential verifier timed out while establishing a channel.",
        );
      }
      channel = opened.value;
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

    let boundChannel: BoundVerifiedChannel;
    try {
      boundChannel = bindVerifiedChannel(channel);
    } catch {
      return failure(
        "verifier_unavailable",
        "The confidential verifier returned a malformed channel.",
      );
    }

    let promptTransmitted = false;
    const finish = (result: ConfidentialResult) =>
      this.finishChannel(boundChannel, result, promptTransmitted);

    try {
      let evidence: VerifiedChannel["evidence"];
      try {
        evidence = snapshotEvidence(channel.evidence);
      } catch (error) {
        return finish(
          error instanceof ResourceLimitError
            ? failure(
                "resource_limit_exceeded",
                "Hardware attestation proof exceeds its byte or string limits.",
              )
            : failure(
                "attestation_invalid",
                "Hardware attestation proof is malformed or unavailable.",
              ),
        );
      }

      let now: number;
      try {
        now = this.now();
      } catch {
        return finish(
          failure(
            "verifier_unavailable",
            "The attestation clock is unavailable.",
          ),
        );
      }
      const ageMs = now - Date.parse(evidence.verifiedAt);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > policy.maxAgeMs) {
        return finish(
          failure(
            "attestation_stale",
            "Attestation evidence is outside the configured freshness window.",
          ),
        );
      }
      if (
        evidence.attestation.tdxVerified !== true ||
        evidence.attestation.gpuVerified !== true ||
        evidence.attestation.tdxQuote.byteLength === 0 ||
        evidence.attestation.gpuEvidence.byteLength === 0
      ) {
        return finish(
          failure(
            "attestation_invalid",
            "Hardware attestation proof is incomplete or invalid.",
          ),
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
        return finish(
          failure(
            "tls_binding_invalid",
            "Attestation does not bind the client nonce, signer, and live TLS key.",
          ),
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
        return finish(
          failure(
            "attestation_policy_mismatch",
            "Attestation evidence does not satisfy the configured policy.",
          ),
        );
      }

      promptTransmitted = true;
      let rawResponse: ExactResponse;
      try {
        const sent = await runStage(this.stageTimeoutMs, (context) =>
          boundChannel.send(Uint8Array.from(requestSnapshot), context),
        );
        if (sent.timedOut) {
          return finish(
            failure(
              "transport_failed",
              "The verified confidential request timed out.",
              true,
            ),
          );
        }
        rawResponse = sent.value;
      } catch {
        return finish(
          failure(
            "transport_failed",
            "The verified confidential request failed.",
            true,
          ),
        );
      }
      let wireResponse: Readonly<ExactResponse> | null;
      try {
        wireResponse = snapshotResponse(rawResponse);
      } catch (error) {
        return finish(
          error instanceof ResourceLimitError
            ? failure(
                "resource_limit_exceeded",
                "The confidential response exceeds its byte or string limits.",
                true,
              )
            : failure(
                "response_signature_invalid",
                "The response identity does not match the request.",
                true,
              ),
        );
      }
      if (
        !wireResponse ||
        wireResponse.chatId.length === 0 ||
        wireResponse.modelId !== policy.modelId
      ) {
        return finish(
          failure(
            "response_signature_invalid",
            "The response identity does not match the request.",
            true,
          ),
        );
      }
      const responseSnapshot = Uint8Array.from(wireResponse.bytes);

      let signature: Readonly<NormalizedResponseSignatureRecord> | null;
      try {
        const retrieved = await runStage(this.stageTimeoutMs, (context) =>
          boundChannel.retrieveSignature(
            {
              chatId: wireResponse.chatId,
              modelId: policy.modelId,
              algorithm: policy.signatureAlgorithm,
            },
            context,
          ),
        );
        if (retrieved.timedOut) {
          return finish(
            failure(
              "signature_unavailable",
              "The response signature lookup timed out.",
              true,
            ),
          );
        }
        signature = snapshotSignature(retrieved.value);
      } catch (error) {
        if (error instanceof ResourceLimitError) {
          return finish(
            failure(
              "resource_limit_exceeded",
              "The response signature record exceeds its string limits.",
              true,
            ),
          );
        }
        return finish(
          failure(
            "signature_unavailable",
            "The response signature record could not be retrieved.",
            true,
          ),
        );
      }
      if (!signature)
        return finish(
          failure(
            "response_signature_invalid",
            "The response signature record is malformed.",
            true,
          ),
        );
      if (
        signature.chatId !== wireResponse.chatId ||
        signature.modelId !== policy.modelId ||
        signature.algorithm !== policy.signatureAlgorithm
      ) {
        return finish(
          failure(
            "response_signature_invalid",
            "The signature record is not bound to this model and chat.",
            true,
          ),
        );
      }
      if (signature.provenance !== evidence.signatureProvenance)
        return finish(
          failure(
            "response_provenance_mismatch",
            "The response signature has the wrong provenance.",
            true,
          ),
        );
      if (signature.signingIdentity !== evidence.signingIdentity)
        return finish(
          failure(
            "response_signer_mismatch",
            "The response signer is not the TLS-attested signer.",
            true,
          ),
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
        return finish(
          failure(
            "response_signature_invalid",
            "The signed text does not bind the exact request and response bytes.",
            true,
          ),
        );
      }

      let verified: boolean;
      try {
        const verification = await runStage(this.stageTimeoutMs, (context) =>
          boundChannel.verifyExactResponse(
            {
              requestBytes: Uint8Array.from(requestSnapshot),
              responseBytes: Uint8Array.from(responseSnapshot),
              response: Object.freeze({
                ...wireResponse,
                bytes: Uint8Array.from(responseSnapshot),
              }),
              signature: Object.freeze({ ...signature }),
            },
            context,
          ),
        );
        if (verification.timedOut) {
          return finish(
            failure(
              "transport_failed",
              "Exact response verification timed out.",
              true,
            ),
          );
        }
        verified = verification.value;
      } catch {
        return finish(
          failure(
            "transport_failed",
            "Exact response verification failed.",
            true,
          ),
        );
      }
      if (verified !== true)
        return finish(
          failure(
            "response_signature_invalid",
            "The exact response bytes failed signature verification.",
            true,
          ),
        );
      return finish({
        ok: true,
        bytes: Uint8Array.from(responseSnapshot),
        chatId: wireResponse.chatId,
        evidence,
      });
    } catch {
      return finish(
        failure(
          "transport_failed",
          "The verified confidential request failed.",
          promptTransmitted,
        ),
      );
    }
  }
}
