import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { open as openFile, type FileHandle } from "node:fs/promises";
import { MODEL_REGISTRY, type ModelEntry } from "./model-registry.js";

export const ACTIVE_MODEL_MANIFEST = "managed-active-model.json";

export interface ManagedModelManifest {
  schemaVersion: 1;
  modelId: string;
  registryVersion: number;
  revision: string;
  filename: string;
  exactBytes: number;
  sha256: string;
  sourceUrl: string;
  licenseSpdxId: string;
  verifiedAt: string;
}

export type ManagedModelInspection =
  | { state: "missing" }
  | { state: "invalid"; reason: string }
  | {
      state: "verified";
      path: string;
      manifest: ManagedModelManifest;
      model: ModelEntry;
    };

export function managedArtifactFilename(model: ModelEntry): string {
  return `${model.id}-${model.source.revision.slice(0, 12)}-${model.sha256.slice(0, 12)}.gguf`;
}

export function managedArtifactPath(
  modelDir: string,
  model: ModelEntry,
): string {
  return join(modelDir, managedArtifactFilename(model));
}

function assertRegularSingleLink(
  fd: number,
  label: string,
): ReturnType<typeof fstatSync> {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.nlink !== 1)
    throw new Error(`${label}_not_private_regular_file`);
  return stats;
}

export function computeFileDescriptorSha256(fd: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  let read: number;
  do {
    read = readSync(fd, buffer, 0, buffer.length, offset);
    if (read > 0) {
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } while (read > 0);
  return hash.digest("hex");
}

export async function computeFileHandleSha256(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  let read: number;
  do {
    ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, offset));
    if (read > 0) {
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } while (read > 0);
  return hash.digest("hex");
}

export function computeFileSha256(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertRegularSingleLink(fd, "artifact");
    return computeFileDescriptorSha256(fd);
  } finally {
    closeSync(fd);
  }
}

function isManifest(value: unknown): value is ManagedModelManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["schemaVersion"] === 1 &&
    typeof v["modelId"] === "string" &&
    Number.isInteger(v["registryVersion"]) &&
    typeof v["revision"] === "string" &&
    typeof v["filename"] === "string" &&
    Number.isSafeInteger(v["exactBytes"]) &&
    typeof v["sha256"] === "string" &&
    typeof v["sourceUrl"] === "string" &&
    typeof v["licenseSpdxId"] === "string" &&
    typeof v["verifiedAt"] === "string"
  );
}

interface ManagedModelCandidate {
  state: "candidate";
  path: string;
  manifest: ManagedModelManifest;
  model: ModelEntry;
}

function resolveManagedModelCandidate(
  modelDir: string | null,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): ManagedModelInspection | ManagedModelCandidate {
  if (!modelDir) return { state: "missing" };
  const manifestPath = join(modelDir, ACTIVE_MODEL_MANIFEST);
  if (!existsSync(manifestPath)) return { state: "missing" };
  let manifest: ManagedModelManifest;
  try {
    const fd = openSync(
      manifestPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let raw: string;
    try {
      assertRegularSingleLink(fd, "manifest");
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isManifest(parsed))
      return { state: "invalid", reason: "manifest_schema_invalid" };
    manifest = parsed;
  } catch {
    return { state: "invalid", reason: "manifest_unreadable" };
  }
  const model = registry.find((entry) => entry.id === manifest.modelId) ?? null;
  if (!model) return { state: "invalid", reason: "artifact_not_in_registry" };
  const expectedFilename = managedArtifactFilename(model);
  if (
    manifest.registryVersion !== model.version ||
    manifest.revision !== model.source.revision ||
    manifest.filename !== expectedFilename ||
    manifest.filename !== basename(manifest.filename) ||
    manifest.exactBytes !== model.exactBytes ||
    manifest.sha256 !== model.sha256 ||
    manifest.sourceUrl !== model.source.downloadUrl ||
    manifest.licenseSpdxId !== model.license.spdxId
  ) {
    return { state: "invalid", reason: "manifest_registry_mismatch" };
  }
  const path = join(modelDir, expectedFilename);
  return { state: "candidate", path, manifest, model };
}

/** Fail closed: the runtime receives a path only after manifest, size and digest agree. */
export function inspectManagedActiveModel(
  modelDir: string | null,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): ManagedModelInspection {
  const candidate = resolveManagedModelCandidate(modelDir, registry);
  if (candidate.state !== "candidate") return candidate;
  const { path, manifest, model } = candidate;
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = assertRegularSingleLink(fd, "artifact");
      if (before.size !== model.exactBytes)
        return { state: "invalid", reason: "artifact_size_mismatch" };
      if (computeFileDescriptorSha256(fd) !== model.sha256)
        return { state: "invalid", reason: "artifact_digest_mismatch" };
      const after = fstatSync(fd);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        return {
          state: "invalid",
          reason: "artifact_changed_during_verification",
        };
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return { state: "invalid", reason: "artifact_unreadable" };
  }
  return { state: "verified", path, manifest, model };
}

