import type { WrappedKeyStore, WrappedUserKey } from "./key-broker.js";

export interface SourceKeyRegistryRecord {
  user_id: string;
  key_version: number;
  wrapper_version: number;
  algorithm: "aes-256-gcm";
  kdf_record: unknown;
  recovery_wrapper: unknown;
}

export interface SourceKeyRegistryPort {
  getCurrent(userId: string): Promise<SourceKeyRegistryRecord | null>;
  createInitial(input: SourceKeyRegistryRecord): Promise<boolean>;
  deleteInitialIfMatch(input: SourceKeyRegistryRecord): Promise<boolean>;
  revalidateSessionAuthority(input: {
    sessionId: string;
    ownerId: string;
    tokenHash: string;
    expiresAtMs: number;
  }): Promise<boolean>;
}

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as DynamicImport;

const INVALID = Symbol("invalid-source-key-registry-value");

function ownData(value: unknown, key: string): unknown | typeof INVALID {
  if (value === null || typeof value !== "object") return INVALID;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : INVALID;
  } catch {
    return INVALID;
  }
}

function hasExactDataKeys(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (value === null || typeof value !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    return (
      keys.length === expected.length &&
      expected.every(
        (key) =>
          Object.hasOwn(descriptors, key) && "value" in descriptors[key]!,
      )
    );
  } catch {
    return false;
  }
}

function recoveryMetadataMatches(
  requestedUserId: string,
  row: SourceKeyRegistryRecord,
): boolean {
  const wrapper = row.recovery_wrapper;
  const kdf = ownData(wrapper, "kdf");
  const kdfKeys = ["algorithm", "N", "r", "p", "maxmem", "salt"] as const;
  if (
    kdf === INVALID ||
    !hasExactDataKeys(kdf, kdfKeys) ||
    !hasExactDataKeys(row.kdf_record, kdfKeys)
  ) {
    return false;
  }
  return (
    row.user_id === requestedUserId &&
    ownData(wrapper, "userId") === row.user_id &&
    ownData(wrapper, "keyVersion") === row.key_version &&
    ownData(wrapper, "wrapperVersion") === row.wrapper_version &&
    ownData(wrapper, "algorithm") === row.algorithm &&
    ownData(kdf, "algorithm") === "scrypt" &&
    ownData(kdf, "algorithm") === ownData(row.kdf_record, "algorithm") &&
    ownData(kdf, "N") === ownData(row.kdf_record, "N") &&
    ownData(kdf, "r") === ownData(row.kdf_record, "r") &&
    ownData(kdf, "p") === ownData(row.kdf_record, "p") &&
    ownData(kdf, "maxmem") === ownData(row.kdf_record, "maxmem") &&
    ownData(kdf, "salt") === ownData(row.kdf_record, "salt")
  );
}

function registryRecord(
  userId: string,
  value: WrappedUserKey,
): SourceKeyRegistryRecord {
  return {
    user_id: userId,
    key_version: value.keyVersion,
    wrapper_version: value.wrapperVersion,
    algorithm: value.algorithm,
    kdf_record: value.kdf,
    recovery_wrapper: value,
  };
}

/** Load the ESM-only DB leaf without TypeScript rewriting import() to require(). */
export async function loadSourceKeyRegistryPort(
  moduleSpecifier: string,
  importModule: DynamicImport = dynamicImport,
): Promise<SourceKeyRegistryPort> {
  const imported = await importModule(moduleSpecifier);
  const repository = ownData(imported, "sourceKeyRegistryRepository");
  const getCurrent = ownData(repository, "getCurrent");
  const createInitial = ownData(repository, "createInitial");
  const deleteInitialIfMatch = ownData(repository, "deleteInitialIfMatch");
  const revalidateSessionAuthority = ownData(repository, "revalidateSessionAuthority");
  if (
    repository === INVALID ||
    typeof getCurrent !== "function" ||
    typeof createInitial !== "function" ||
    typeof deleteInitialIfMatch !== "function" ||
    typeof revalidateSessionAuthority !== "function"
  ) {
    throw new Error("source-key registry module is invalid");
  }
  return Object.freeze({
    async getCurrent(userId: string): Promise<SourceKeyRegistryRecord | null> {
      return (await getCurrent.call(
        repository,
        userId,
      )) as SourceKeyRegistryRecord | null;
    },
    async createInitial(input: SourceKeyRegistryRecord): Promise<boolean> {
      const result: unknown = await createInitial.call(repository, input);
      if (typeof result !== "boolean") {
        throw new Error("source-key registry create result is invalid");
      }
      return result;
    },
    async deleteInitialIfMatch(
      input: SourceKeyRegistryRecord,
    ): Promise<boolean> {
      const result: unknown = await deleteInitialIfMatch.call(
        repository,
        input,
      );
      if (typeof result !== "boolean") {
        throw new Error("source-key registry delete result is invalid");
      }
      return result;
    },
    async revalidateSessionAuthority(
      input: Parameters<SourceKeyRegistryPort["revalidateSessionAuthority"]>[0],
    ): Promise<boolean> {
      const result: unknown = await revalidateSessionAuthority.call(repository, input);
      if (typeof result !== "boolean") {
        throw new Error("source-key session authority result is invalid");
      }
      return result;
    },
  });
}

/** CockroachDB-backed recovery-wrapper store. Device wrappers remain local. */
export class CockroachWrappedKeyStore implements WrappedKeyStore {
  private portPromise: Promise<SourceKeyRegistryPort> | null = null;

  constructor(
    private readonly loadPort: () => Promise<SourceKeyRegistryPort>,
  ) {}

  async get(userId: string): Promise<unknown> {
    const row = await (await this.port()).getCurrent(userId);
    if (row === null) return undefined;
    if (!recoveryMetadataMatches(userId, row)) {
      throw new Error("source-key registry metadata mismatch");
    }
    return row.recovery_wrapper;
  }

  async create(userId: string, value: WrappedUserKey): Promise<boolean> {
    if (value.userId !== userId) {
      throw new Error("source-key owner mismatch");
    }
    return await (
      await this.port()
    ).createInitial(registryRecord(userId, value));
  }

  async deleteIfMatch(userId: string, value: WrappedUserKey): Promise<boolean> {
    if (value.userId !== userId) return false;
    return await (
      await this.port()
    ).deleteInitialIfMatch(registryRecord(userId, value));
  }

  private async port(): Promise<SourceKeyRegistryPort> {
    this.portPromise ??= this.loadPort();
    return await this.portPromise;
  }
}
