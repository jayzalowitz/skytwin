import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  CONFIDENTIAL_RESOURCE_LIMITS,
  StrictConfidentialClient,
  isEligibleDirectModel,
} from "../strict-client.js";
import type {
  AttestationPolicy,
  ConfidentialFailure,
  ConfidentialModel,
  ConfidentialTransport,
  VerifiedChannel,
} from "../types.js";

const endpoint = "https://qwen35-122b.completions.near.ai/v1";
const model: ConfidentialModel = {
  id: "Qwen/Qwen3.5-122B",
  directEndpoint: endpoint,
  verifiable: true,
  attestationSupported: true,
  vllmCompatible: true,
};
const policy: AttestationPolicy = {
  modelId: model.id,
  directEndpoint: endpoint,
  approvedMeasurements: ["approved-measurement"],
  maxAgeMs: 60_000,
  verifierVersion: "reviewed-verifier@sha256:abc",
  signatureAlgorithm: "ecdsa-secp256k1",
  signatureProvenance: "provider_tee",
};
const nonce = new Uint8Array(32).fill(7);
const nonceHex = Buffer.from(nonce).toString("hex");
const spki = "a".repeat(64);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture(evidenceOverrides: Record<string, unknown> = {}) {
  const send = vi.fn(
    async (
      _bytes: Uint8Array,
      _context?: Parameters<VerifiedChannel["send"]>[1],
    ) => ({
      bytes: new TextEncoder().encode('{"answer":"private"}\n'),
      chatId: "chat-123",
      modelId: model.id,
    }),
  );
  const retrieveSignature = vi.fn(
    async (_input?: Parameters<VerifiedChannel["retrieveSignature"]>[0]) => ({
      chatId: "chat-123",
      modelId: model.id,
      signedText: `${model.id}:${hash(new Uint8Array([1]))}:${hash(new TextEncoder().encode('{"answer":"private"}\n'))}`,
      signature: "0xsigned",
      signingIdentity: "0xattested",
      algorithm: "ecdsa-secp256k1" as const,
      scheme: "eip191-personal-sign" as const,
      signedTextFormat: "model:request_sha256:response_sha256" as const,
      provenance: "provider_tee" as const,
    }),
  );
  const verifyExactResponse = vi.fn(
    async (_input?: Parameters<VerifiedChannel["verifyExactResponse"]>[0]) =>
      true,
  );
  const close = vi.fn(async () => undefined);
  const baseEvidence: VerifiedChannel["evidence"] = {
    modelId: model.id,
    directEndpoint: endpoint,
    verifiedAt: new Date(1_000_000).toISOString(),
    verifierVersion: policy.verifierVersion,
    signingIdentity: "0xattested",
    signatureAlgorithm: "ecdsa-secp256k1",
    signatureProvenance: "provider_tee",
    tlsSpkiSha256: spki,
    sameConnection: true,
    attestation: {
      tdxQuote: new Uint8Array([1]),
      tdxVerified: true,
      tdxStatus: "UpToDate",
      gpuEvidence: new Uint8Array([2]),
      gpuVerified: true,
      measurement: "approved-measurement",
      modelName: model.id,
      reportData: {
        scheme: "sha256(signing_identity||tls_spki_sha256)||nonce",
        signingIdentity: "0xattested",
        tlsSpkiSha256: spki,
        nonceHex,
      },
    },
  };
  const channel: VerifiedChannel = {
    evidence: { ...baseEvidence, ...evidenceOverrides },
    send,
    retrieveSignature,
    verifyExactResponse,
    close,
  };
  const transport: ConfidentialTransport = {
    discoverModels: vi.fn(async () => [model]),
    openVerifiedChannel: vi.fn(async () => channel),
  };
  const client = new StrictConfidentialClient(transport, {
    now: () => 1_000_000,
    nonce: () => nonce,
  });
  return {
    client,
    transport,
    channel,
    send,
    retrieveSignature,
    verifyExactResponse,
    close,
  };
}

