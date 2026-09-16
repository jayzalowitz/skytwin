import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { connect, type TLSSocket } from "node:tls";
import {
  js_get_collateral as getCollateral,
  js_verify as verifyQuote,
} from "@phala/dcap-qvl-node";
import type {
  AttestationPolicy,
  ConfidentialFailure,
  ConfidentialModel,
  ConfidentialOperationContext,
  ConfidentialTransport,
  ExactResponse,
  NormalizedResponseSignatureRecord,
  VerifiedChannel,
  VerifiedChannelEvidence,
} from "./types.js";

const CATALOG_URL = "https://completions.near.ai/endpoints";
const INTEL_PCCS_URL = "https://api.trustedservices.intel.com/tdx/certification/v4";
const NVIDIA_NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const MAX_HEADER_BYTES = 64 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX_64 = /^[a-f0-9]{64}$/i;
const HEX_128 = /^[a-f0-9]{128}$/i;
const DIRECT_HOST = /^[a-z0-9-]+\.completions\.near\.ai$/;
const ACCEPTED_TDX_STATUSES = new Set(["UpToDate", "OutOfDate"]);

export const NEAR_VERIFIER_VERSION =
  "nearai-cloud-verifier@94554726fd54262a907273f880b57ade0597b086+skytwin-direct-v1";

interface HttpResponseBytes {
  statusCode: number;
  headers: ReadonlyMap<string, string>;
  body: Uint8Array;
}

interface VerifiedAttestation {
  evidence: VerifiedChannelEvidence;
  signerPublicKey: ReturnType<typeof createPublicKey>;
}

function failure(
  code: ConfidentialFailure["code"],
  message: string,
): ConfidentialFailure {
  return { ok: false, code, message, promptTransmitted: false };
}

function exactRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const record = exactRecord(value);
    if (!record) throw new Error(`${label} is not an object`);
    return record;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseHeaders(raw: string): { statusCode: number; headers: Map<string, string> } {
  const lines = raw.split("\r\n");
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: .*)?$/.exec(lines.shift() ?? "");
  if (!status) throw new Error("NEAR AI returned an invalid HTTP status line");
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("NEAR AI returned a malformed HTTP header");
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name)) throw new Error(`NEAR AI returned duplicate ${name} headers`);
    headers.set(name, value);
  }
  return { statusCode: Number(status[1]), headers };
}

function parseChunkedBody(
  bytes: Buffer,
  bodyStart: number,
  maxBodyBytes: number,
): { body: Buffer; end: number } | null {
  const chunks: Buffer[] = [];
  let total = 0;
  let offset = bodyStart;
  while (true) {
    const lineEnd = bytes.indexOf("\r\n", offset, "latin1");
    if (lineEnd < 0) return null;
    const sizeText = bytes.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0] ?? "";
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error("NEAR AI returned invalid chunk framing");
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size)) throw new Error("NEAR AI returned an oversized chunk");
    offset = lineEnd + 2;
    if (size === 0) {
      const trailerEnd = bytes.indexOf("\r\n\r\n", offset, "latin1");
      if (trailerEnd >= 0) return { body: Buffer.concat(chunks, total), end: trailerEnd + 4 };
      if (bytes.length >= offset + 2 && bytes.subarray(offset, offset + 2).equals(Buffer.from("\r\n"))) {
        return { body: Buffer.concat(chunks, total), end: offset + 2 };
      }
      return null;
    }
    if (total + size > maxBodyBytes) throw new Error("NEAR AI response exceeded its byte limit");
    if (bytes.length < offset + size + 2) return null;
    if (!bytes.subarray(offset + size, offset + size + 2).equals(Buffer.from("\r\n"))) {
      throw new Error("NEAR AI returned invalid chunk framing");
    }
    chunks.push(bytes.subarray(offset, offset + size));
    total += size;
    offset += size + 2;
  }
}