/** Runtime-safe inspection: full descriptor hashing never blocks the event loop. */
export async function inspectManagedActiveModelAsync(
  modelDir: string | null,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): Promise<ManagedModelInspection> {
  const candidate = resolveManagedModelCandidate(modelDir, registry);
  if (candidate.state !== "candidate") return candidate;
  const { path, manifest, model } = candidate;
  let handle: FileHandle | null = null;
  try {
    handle = await openFile(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      return { state: "invalid", reason: "artifact_unreadable" };
    if (Number(before.size) !== model.exactBytes)
      return { state: "invalid", reason: "artifact_size_mismatch" };
    if ((await computeFileHandleSha256(handle)) !== model.sha256)
      return { state: "invalid", reason: "artifact_digest_mismatch" };
    const after = await handle.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      return {
        state: "invalid",
        reason: "artifact_changed_during_verification",
      };
    }
  } catch {
    return { state: "invalid", reason: "artifact_unreadable" };
  } finally {
    await handle?.close();
  }
  return { state: "verified", path, manifest, model };
}

/**
 * Verify a staged file and atomically switch the active manifest. The previous
 * active artifact and manifest are untouched until the new artifact is durable.
 */
const modelDirMutationTails = new Map<string, Promise<void>>();

async function withModelDirMutationLock<T>(
  modelDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = resolve(modelDir);
  const previous = modelDirMutationTails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  modelDirMutationTails.set(lockKey, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (modelDirMutationTails.get(lockKey) === tail)
      modelDirMutationTails.delete(lockKey);
  }
}