describe("strict confidential client", () => {
  it("binds a client nonce, attested signer and TLS SPKI before sending", async () => {
    const { client, transport, send } = fixture();
    expect((await client.generate(new Uint8Array([1]), policy)).ok).toBe(true);
    expect(transport.openVerifiedChannel).toHaveBeenCalledWith(
      {
        policy,
        nonce,
      },
      expect.objectContaining({
        timeoutMs: 120_000,
        limits: CONFIDENTIAL_RESOURCE_LIMITS,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ["modelId", "other"],
    ["directEndpoint", "https://other.completions.near.ai/v1"],
    ["verifierVersion", "other"],
    ["signatureAlgorithm", "ed25519"],
    ["signatureProvenance", "gateway"],
  ])("rejects mismatched %s before transmission", async (key, value) => {
    const { client, send, close } = fixture({ [key]: value });
    expect(await client.generate(new Uint8Array([1]), policy)).toMatchObject({
      ok: false,
      code: "attestation_policy_mismatch",
      promptTransmitted: false,
    });
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["same connection", { sameConnection: false }],
    ["SPKI format", { tlsSpkiSha256: "bad" }],
    ["future timestamp", { verifiedAt: new Date(1_000_001).toISOString() }],
    ["malformed timestamp", { verifiedAt: "bad" }],
    ["stale timestamp", { verifiedAt: new Date(939_999).toISOString() }],
  ])("rejects invalid %s evidence", async (_label, override) => {
    const { client, send } = fixture(override);
    const result = await client.generate(new Uint8Array([1]), policy);
    expect(result).toMatchObject({ ok: false, promptTransmitted: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a replayed nonce and incomplete quote before transmission", async () => {
    const replay = fixture({
      attestation: {
        ...fixture().channel.evidence.attestation,
        reportData: {
          ...fixture().channel.evidence.attestation.reportData,
          nonceHex: "00".repeat(32),
        },
      },
    });
    expect(
      await replay.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "tls_binding_invalid" });
    const incomplete = fixture({
      attestation: {
        ...fixture().channel.evidence.attestation,
        tdxQuote: new Uint8Array(),
      },
    });
    expect(
      await incomplete.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "attestation_invalid" });
  });

  it("rejects report-data signer/SPKI and deployment-measurement mismatches", async () => {
    const base = fixture().channel.evidence.attestation;
    for (const reportData of [
      { ...base.reportData, signingIdentity: "other" },
      { ...base.reportData, tlsSpkiSha256: "b".repeat(64) },
    ]) {
      const item = fixture({ attestation: { ...base, reportData } });
      expect(
        await item.client.generate(new Uint8Array([1]), policy),
      ).toMatchObject({ code: "tls_binding_invalid" });
    }
    const measurement = fixture({
      attestation: { ...base, measurement: "unapproved" },
    });
    expect(
      await measurement.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "attestation_policy_mismatch" });
    const modelName = fixture({ attestation: { ...base, modelName: "other" } });
    expect(
      await modelName.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "attestation_policy_mismatch" });
  });

  it("rejects failed nonce generation and propagates a typed verifier failure without sending", async () => {
    const badNonce = fixture();
    const invalidClient = new StrictConfidentialClient(badNonce.transport, {
      nonce: () => new Uint8Array(31),
    });
    expect(
      await invalidClient.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "invalid_policy", promptTransmitted: false });
    const thrownClient = new StrictConfidentialClient(badNonce.transport, {
      nonce: () => {
        throw new Error("rng");
      },
    });
    expect(
      await thrownClient.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "verifier_unavailable", promptTransmitted: false });
    vi.mocked(badNonce.transport.openVerifiedChannel).mockResolvedValue({
      ok: false,
      code: "attestation_invalid",
      message: "bad quote",
      promptTransmitted: false,
    });
    expect(
      await badNonce.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "attestation_invalid", promptTransmitted: false });
    expect(badNonce.send).not.toHaveBeenCalled();
  });

  it("normalizes pre-transmission verifier failures and fails closed on malformed ones", async () => {
    const reported = fixture();
    vi.mocked(reported.transport.openVerifiedChannel).mockResolvedValue({
      ok: false,
      code: "attestation_invalid",
      message: "bad quote",
      promptTransmitted: true,
    });
    expect(await reported.client.generate(new Uint8Array([1]), policy)).toEqual(
      {
        ok: false,
        code: "attestation_invalid",
        message: "bad quote",
        promptTransmitted: false,
      },
    );

    const malformed = fixture();
    vi.mocked(malformed.transport.openVerifiedChannel).mockResolvedValue({
      ok: false,
      code: "not-a-real-code",
      message: 42,
      promptTransmitted: false,
    } as unknown as ConfidentialFailure);
    expect(
      await malformed.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "verifier_unavailable",
      promptTransmitted: false,
    });
  });

  it.each([
    [{ ...policy, maxAgeMs: 0 }],
    [{ ...policy, maxAgeMs: Number.NaN }],
    [{ ...policy, approvedMeasurements: [] }],
    [{ ...policy, verifierVersion: "" }],
    [{ ...policy, signatureProvenance: "gateway" as const }],
  ])("rejects invalid direct policy %#", async (badPolicy) => {
    const { client, transport } = fixture();
    expect(await client.generate(new Uint8Array([1]), badPolicy)).toMatchObject(
      { code: "invalid_policy", promptTransmitted: false },
    );
    expect(transport.discoverModels).not.toHaveBeenCalled();
  });

  it("rejects malformed runtime policy fields before catalog discovery", async () => {
    for (const badPolicy of [
      { ...policy, signatureAlgorithm: "rsa" } as unknown as AttestationPolicy,
      {
        ...policy,
        approvedMeasurements: "approved-measurement",
      } as unknown as AttestationPolicy,
    ]) {
      const { client, transport } = fixture();
      expect(
        await client.generate(new Uint8Array([1]), badPolicy),
      ).toMatchObject({
        code: "invalid_policy",
        promptTransmitted: false,
      });
      expect(transport.discoverModels).not.toHaveBeenCalled();
    }
  });

  it("rejects duplicate catalog identities", async () => {
    const { client, transport } = fixture();
    vi.mocked(transport.discoverModels).mockResolvedValue([model, model]);
    expect(await client.generate(new Uint8Array([1]), policy)).toMatchObject({
      code: "catalog_ambiguous",
    });
  });

  it("rejects malformed catalog values and snapshots an admitted catalog record", async () => {
    const malformed = fixture();
    vi.mocked(malformed.transport.discoverModels).mockResolvedValue([
      { ...model, verifiable: "true" } as unknown as ConfidentialModel,
    ]);
    expect(
      await malformed.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "model_ineligible",
      promptTransmitted: false,
    });
    expect(malformed.send).not.toHaveBeenCalled();

    const mutable = fixture();
    const mutableModel = { ...model };
    vi.mocked(mutable.transport.discoverModels).mockResolvedValue([
      mutableModel,
    ]);
    vi.mocked(mutable.transport.openVerifiedChannel).mockImplementation(
      async () => {
        mutableModel.id = "mutated-after-admission";
        mutableModel.directEndpoint = "https://other.completions.near.ai/v1";
        return mutable.channel;
      },
    );
    expect(
      await mutable.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ ok: true });
  });

  it("closes a channel whose evidence is malformed or throws while being snapshotted", async () => {
    const malformed = fixture({
      attestation: {
        ...fixture().channel.evidence.attestation,
        tdxVerified: "true",
      },
    });
    expect(
      await malformed.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "attestation_invalid",
      promptTransmitted: false,
    });
    expect(malformed.close).toHaveBeenCalledOnce();

    const unsupportedStatus = fixture({
      attestation: {
        ...fixture().channel.evidence.attestation,
        tdxStatus: "ConfigurationNeeded",
      },
    });
    expect(
      await unsupportedStatus.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "attestation_invalid",
      promptTransmitted: false,
    });
    expect(unsupportedStatus.close).toHaveBeenCalledOnce();

    const throwing = fixture();
    Object.defineProperty(throwing.channel, "evidence", {
      configurable: true,
      get() {
        throw new Error("malformed evidence getter");
      },
    });
    expect(
      await throwing.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "attestation_invalid",
      promptTransmitted: false,
    });
    expect(throwing.close).toHaveBeenCalledOnce();
  });

  it("closes the channel without sending when the attestation clock fails", async () => {
    const item = fixture();
    const client = new StrictConfidentialClient(item.transport, {
      now: () => {
        throw new Error("clock unavailable");
      },
      nonce: () => nonce,
    });
    expect(await client.generate(new Uint8Array([1]), policy)).toMatchObject({
      code: "verifier_unavailable",
      promptTransmitted: false,
    });
    expect(item.send).not.toHaveBeenCalled();
    expect(item.close).toHaveBeenCalledOnce();
  });

  it("binds separately retrieved signature model, chat, algorithm, provenance and signer", async () => {
    for (const [field, value, code] of [
      ["chatId", "other", "response_signature_invalid"],
      ["modelId", "other", "response_signature_invalid"],
      ["algorithm", "ed25519", "response_signature_invalid"],
      ["provenance", "gateway", "response_provenance_mismatch"],
      ["signingIdentity", "other", "response_signer_mismatch"],
      ["scheme", "ed25519-raw", "response_signature_invalid"],
      ["signedText", "other:bad:bad", "response_signature_invalid"],
    ] as const) {
      const { client, retrieveSignature } = fixture();
      retrieveSignature.mockResolvedValue({
        ...(await retrieveSignature()),
        [field]: value,
      });
      expect(await client.generate(new Uint8Array([1]), policy)).toMatchObject({
        code,
        promptTransmitted: true,
      });
    }
  });

  it("rejects response model/chat identity before signature retrieval", async () => {
    for (const response of [
      { bytes: new Uint8Array([1]), chatId: "", modelId: model.id },
      { bytes: new Uint8Array([1]), chatId: "chat-123", modelId: "other" },
    ]) {
      const item = fixture();
      item.send.mockResolvedValue(response);
      expect(
        await item.client.generate(new Uint8Array([1]), policy),
      ).toMatchObject({ code: "response_signature_invalid" });
      expect(item.retrieveSignature).not.toHaveBeenCalled();
    }
  });

  it("returns no bytes when retrieval or exact verification fails", async () => {
    const unavailable = fixture();
    unavailable.retrieveSignature.mockRejectedValue(new Error("offline"));
    expect(
      await unavailable.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "signature_unavailable" });
    const invalid = fixture();
    invalid.verifyExactResponse.mockResolvedValue(false);
    const result = await invalid.client.generate(new Uint8Array([1]), policy);
    expect(result).toMatchObject({ code: "response_signature_invalid" });
    expect("bytes" in result).toBe(false);

    const truthy = fixture();
    truthy.verifyExactResponse.mockResolvedValue("true" as unknown as boolean);
    expect(
      await truthy.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "response_signature_invalid",
      promptTransmitted: true,
    });
  });

  it("snapshots response and signature identity before later verifier awaits", async () => {
    const item = fixture();
    const rawResponse = {
      bytes: new TextEncoder().encode('{"answer":"private"}\n'),
      chatId: "chat-123",
      modelId: model.id,
    };
    const rawSignature = await item.retrieveSignature();
    item.send.mockResolvedValue(rawResponse);
    item.retrieveSignature.mockImplementation(async () => {
      rawResponse.chatId = "mutated-chat";
      rawResponse.modelId = "mutated-model";
      return rawSignature;
    });
    item.verifyExactResponse.mockImplementation(async (input) => {
      rawSignature.chatId = "mutated-signature-chat";
      rawSignature.signingIdentity = "mutated-signer";
      expect(input?.response.chatId).toBe("chat-123");
      expect(input?.signature.chatId).toBe("chat-123");
      expect(input?.signature.signingIdentity).toBe("0xattested");
      return true;
    });

    expect(
      await item.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      ok: true,
      chatId: "chat-123",
    });
  });

  it("binds transport and channel method authority before any later await", async () => {
    const item = fixture();
    const originalDiscover = item.transport.discoverModels;
    const originalOpen = item.transport.openVerifiedChannel;
    item.transport.discoverModels = vi.fn(async () => {
      throw new Error("replacement catalog must not run");
    });
    item.transport.openVerifiedChannel = vi.fn(async () => {
      throw new Error("replacement verifier must not run");
    });

    const replacementRetrieve = vi.fn(async () => {
      throw new Error("replacement signature lookup must not run");
    });
    const replacementVerify = vi.fn(async () => false);
    const replacementClose = vi.fn(async () => undefined);
    item.send.mockImplementation(async () => {
      item.channel.retrieveSignature = replacementRetrieve;
      item.channel.verifyExactResponse = replacementVerify;
      item.channel.close = replacementClose;
      return {
        bytes: new TextEncoder().encode('{"answer":"private"}\n'),
        chatId: "chat-123",
        modelId: model.id,
      };
    });

    expect(
      await item.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ ok: true });
    expect(originalDiscover).toHaveBeenCalledOnce();
    expect(originalOpen).toHaveBeenCalledOnce();
    expect(replacementRetrieve).not.toHaveBeenCalled();
    expect(replacementVerify).not.toHaveBeenCalled();
    expect(replacementClose).not.toHaveBeenCalled();
    expect(item.close).toHaveBeenCalledOnce();
  });

  it("rejects model identities that cannot be represented by the signed-text grammar", async () => {
    const item = fixture();
    expect(
      await item.client.generate(new Uint8Array([1]), {
        ...policy,
        modelId: `${model.id}:variant`,
      }),
    ).toMatchObject({
      code: "invalid_policy",
      promptTransmitted: false,
    });
    expect(item.transport.discoverModels).not.toHaveBeenCalled();
    expect(item.send).not.toHaveBeenCalled();
  });

  it("rejects an oversized transport failure message before transmission", async () => {
    const item = fixture();
    vi.mocked(item.transport.openVerifiedChannel).mockResolvedValue({
      ok: false,
      code: "verifier_unavailable",
      message: "x".repeat(CONFIDENTIAL_RESOURCE_LIMITS.maxStringChars + 1),
      promptTransmitted: false,
    });

    expect(
      await item.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "resource_limit_exceeded",
      promptTransmitted: false,
    });
    expect(item.send).not.toHaveBeenCalled();
  });

  it("enforces request, catalog, attestation, response, and signature limits", async () => {
    const oversizedRequest = fixture();
    expect(
      await oversizedRequest.client.generate(
        new Uint8Array(CONFIDENTIAL_RESOURCE_LIMITS.maxRequestBytes + 1),
        policy,
      ),
    ).toMatchObject({
      code: "resource_limit_exceeded",
      promptTransmitted: false,
    });
    expect(oversizedRequest.transport.discoverModels).not.toHaveBeenCalled();

    const oversizedCatalog = fixture();
    vi.mocked(oversizedCatalog.transport.discoverModels).mockResolvedValue(
      Array.from(
        { length: CONFIDENTIAL_RESOURCE_LIMITS.maxCatalogModels + 1 },
        () => model,
      ),
    );
    expect(
      await oversizedCatalog.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "resource_limit_exceeded",
      promptTransmitted: false,
    });
    expect(
      oversizedCatalog.transport.openVerifiedChannel,
    ).not.toHaveBeenCalled();

    const oversizedEvidence = fixture({
      attestation: {
        ...fixture().channel.evidence.attestation,
        tdxQuote: new Uint8Array(
          CONFIDENTIAL_RESOURCE_LIMITS.maxAttestationProofBytes + 1,
        ),
      },
    });
    expect(
      await oversizedEvidence.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "resource_limit_exceeded",
      promptTransmitted: false,
    });
    expect(oversizedEvidence.send).not.toHaveBeenCalled();

    const oversizedResponse = fixture();
    oversizedResponse.send.mockResolvedValue({
      bytes: new Uint8Array(CONFIDENTIAL_RESOURCE_LIMITS.maxResponseBytes + 1),
      chatId: "chat-123",
      modelId: model.id,
    });
    expect(
      await oversizedResponse.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "resource_limit_exceeded",
      promptTransmitted: true,
    });
    expect(oversizedResponse.retrieveSignature).not.toHaveBeenCalled();

    const oversizedSignature = fixture();
    oversizedSignature.retrieveSignature.mockResolvedValue({
      ...(await oversizedSignature.retrieveSignature()),
      signature: "s".repeat(CONFIDENTIAL_RESOURCE_LIMITS.maxSignatureChars + 1),
    });
    expect(
      await oversizedSignature.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({
      code: "resource_limit_exceeded",
      promptTransmitted: true,
    });
    expect(oversizedSignature.verifyExactResponse).not.toHaveBeenCalled();
  });

  it("bounds every asynchronous transport stage and preserves transmission truth", async () => {
    const never = () => new Promise<never>(() => undefined);
    const deadlineClient = (item: ReturnType<typeof fixture>) =>
      new StrictConfidentialClient(item.transport, {
        now: () => 1_000_000,
        nonce: () => nonce,
        stageTimeoutMs: 5,
      });

    const catalog = fixture();
    vi.mocked(catalog.transport.discoverModels).mockImplementation(never);
    expect(
      await deadlineClient(catalog).generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "catalog_unavailable", promptTransmitted: false });
    expect(
      vi.mocked(catalog.transport.discoverModels).mock.calls[0]?.[0].signal
        .aborted,
    ).toBe(true);

    const open = fixture();
    let resolveOpen: ((value: VerifiedChannel) => void) | undefined;
    vi.mocked(open.transport.openVerifiedChannel).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    expect(
      await deadlineClient(open).generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "verifier_unavailable", promptTransmitted: false });
    expect(
      vi.mocked(open.transport.openVerifiedChannel).mock.calls[0]?.[1].signal
        .aborted,
    ).toBe(true);
    expect(open.close).not.toHaveBeenCalled();
    resolveOpen?.(open.channel);
    await vi.waitFor(() => expect(open.close).toHaveBeenCalledOnce());

    const send = fixture();
    let resolveSend: (() => void) | undefined;
    let sendSettled = false;
    send.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = () => {
            sendSettled = true;
            resolve({
              bytes: new Uint8Array([1]),
              chatId: "late-chat",
              modelId: model.id,
            });
          };
        }),
    );
    send.close.mockImplementation(async () => {
      expect(sendSettled).toBe(true);
    });
    expect(
      await deadlineClient(send).generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "transport_failed", promptTransmitted: true });
    expect(send.send.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(send.close).not.toHaveBeenCalled();
    resolveSend?.();
    await vi.waitFor(() => expect(send.close).toHaveBeenCalledOnce());

    const signature = fixture();
    let resolveSignature: (() => void) | undefined;
    let signatureSettled = false;
    signature.retrieveSignature.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSignature = () => {
            signatureSettled = true;
            resolve({
              chatId: "chat-123",
              modelId: model.id,
              signedText: `${model.id}:${hash(new Uint8Array([1]))}:${hash(new TextEncoder().encode('{"answer":"private"}\n'))}`,
              signature: "0xsigned",
              signingIdentity: "0xattested",
              algorithm: "ecdsa-secp256k1",
              scheme: "eip191-personal-sign",
              signedTextFormat: "model:request_sha256:response_sha256",
              provenance: "provider_tee",
            });
          };
        }),
    );
    signature.close.mockImplementation(async () => {
      expect(signatureSettled).toBe(true);
    });
    expect(
      await deadlineClient(signature).generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "signature_unavailable", promptTransmitted: true });
    expect(signature.close).not.toHaveBeenCalled();
    resolveSignature?.();
    await vi.waitFor(() => expect(signature.close).toHaveBeenCalledOnce());

    const verification = fixture();
    let resolveVerification: ((value: boolean) => void) | undefined;
    let verificationSettled = false;
    verification.verifyExactResponse.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVerification = (value) => {
            verificationSettled = true;
            resolve(value);
          };
        }),
    );
    verification.close.mockImplementation(async () => {
      expect(verificationSettled).toBe(true);
    });
    expect(
      await deadlineClient(verification).generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "transport_failed", promptTransmitted: true });
    expect(verification.close).not.toHaveBeenCalled();
    resolveVerification?.(true);
    await vi.waitFor(() => expect(verification.close).toHaveBeenCalledOnce());

    const close = fixture();
    close.close.mockImplementation(never);
    expect(
      await deadlineClient(close).generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "transport_failed", promptTransmitted: true });
  });

  it("snapshots request and response bytes across an adversarial channel", async () => {
    const { client, channel, send, retrieveSignature, verifyExactResponse } =
      fixture();
    const original = new Uint8Array([1, 2, 3]);
    let verifiedRequest: Uint8Array | undefined;
    let verifiedResponse: Uint8Array | undefined;
    send.mockImplementation(async (sent) => {
      sent[0] = 99;
      original[1] = 88;
      return {
        bytes: new Uint8Array([4, 5, 6]),
        chatId: "chat-123",
        modelId: model.id,
      };
    });
    retrieveSignature.mockResolvedValue({
      ...(await retrieveSignature()),
      signedText: `${model.id}:${hash(new Uint8Array([1, 2, 3]))}:${hash(new Uint8Array([4, 5, 6]))}`,
    });
    verifyExactResponse.mockImplementation(async (input) => {
      if (!input) throw new Error("missing verification input");
      verifiedRequest = Uint8Array.from(input.requestBytes);
      verifiedResponse = Uint8Array.from(input.responseBytes);
      input.requestBytes[0] = 77;
      input.responseBytes[0] = 77;
      input.response.bytes[1] = 77;
      return true;
    });
    const result = await client.generate(original, policy);
    expect(verifiedRequest).toEqual(new Uint8Array([1, 2, 3]));
    expect(verifiedResponse).toEqual(new Uint8Array([4, 5, 6]));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.bytes).toEqual(new Uint8Array([4, 5, 6]));
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("keeps concurrent verification scoped to each channel", async () => {
    const a = fixture();
    const b = fixture({
      signingIdentity: "0xother",
      attestation: {
        ...fixture().channel.evidence.attestation,
        reportData: {
          ...fixture().channel.evidence.attestation.reportData,
          signingIdentity: "0xother",
        },
      },
    });
    b.retrieveSignature.mockResolvedValue({
      ...(await b.retrieveSignature()),
      signingIdentity: "0xother",
    });
    const transport: ConfidentialTransport = {
      discoverModels: vi.fn(async () => [model]),
      openVerifiedChannel: vi
        .fn()
        .mockResolvedValueOnce(a.channel)
        .mockResolvedValueOnce(b.channel),
    };
    const client = new StrictConfidentialClient(transport, {
      now: () => 1_000_000,
      nonce: () => nonce,
    });
    await Promise.all([
      client.generate(new Uint8Array([1]), policy),
      client.generate(new Uint8Array([1]), policy),
    ]);
    expect(a.verifyExactResponse).toHaveBeenCalledOnce();
    expect(b.verifyExactResponse).toHaveBeenCalledOnce();
  });

  it("fails closed for thrown catalog, verifier, send, verify, and ignores close errors", async () => {
    const catalog = fixture();
    vi.mocked(catalog.transport.discoverModels).mockRejectedValue(new Error());
    expect(
      await catalog.client.generate(new Uint8Array(), policy),
    ).toMatchObject({ code: "catalog_unavailable" });
    const open = fixture();
    vi.mocked(open.transport.openVerifiedChannel).mockRejectedValue(
      new Error(),
    );
    expect(await open.client.generate(new Uint8Array(), policy)).toMatchObject({
      code: "verifier_unavailable",
    });
    const sendFailure = fixture();
    sendFailure.send.mockRejectedValue(new Error());
    expect(
      await sendFailure.client.generate(new Uint8Array(), policy),
    ).toMatchObject({ code: "transport_failed", promptTransmitted: true });
    const verifyFailure = fixture();
    verifyFailure.verifyExactResponse.mockRejectedValue(new Error());
    verifyFailure.close.mockRejectedValue(new Error());
    expect(
      await verifyFailure.client.generate(new Uint8Array([1]), policy),
    ).toMatchObject({ code: "transport_failed" });
  });
});

describe("direct endpoint eligibility", () => {
  it("accepts only complete direct-model records", () => {
    expect(isEligibleDirectModel(model)).toBe(true);
    expect(isEligibleDirectModel({ ...model, verifiable: false })).toBe(false);
    expect(
      isEligibleDirectModel({
        ...model,
        directEndpoint: "https://cloud-api.near.ai/v1",
      }),
    ).toBe(false);
    expect(
      isEligibleDirectModel({
        ...model,
        directEndpoint: `${endpoint}?redirect=1`,
      }),
    ).toBe(false);
  });
});