function tryParseResponse(
  bytes: Buffer,
  maxBodyBytes: number,
): { response: HttpResponseBytes; rest: Buffer } | null {
  const headerEnd = bytes.indexOf("\r\n\r\n", 0, "latin1");
  if (headerEnd < 0) {
    if (bytes.length > MAX_HEADER_BYTES) throw new Error("NEAR AI response headers exceeded their byte limit");
    return null;
  }
  if (headerEnd > MAX_HEADER_BYTES) throw new Error("NEAR AI response headers exceeded their byte limit");
  const { statusCode, headers } = parseHeaders(bytes.subarray(0, headerEnd).toString("latin1"));
  if (headers.get("connection")?.toLowerCase().split(",").some((token) => token.trim() === "close")) {
    throw new Error("NEAR AI closed the attested TLS connection before verification completed");
  }
  if (headers.has("content-encoding")) {
    throw new Error("NEAR AI returned an encoded body whose signed bytes are ambiguous");
  }
  const bodyStart = headerEnd + 4;
  const transferEncoding = headers.get("transfer-encoding")?.toLowerCase();
  let parsedBody: { body: Buffer; end: number } | null;
  if (transferEncoding === "chunked") {
    parsedBody = parseChunkedBody(bytes, bodyStart, maxBodyBytes);
  } else {
    if (transferEncoding) throw new Error("NEAR AI returned an unsupported transfer encoding");
    const rawLength = headers.get("content-length");
    if (rawLength === undefined || !/^[0-9]+$/.test(rawLength)) {
      throw new Error("NEAR AI response did not provide a valid Content-Length");
    }
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > maxBodyBytes) {
      throw new Error("NEAR AI response exceeded its byte limit");
    }
    if (bytes.length < bodyStart + length) return null;
    parsedBody = { body: bytes.subarray(bodyStart, bodyStart + length), end: bodyStart + length };
  }
  if (!parsedBody) return null;
  return {
    response: { statusCode, headers, body: Uint8Array.from(parsedBody.body) },
    rest: bytes.subarray(parsedBody.end),
  };
}

function assertHeader(value: string, name: string): void {
  if (/[^\x20-\x7e]/.test(value)) throw new Error(`${name} contains unsafe header characters`);
}