async function reconcileOrphanedPublicationLink(
  modelDir: string,
  target: string,
  model: ModelEntry,
): Promise<void> {
  let targetHandle: FileHandle | null = null;
  try {
    targetHandle = await openFile(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const targetStats = await targetHandle.stat({ bigint: true });
    if (
      !targetStats.isFile() ||
      targetStats.nlink !== 2n ||
      Number(targetStats.size) !== model.exactBytes ||
      (await computeFileHandleSha256(targetHandle)) !== model.sha256
    ) {
      return;
    }
    const afterHash = await targetHandle.stat({ bigint: true });
    if (
      afterHash.dev !== targetStats.dev ||
      afterHash.ino !== targetStats.ino ||
      afterHash.size !== targetStats.size ||
      afterHash.mtimeNs !== targetStats.mtimeNs ||
      afterHash.ctimeNs !== targetStats.ctimeNs ||
      afterHash.nlink !== 2n
    ) {
      return;
    }

    const prefix = `${basename(target)}.`;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const name of readdirSync(modelDir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".installing")) continue;
      const identifier = name.slice(prefix.length, -".installing".length);
      if (!uuid.test(identifier)) continue;
      const candidate = join(modelDir, name);
      let candidateHandle: FileHandle | null = null;
      try {
        candidateHandle = await openFile(
          candidate,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const candidateStats = await candidateHandle.stat({ bigint: true });
        if (
          !candidateStats.isFile() ||
          candidateStats.dev !== targetStats.dev ||
          candidateStats.ino !== targetStats.ino ||
          candidateStats.nlink !== 2n
        ) {
          continue;
        }

        const quarantine = `${candidate}.${randomUUID()}.reconciling`;
        renameSync(candidate, quarantine);
        let quarantineHandle: FileHandle | null = null;
        try {
          quarantineHandle = await openFile(
            quarantine,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          const quarantined = await quarantineHandle.stat({ bigint: true });
          if (
            !quarantined.isFile() ||
            quarantined.dev !== targetStats.dev ||
            quarantined.ino !== targetStats.ino ||
            quarantined.nlink !== 2n
          ) {
            throw new Error("orphaned_publication_link_changed");
          }
          unlinkSync(quarantine);
        } catch (error) {
          if (!existsSync(candidate) && existsSync(quarantine)) {
            try {
              renameSync(quarantine, candidate);
            } catch {
              /* retain an unverified path rather than delete it */
            }
          }
          throw error;
        } finally {
          await quarantineHandle?.close();
        }

        const reconciled = await targetHandle.stat({ bigint: true });
        if (
          reconciled.dev !== targetStats.dev ||
          reconciled.ino !== targetStats.ino ||
          reconciled.size !== targetStats.size ||
          reconciled.nlink !== 1n
        ) {
          throw new Error("orphaned_publication_target_changed");
        }
        return;
      } finally {
        await candidateHandle?.close();
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "orphaned_publication_link_changed" ||
        error.message === "orphaned_publication_target_changed")
    ) {
      throw error;
    }
    // Missing, linked, or otherwise untrusted targets are handled by the
    // caller's ordinary exact validation and remain untouched here.
  } finally {
    await targetHandle?.close();
  }
}

export async function activateManagedModel(
  modelDir: string,
  stagedPath: string,
  model: ModelEntry,
): Promise<ManagedModelManifest> {
  return withModelDirMutationLock(modelDir, () =>
    activateManagedModelUnlocked(modelDir, stagedPath, model),
  );
}

async function activateManagedModelUnlocked(
  modelDir: string,
  stagedPath: string,
  model: ModelEntry,
): Promise<ManagedModelManifest> {
  mkdirSync(modelDir, { recursive: true });
  const target = managedArtifactPath(modelDir, model);
  const artifactTemporary = `${target}.${randomUUID()}.installing`;
  const source = await openFile(
    stagedPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let artifactTemporaryPresent = false;
  let stagedIdentity: { dev: bigint; ino: bigint } | null = null;
  try {
    const staged = await source.stat({ bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n)
      throw new Error("staged_artifact_not_private_regular_file");
    if (Number(staged.size) !== model.exactBytes)
      throw new Error(
        `artifact_size_mismatch:${model.exactBytes}:${staged.size}`,
      );
    stagedIdentity = { dev: staged.dev, ino: staged.ino };
    const actual = await computeFileHandleSha256(source);
    if (actual !== model.sha256)
      throw new Error(`artifact_digest_mismatch:${model.sha256}:${actual}`);

    // Copy from the verified descriptor, not the path. A concurrent path swap
    // cannot change which bytes are published. The unique file is created
    // exclusively, fsynced, and verified again before an atomic no-overwrite
    // hard-link publishes it at the content-addressed target name.
    const destination = await openFile(
      artifactTemporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    artifactTemporaryPresent = true;
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      let read: number;
      do {
        ({ bytesRead: read } = await source.read(
          buffer,
          0,
          buffer.length,
          offset,
        ));
        if (read > 0) {
          let written = 0;
          while (written < read) {
            const result = await destination.write(
              buffer,
              written,
              read - written,
              offset + written,
            );
            written += result.bytesWritten;
          }
          offset += read;
        }
      } while (read > 0);
      await destination.sync();
    } finally {
      await destination.close();
    }
    if ((await computeFileSha256Async(artifactTemporary)) !== model.sha256)
      throw new Error("copied_artifact_digest_mismatch");

    try {
      linkSync(artifactTemporary, target);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST") throw error;
      await reconcileOrphanedPublicationLink(modelDir, target, model);
      try {
        const targetHandle = await openFile(
          target,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const targetStats = await targetHandle.stat({ bigint: true });
          if (
            !targetStats.isFile() ||
            targetStats.nlink !== 1n ||
            Number(targetStats.size) !== model.exactBytes ||
            (await computeFileHandleSha256(targetHandle)) !== model.sha256
          ) {
            throw new Error("existing_managed_artifact_invalid");
          }
        } finally {
          await targetHandle.close();
        }
      } catch (targetError) {
        if (
          targetError instanceof Error &&
          targetError.message === "existing_managed_artifact_invalid"
        )
          throw targetError;
        throw new Error("existing_managed_artifact_invalid");
      }
    }
  } finally {
    if (artifactTemporaryPresent) {
      try {
        unlinkSync(artifactTemporary);
        artifactTemporaryPresent = false;
      } catch {
        /* best effort */
      }
    }
    await source.close();
  }
  const manifest: ManagedModelManifest = {
    schemaVersion: 1,
    modelId: model.id,
    registryVersion: model.version,
    revision: model.source.revision,
    filename: managedArtifactFilename(model),
    exactBytes: model.exactBytes,
    sha256: model.sha256,
    sourceUrl: model.source.downloadUrl,
    licenseSpdxId: model.license.spdxId,
    verifiedAt: new Date().toISOString(),
  };
  const manifestPath = join(modelDir, ACTIVE_MODEL_MANIFEST);
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    const targetHandle = await openFile(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const targetStats = await targetHandle.stat({ bigint: true });
      if (
        !targetStats.isFile() ||
        targetStats.nlink !== 1n ||
        Number(targetStats.size) !== model.exactBytes ||
        (await computeFileHandleSha256(targetHandle)) !== model.sha256
      ) {
        throw new Error("managed_artifact_changed_before_manifest");
      }
      const afterHash = await targetHandle.stat({ bigint: true });
      if (
        afterHash.size !== targetStats.size ||
        afterHash.mtimeNs !== targetStats.mtimeNs ||
        afterHash.ctimeNs !== targetStats.ctimeNs
      ) {
        throw new Error("managed_artifact_changed_before_manifest");
      }
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, manifestPath);
    // Some Windows filesystems do not permit opening directories. The file
    // and manifest are already fsynced; directory fsync is extra crash safety.
    try {
      const dirFd = openSync(dirname(manifestPath), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* platform does not support directory fsync */
    }
  } catch (error) {
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        /* best effort */
      }
    }
    // A published artifact is content-addressed and harmless while inactive.
    // Do not unlink it here: a path swap between failure and cleanup could
    // otherwise delete an attacker-selected replacement. A later retry reuses
    // the verified artifact and switches the manifest.
    throw error;
  }
  if (stagedIdentity !== null) {
    // Remove only the same private inode that was verified. unlink() never
    // follows a symlink; the identity check rejects a regular file that was
    // already substituted before cleanup begins.
    let stagedFd: number | null = null;
    try {
      stagedFd = openSync(
        stagedPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const current = fstatSync(stagedFd, { bigint: true });
      if (
        current.isFile() &&
        current.nlink === 1n &&
        current.dev === stagedIdentity.dev &&
        current.ino === stagedIdentity.ino
      ) {
        unlinkSync(stagedPath);
      }
    } catch {
      /* already gone or replaced; never remove an unverified path */
    } finally {
      if (stagedFd !== null) closeSync(stagedFd);
    }
  }
  return manifest;
}

export async function deleteInactiveManagedModel(
  modelDir: string,
  modelId: string,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): Promise<boolean> {
  return withModelDirMutationLock(modelDir, async () =>
    deleteInactiveManagedModelUnlocked(modelDir, modelId, registry),
  );
}

async function deleteInactiveManagedModelUnlocked(
  modelDir: string,
  modelId: string,
  registry: readonly ModelEntry[],
): Promise<boolean> {
  const active = await inspectManagedActiveModelAsync(modelDir, registry);
  if (active.state === "invalid") throw new Error("active_model_state_invalid");
  if (active.state === "verified" && active.model.id === modelId) {
    throw new Error("active_model_requires_replacement");
  }
  const model = registry.find((entry) => entry.id === modelId) ?? null;
  if (!model) throw new Error("artifact_not_in_registry");
  const path = managedArtifactPath(modelDir, model);
  if (!existsSync(path)) return false;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const quarantine = `${path}.${randomUUID()}.deleting`;
  try {
    const expected = assertRegularSingleLink(fd, "inactive_artifact");
    renameSync(path, quarantine);
    let quarantineFd: number | null = null;
    try {
      quarantineFd = openSync(
        quarantine,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const moved = fstatSync(quarantineFd);
      if (moved.dev !== expected.dev || moved.ino !== expected.ino) {
        throw new Error("inactive_artifact_changed_before_delete");
      }
      unlinkSync(quarantine);
    } catch (error) {
      // Restore only when the managed name is still vacant. Never overwrite a
      // concurrent replacement while unwinding a failed identity check.
      if (!existsSync(path) && existsSync(quarantine)) {
        try {
          renameSync(quarantine, path);
        } catch {
          /* leave quarantined rather than deleting an unverified path */
        }
      }
      throw error;
    } finally {
      if (quarantineFd !== null) closeSync(quarantineFd);
    }
  } finally {
    closeSync(fd);
  }
  return true;
}

// Retained only for callers that need streaming verification without activation.
export async function computeFileSha256Async(path: string): Promise<string> {
  const handle = await openFile(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n)
      throw new Error("artifact_not_private_regular_file");
    return await computeFileHandleSha256(handle);
  } finally {
    await handle.close();
  }
}
