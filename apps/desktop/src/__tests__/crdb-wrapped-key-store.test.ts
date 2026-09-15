import { describe, expect, it, vi } from "vitest";
import {
  CockroachWrappedKeyStore,
  loadSourceKeyRegistryPort,
  type SourceKeyRegistryPort,
  type SourceKeyRegistryRecord,
} from "../crdb-wrapped-key-store.js";
import type { WrappedUserKey } from "../key-broker.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";

const wrapper: WrappedUserKey = {
  magic: "skytwin-user-key",
  wrapperVersion: 1,
  userId: USER_ID,
  keyVersion: 1,
  algorithm: "aes-256-gcm",
  kdf: {
    algorithm: "scrypt",
    N: 32_768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
    salt: "AA==",
  },
  iv: "AA==",
  tag: "AA==",
  ciphertext: "AA==",
  canary: {
    magic: "skytwin-envelope",
    version: 2,
    algorithm: "aes-256-gcm",
    ownerKind: "user",
    purpose: "oauth",
    keyVersion: 1,
    iv: "AA==",
    tag: "AA==",
    ciphertext: "AA==",
  },
};

function row(
  overrides: Partial<SourceKeyRegistryRecord> = {},
): SourceKeyRegistryRecord {
  return {
    user_id: USER_ID,
    key_version: 1,
    wrapper_version: 1,
    algorithm: "aes-256-gcm",
    kdf_record: structuredClone(wrapper.kdf),
    recovery_wrapper: structuredClone(wrapper),
    ...overrides,
  };
}

function registry(
  current: SourceKeyRegistryRecord | null = null,
): SourceKeyRegistryPort {
  return {
    getCurrent: vi.fn(async () => current),
    createInitial: vi.fn(async () => true),
    deleteInitialIfMatch: vi.fn(async () => true),
  };
}

describe("CockroachWrappedKeyStore", () => {
  it("loads and narrows the ESM-only registry leaf", async () => {
    const repository = registry();
    const importModule = vi.fn(async () => ({
      sourceKeyRegistryRepository: repository,
    }));
    const moduleSpecifier = "file:///verified/source-key-registry.js";
    const port = await loadSourceKeyRegistryPort(
      moduleSpecifier,
      importModule,
    );
    expect(port).toEqual({
      getCurrent: expect.any(Function),
      createInitial: expect.any(Function),
      deleteInitialIfMatch: expect.any(Function),
    });
    expect(importModule).toHaveBeenCalledWith(moduleSpecifier);
  });

  it("rejects an invalid registry module and non-boolean mutation results", async () => {
    await expect(
      loadSourceKeyRegistryPort("file:///invalid.js", async () => ({})),
    ).rejects.toThrow("source-key registry module is invalid");

    const repository = registry();
    vi.mocked(repository.createInitial).mockResolvedValue(
      "yes" as unknown as boolean,
    );
    vi.mocked(repository.deleteInitialIfMatch).mockResolvedValue(
      1 as unknown as boolean,
    );
    const port = await loadSourceKeyRegistryPort(
      "file:///invalid-results.js",
      async () => ({ sourceKeyRegistryRepository: repository }),
    );
    await expect(port.createInitial(row())).rejects.toThrow(
      "source-key registry create result is invalid",
    );
    await expect(port.deleteInitialIfMatch(row())).rejects.toThrow(
      "source-key registry delete result is invalid",
    );
  });

  it("maps a matching active row and preserves an absent row", async () => {
    const present = new CockroachWrappedKeyStore(async () => registry(row()));
    const absent = new CockroachWrappedKeyStore(async () => registry());

    await expect(present.get(USER_ID)).resolves.toEqual(wrapper);
    await expect(absent.get(USER_ID)).resolves.toBeUndefined();
  });

  it.each([
    ["owner", { user_id: OTHER_USER_ID }],
    ["key version", { key_version: 2 }],
    ["wrapper version", { wrapper_version: 2 }],
    [
      "wrapper algorithm",
      {
        recovery_wrapper: { ...wrapper, algorithm: "not-a-cipher" },
      },
    ],
    [
      "KDF metadata",
      {
        kdf_record: { ...wrapper.kdf, salt: "different" },
      },
    ],
    [
      "extra KDF metadata",
      {
        kdf_record: { ...wrapper.kdf, unreviewed: true },
      },
    ],
    ["recovery wrapper", { recovery_wrapper: null }],
  ])("rejects mismatched %s metadata", async (_name, overrides) => {
    const store = new CockroachWrappedKeyStore(async () =>
      registry(row(overrides as Partial<SourceKeyRegistryRecord>)),
    );
    await expect(store.get(USER_ID)).rejects.toThrow(
      "source-key registry metadata mismatch",
    );
  });

  it("forwards the complete owner-bound record and preserves create conflicts", async () => {
    const port = registry();
    vi.mocked(port.createInitial).mockResolvedValue(false);
    const store = new CockroachWrappedKeyStore(async () => port);

    await expect(store.create(USER_ID, wrapper)).resolves.toBe(false);
    expect(port.createInitial).toHaveBeenCalledWith(row());
  });

  it("rejects a conflicting create owner before repository access", async () => {
    const port = registry();
    const store = new CockroachWrappedKeyStore(async () => port);

    await expect(store.create(OTHER_USER_ID, wrapper)).rejects.toThrow(
      "source-key owner mismatch",
    );
    expect(port.createInitial).not.toHaveBeenCalled();
  });

  it("forwards exact deletion and rejects a conflicting owner locally", async () => {
    const port = registry();
    const store = new CockroachWrappedKeyStore(async () => port);

    await expect(store.deleteIfMatch(USER_ID, wrapper)).resolves.toBe(true);
    expect(port.deleteInitialIfMatch).toHaveBeenCalledWith(row());
    await expect(store.deleteIfMatch(OTHER_USER_ID, wrapper)).resolves.toBe(
      false,
    );
    expect(port.deleteInitialIfMatch).toHaveBeenCalledTimes(1);
  });

  it("memoizes both successful and failed lazy port loads without fallback", async () => {
    const port = registry(row());
    const load = vi.fn(async () => port);
    const store = new CockroachWrappedKeyStore(load);
    await store.get(USER_ID);
    await store.get(USER_ID);
    expect(load).toHaveBeenCalledTimes(1);

    const failure = new Error("registry unavailable");
    const failedLoad = vi.fn(async (): Promise<SourceKeyRegistryPort> => {
      throw failure;
    });
    const failed = new CockroachWrappedKeyStore(failedLoad);
    await expect(failed.get(USER_ID)).rejects.toBe(failure);
    await expect(failed.create(USER_ID, wrapper)).rejects.toBe(failure);
    expect(failedLoad).toHaveBeenCalledTimes(1);
  });
});