async function requestOnSocket(
  socket: TLSSocket,
  host: string,
  input: {
    method: "GET" | "POST";
    path: string;
    headers?: Readonly<Record<string, string>>;
    body?: Uint8Array;
  },
  context: ConfidentialOperationContext,
  maxBodyBytes: number,
): Promise<HttpResponseBytes> {
  if (socket.destroyed || socket.closed || !socket.writable) {
    throw new Error("The verified NEAR AI TLS connection is unavailable");
  }
  const body = input.body ? Buffer.from(input.body) : Buffer.alloc(0);
  const headers = {
    Host: host,
    Connection: "keep-alive",
    Accept: "application/json",
    ...input.headers,
    "Content-Length": String(body.byteLength),
  };
  Object.entries(headers).forEach(([name, value]) => assertHeader(value, name));
  const head = Buffer.from([
    `${input.method} ${input.path} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n"), "ascii");

  return new Promise((resolve, reject) => {
    let received: Buffer = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("timeout", onTimeout);
      context.signal.removeEventListener("abort", onAbort);
      socket.setTimeout(0);
    };
    const finish = (error?: Error, response?: HttpResponseBytes, rest: Uint8Array = new Uint8Array()) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.pause();
      if (rest.byteLength > 0) socket.unshift(Buffer.from(rest));
      if (error) reject(error);
      else resolve(response!);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > maxBodyBytes + MAX_HEADER_BYTES + 1024) {
        finish(new Error("NEAR AI response exceeded its byte limit"));
        return;
      }
      try {
        const parsed = tryParseResponse(received, maxBodyBytes);
        if (parsed) finish(undefined, parsed.response, parsed.rest);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("NEAR AI ended the verified TLS connection early"));
    const onTimeout = () => finish(new Error("NEAR AI request timed out"));
    const onAbort = () => finish(new Error("NEAR AI request was cancelled"));
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("timeout", onTimeout);
    context.signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(context.timeoutMs);
    socket.resume();
    socket.write(Buffer.concat([head, body]), (error?: Error | null) => {
      if (error) finish(error);
    });
  });
}

async function readBoundedFetchBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) throw new Error("Remote verifier response exceeded its byte limit");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function directEndpointParts(endpoint: string): { host: string; port: number } | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || url.pathname !== "/v1" || !DIRECT_HOST.test(url.hostname)) return null;
    return { host: url.hostname, port: url.port ? Number(url.port) : 443 };
  } catch {
    return null;
  }
}

async function openTls(
  host: string,
  port: number,
  context: ConfidentialOperationContext,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    });
    let settled = false;
    const cleanup = () => {
      socket.off("secureConnect", onSecure);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      context.signal.removeEventListener("abort", onAbort);
      socket.setTimeout(0);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onSecure = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.pause();
      resolve(socket);
    };
    const onError = (error: Error) => fail(error);
    const onTimeout = () => fail(new Error("NEAR AI TLS connection timed out"));
    const onAbort = () => fail(new Error("NEAR AI TLS connection was cancelled"));
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    context.signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(context.timeoutMs);
  });
}

function rawEd25519PublicKeyPem(hex: string): string {
  if (!HEX_64.test(hex)) throw new Error("NEAR AI returned a malformed Ed25519 signing key");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  }).export({ type: "spki", format: "pem" }).toString();
}

function spkiSha256(socket: TLSSocket): string {
  const certificate = socket.getPeerX509Certificate();
  if (!certificate) throw new Error("NEAR AI did not provide a live TLS certificate");
  const der = certificate.publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function quoteFields(result: unknown): {
  status: string;
  reportData: string;
  mrConfigId: string;
} {
  const root = exactRecord(result);
  const report = exactRecord(root?.["report"]);
  const td10 = exactRecord(report?.["TD10"]);
  const status = root?.["status"];
  const reportData = td10?.["report_data"];
  const mrConfigId = td10?.["mr_config_id"];
  if (typeof status !== "string" || !ACCEPTED_TDX_STATUSES.has(status)
      || typeof reportData !== "string" || !HEX_128.test(reportData)
      || typeof mrConfigId !== "string" || !/^[a-f0-9]{96}$/i.test(mrConfigId)) {
    throw new Error("NEAR AI TDX quote did not pass the accepted verification policy");
  }
  return { status, reportData: reportData.toLowerCase(), mrConfigId: mrConfigId.toLowerCase() };
}

async function verifyGpuEvidence(
  serialized: string,
  nonceHex: string,
  context: ConfidentialOperationContext,
): Promise<void> {
  const payload = exactRecord(JSON.parse(serialized) as unknown);
  if (!payload || typeof payload["nonce"] !== "string"
      || payload["nonce"].toLowerCase() !== nonceHex) {
    throw new Error("NEAR AI GPU evidence did not bind the client nonce");
  }
  const response = await fetch(NVIDIA_NRAS_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: serialized,
    signal: context.signal,
  });
  const bytes = await readBoundedFetchBody(response, context.limits.maxAttestationProofBytes);
  if (!response.ok) throw new Error(`NVIDIA NRAS rejected GPU evidence with HTTP ${response.status}`);
  const result: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!Array.isArray(result) || !Array.isArray(result[0]) || typeof result[0][1] !== "string") {
    throw new Error("NVIDIA NRAS returned malformed verification evidence");
  }
  const parts = result[0][1].split(".");
  if (parts.length !== 3) throw new Error("NVIDIA NRAS returned a malformed verdict token");
  const claims = exactRecord(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown);
  if (claims?.["x-nvidia-overall-att-result"] !== true) {
    throw new Error("NVIDIA NRAS did not approve the GPU evidence");
  }
}

async function verifyAttestation(
  responseBytes: Uint8Array,
  socket: TLSSocket,
  policy: AttestationPolicy,
  nonce: Uint8Array,
  context: ConfidentialOperationContext,
): Promise<VerifiedAttestation> {
  const attestation = parseJsonObject(responseBytes, "NEAR AI attestation");
  const nonceHex = Buffer.from(nonce).toString("hex");
  const modelName = attestation["model_name"];
  const signingIdentity = attestation["signing_address"];
  const signingPublicKey = attestation["signing_public_key"];
  const signingAlgorithm = attestation["signing_algo"];
  const requestNonce = attestation["request_nonce"];
  const quoteHex = attestation["intel_quote"];
  const gpuSerialized = attestation["nvidia_payload"];
  const attestedSpki = attestation["tls_cert_fingerprint"];
  const info = exactRecord(attestation["info"]);
  const tcbInfoValue = info?.["tcb_info"];
  const tcbInfo = typeof tcbInfoValue === "string"
    ? exactRecord(JSON.parse(tcbInfoValue) as unknown)
    : exactRecord(tcbInfoValue);
  const appCompose = tcbInfo?.["app_compose"];
  const advertisedComposeHash = info?.["compose_hash"];

  if (modelName !== policy.modelId || signingAlgorithm !== "ed25519"
      || typeof signingIdentity !== "string" || !HEX_64.test(signingIdentity)
      || signingPublicKey !== signingIdentity || requestNonce !== nonceHex
      || typeof quoteHex !== "string" || !/^[a-f0-9]+$/i.test(quoteHex) || quoteHex.length % 2 !== 0
      || typeof gpuSerialized !== "string" || typeof attestedSpki !== "string" || !HEX_64.test(attestedSpki)
      || typeof appCompose !== "string" || typeof advertisedComposeHash !== "string"
      || !HEX_64.test(advertisedComposeHash)) {
    throw new Error("NEAR AI attestation omitted required model, signer, TLS, or workload evidence");
  }
  const quote = Buffer.from(quoteHex, "hex");
  const gpuEvidence = Buffer.from(gpuSerialized, "utf8");
  if (quote.byteLength === 0 || quote.byteLength > context.limits.maxAttestationProofBytes
      || gpuEvidence.byteLength === 0 || gpuEvidence.byteLength > context.limits.maxAttestationProofBytes) {
    throw new Error("NEAR AI attestation proof exceeded its byte limit");
  }

  const liveSpki = spkiSha256(socket);
  if (liveSpki !== attestedSpki.toLowerCase()) {
    throw new Error("NEAR AI attestation did not bind the live TLS key");
  }
  const collateral = await getCollateral(INTEL_PCCS_URL, quote);
  const verifiedQuote: unknown = verifyQuote(
    quote,
    collateral,
    BigInt(Math.floor(Date.now() / 1000)),
  );
  const fields = quoteFields(verifiedQuote);
  const signerBytes = Buffer.from(signingIdentity, "hex");
  const spkiBytes = Buffer.from(liveSpki, "hex");
  const expectedBinding = createHash("sha256").update(signerBytes).update(spkiBytes).digest("hex");
  if (fields.reportData !== `${expectedBinding}${nonceHex}`) {
    throw new Error("NEAR AI TDX report_data did not bind the signer, TLS key, and nonce");
  }
  const composeHash = createHash("sha256").update(appCompose).digest("hex");
  const expectedMrConfig = `01${composeHash}${"00".repeat(15)}`;
  if (advertisedComposeHash.toLowerCase() !== composeHash
      || fields.mrConfigId !== expectedMrConfig
      || !policy.approvedMeasurements.includes(composeHash)) {
    throw new Error("NEAR AI workload measurement is not approved by the pinned policy");
  }
  await verifyGpuEvidence(gpuSerialized, nonceHex, context);
  const verifiedAt = new Date().toISOString();
  return {
    signerPublicKey: createPublicKey(rawEd25519PublicKeyPem(signingIdentity)),
    evidence: Object.freeze({
      modelId: policy.modelId,
      directEndpoint: policy.directEndpoint,
      verifiedAt,
      verifierVersion: policy.verifierVersion,
      signingIdentity: signingIdentity.toLowerCase(),
      signatureAlgorithm: "ed25519" as const,
      signatureProvenance: "provider_tee" as const,
      tlsSpkiSha256: liveSpki,
      sameConnection: true as const,
      attestation: Object.freeze({
        tdxQuote: Uint8Array.from(quote),
        tdxVerified: true as const,
        tdxStatus: fields.status as "UpToDate" | "OutOfDate",
        gpuEvidence: Uint8Array.from(gpuEvidence),
        gpuVerified: true as const,
        measurement: composeHash,
        modelName: policy.modelId,
        reportData: Object.freeze({
          scheme: "sha256(signing_identity||tls_spki_sha256)||nonce" as const,
          signingIdentity: signingIdentity.toLowerCase(),
          tlsSpkiSha256: liveSpki,
          nonceHex,
        }),
      }),
    }),
  };
}

function decodeSignature(value: string): Buffer | null {
  if (/^[a-f0-9]{128}$/i.test(value)) return Buffer.from(value, "hex");
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 64 ? decoded : null;
  }
  return null;
}

export interface NearConfidentialTransportOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/** Verifier-owned direct-endpoint transport. No shared gateway or fallback is used. */
export class NearConfidentialTransport implements ConfidentialTransport {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NearConfidentialTransportOptions) {
    if (!options.apiKey) throw new Error("NEAR AI API key is required");
    assertHeader(options.apiKey, "NEAR AI API key");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async discoverModels(context: ConfidentialOperationContext): Promise<readonly ConfidentialModel[]> {
    const response = await this.fetchImpl(CATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: context.signal,
    });
    const bytes = await readBoundedFetchBody(response, 256 * 1024);
    if (!response.ok) throw new Error(`NEAR AI model catalog failed with HTTP ${response.status}`);
    const root = parseJsonObject(bytes, "NEAR AI model catalog");
    const endpoints = root["endpoints"];
    if (!Array.isArray(endpoints) || endpoints.length > context.limits.maxCatalogModels) {
      throw new Error("NEAR AI model catalog is malformed or oversized");
    }
    const models: ConfidentialModel[] = [];
    for (const item of endpoints) {
      const record = exactRecord(item);
      const domain = record?.["domain"];
      const ids = record?.["models"];
      if (typeof domain !== "string" || !DIRECT_HOST.test(domain) || !Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id !== "string" || id.length === 0) continue;
        models.push(Object.freeze({
          id,
          directEndpoint: `https://${domain}/v1`,
          verifiable: true,
          attestationSupported: true,
          vllmCompatible: true,
        }));
      }
    }
    if (models.length > context.limits.maxCatalogModels) {
      throw new Error("NEAR AI model catalog exceeded its model limit");
    }
    return Object.freeze(models);
  }

  async openVerifiedChannel(
    input: { policy: AttestationPolicy; nonce: Uint8Array },
    context: ConfidentialOperationContext,
  ): Promise<VerifiedChannel | ConfidentialFailure> {
    const endpoint = directEndpointParts(input.policy.directEndpoint);
    if (!endpoint) return failure("endpoint_ineligible", "NEAR AI requires a fixed model-specific HTTPS endpoint");
    let socket: TLSSocket | null = null;
    try {
      socket = await openTls(endpoint.host, endpoint.port, context);
      const nonceHex = Buffer.from(input.nonce).toString("hex");
      const attestationResponse = await requestOnSocket(socket, endpoint.host, {
        method: "GET",
        path: `/v1/attestation/report?include_tls_fingerprint=true&nonce=${nonceHex}&signing_algo=ed25519`,
      }, context, context.limits.maxAttestationProofBytes);
      if (attestationResponse.statusCode !== 200) {
        socket.destroy();
        return failure("attestation_invalid", `NEAR AI attestation failed with HTTP ${attestationResponse.statusCode}`);
      }
      const verified = await verifyAttestation(
        attestationResponse.body,
        socket,
        input.policy,
        input.nonce,
        context,
      );
      const channelSocket = socket;
      const authorization = `Bearer ${this.apiKey}`;
      const evidence = verified.evidence;
      const signerPublicKey = verified.signerPublicKey;
      const channel: VerifiedChannel = {
        evidence,
        async send(requestBytes, operationContext): Promise<ExactResponse> {
          const response = await requestOnSocket(channelSocket, endpoint.host, {
            method: "POST",
            path: "/v1/chat/completions",
            headers: {
              Authorization: authorization,
              "Content-Type": "application/json",
              "X-Signing-Algo": "ed25519",
            },
            body: requestBytes,
          }, operationContext, operationContext.limits.maxResponseBytes);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`NEAR AI inference failed with HTTP ${response.statusCode}`);
          }
          const parsed = parseJsonObject(response.body, "NEAR AI completion");
          const chatId = parsed["id"];
          const responseModel = parsed["model"];
          if (typeof chatId !== "string" || chatId.length === 0
              || responseModel !== input.policy.modelId) {
            throw new Error("NEAR AI completion identity did not match the requested model");
          }
          return { bytes: Uint8Array.from(response.body), chatId, modelId: responseModel };
        },
        async retrieveSignature(signatureInput, operationContext): Promise<NormalizedResponseSignatureRecord> {
          const path = `/v1/signature/${encodeURIComponent(signatureInput.chatId)}`
            + `?model=${encodeURIComponent(signatureInput.modelId)}&signing_algo=ed25519`;
          const response = await requestOnSocket(channelSocket, endpoint.host, {
            method: "GET",
            path,
            headers: { Authorization: authorization },
          }, operationContext, operationContext.limits.maxSignatureChars * 4);
          if (response.statusCode !== 200) {
            throw new Error(`NEAR AI signature lookup failed with HTTP ${response.statusCode}`);
          }
          const record = parseJsonObject(response.body, "NEAR AI response signature");
          const signedText = record["text"];
          const signature = record["signature"];
          const signer = record["signing_address"];
          const algorithm = record["signing_algo"];
          if (typeof signedText !== "string" || typeof signature !== "string"
              || typeof signer !== "string" || signer.toLowerCase() !== evidence.signingIdentity
              || (algorithm !== undefined && algorithm !== "ed25519")
              || signedText.split(":").length !== 3 || !decodeSignature(signature)) {
            throw new Error("NEAR AI returned a malformed or mismatched response signature");
          }
          return {
            chatId: signatureInput.chatId,
            modelId: signatureInput.modelId,
            signedText,
            signature,
            signingIdentity: evidence.signingIdentity,
            algorithm: "ed25519",
            scheme: "ed25519-raw",
            signedTextFormat: "model:request_sha256:response_sha256",
            provenance: "provider_tee",
          };
        },
        async verifyExactResponse(verificationInput): Promise<boolean> {
          const signature = decodeSignature(verificationInput.signature.signature);
          return signature !== null && verifySignature(
            null,
            Buffer.from(verificationInput.signature.signedText, "utf8"),
            signerPublicKey,
            signature,
          );
        },
        async close(): Promise<void> {
          channelSocket.destroy();
        },
      };
      return channel;
    } catch (error) {
      socket?.destroy();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("TLS key") || message.includes("report_data")) {
        return failure("tls_binding_invalid", message);
      }
      if (message.includes("measurement")) return failure("attestation_policy_mismatch", message);
      return failure("attestation_invalid", message);
    }
  }
}
