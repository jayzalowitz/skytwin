import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateManagedModel,
  ACTIVE_MODEL_MANIFEST,
  deleteInactiveManagedModel,
  inspectManagedActiveModel,
  inspectManagedActiveModelAsync,
  managedArtifactPath,
  writeFileHandleFully,
} from "../managed-model-store.js";
import { MODEL_REGISTRY, type ModelEntry } from "../model-registry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "skytwin-managed-model-"));
  dirs.push(dir);
  return dir;
}

function tinyModel(id: string, bytes: Buffer): ModelEntry {
  const base = MODEL_REGISTRY[0]!;
  return {
    ...base,
    id,
    displayName: id,
    exactBytes: bytes.length,
    approxBytes: bytes.length,
    minimumRamBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: { ...base.source, filename: `${id}.gguf` },
  };
}

describe("managed model activation", () => {
  it("completes repeated short writes at the correct buffer and file offsets", async () => {
    const write = vi.fn().mockImplementation(
      async (buffer: Buffer, _offset: number, length: number) => ({
        bytesWritten: Math.min(2, length),
        buffer,
      }),
    );
    const persisted = vi.fn();

    await writeFileHandleFully(
      { write } as unknown as Pick<FileHandle, "write">,
      Buffer.from("chunk"),
      5,
      11,
      persisted,
    );

    expect(write.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 5, 11],
      [2, 3, 13],
      [4, 1, 15],
    ]);
    expect(persisted.mock.calls.map(([bytes]) => bytes)).toEqual([2, 2, 1]);
  });

  it("rejects a zero-progress managed artifact write", async () => {
    const write = vi.fn().mockResolvedValue({
      bytesWritten: 0,
      buffer: Buffer.from("chunk"),
    });

    await expect(writeFileHandleFully(
      { write } as unknown as Pick<FileHandle, "write">,
      Buffer.from("chunk"),
      5,
      0,
    )).rejects.toThrow("managed_artifact_write_made_no_progress");
    expect(write).toHaveBeenCalledOnce();
  });

  it("activates only exact bytes and verifies before returning a runtime path", async () => {
    const dir = directory();
    const bytes = Buffer.from("tiny verified gguf fixture");
    const model = tinyModel("tiny-one", bytes);
    const staged = join(dir, "download.partial");
    const persisted = vi.fn();
    writeFileSync(staged, bytes);
    await activateManagedModel(dir, staged, model, persisted);
    expect(
      persisted.mock.calls.reduce(
        (total, [written]) => total + (written as number),
        0,
      ),
    ).toBe(bytes.length);
    const result = inspectManagedActiveModel(dir, [model]);
    expect(result.state).toBe("verified");
    if (result.state === "verified")
      expect(readFileSync(result.path)).toEqual(bytes);
    await expect(inspectManagedActiveModelAsync(dir, [model])).resolves.toMatchObject({
      state: "verified",
      model: { id: model.id },
    });
  });

  it("preserves the last good active model when replacement verification fails", async () => {
    const dir = directory();
    const firstBytes = Buffer.from("first good model");
    const first = tinyModel("tiny-first", firstBytes);
    const firstStage = join(dir, "first.partial");
    writeFileSync(firstStage, firstBytes);
    await activateManagedModel(dir, firstStage, first);

    const second = tinyModel(
      "tiny-second",
      Buffer.from("expected second bytes"),
    );
    const corrupt = join(dir, "second.partial");
    writeFileSync(corrupt, Buffer.from("corrupt"));
    await expect(activateManagedModel(dir, corrupt, second)).rejects.toThrow(
      "artifact_size_mismatch",
    );
    const active = inspectManagedActiveModel(dir, [first, second]);
    expect(active.state).toBe("verified");
    if (active.state === "verified") expect(active.model.id).toBe(first.id);
  });

  it("fails closed after artifact tampering", async () => {
    const dir = directory();
    const bytes = Buffer.from("untampered model");
    const model = tinyModel("tiny-tamper", bytes);
    const staged = join(dir, "download.partial");
    writeFileSync(staged, bytes);
    await activateManagedModel(dir, staged, model);
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 0xff;
    writeFileSync(managedArtifactPath(dir, model), tampered);
    expect(inspectManagedActiveModel(dir, [model])).toEqual({
      state: "invalid",
      reason: "artifact_digest_mismatch",
    });
    await expect(inspectManagedActiveModelAsync(dir, [model])).resolves.toEqual({
      state: "invalid",
      reason: "artifact_digest_mismatch",
    });
  });

  it("requires replacement before deleting the active artifact", async () => {
    const dir = directory();
    const bytes = Buffer.from("active model");
    const model = tinyModel("tiny-active", bytes);
    const staged = join(dir, "download.partial");
    writeFileSync(staged, bytes);
    await activateManagedModel(dir, staged, model);
    await expect(deleteInactiveManagedModel(dir, model.id, [model])).rejects.toThrow(
      "active_model_requires_replacement",
    );
  });

  it("refuses to delete an inactive artifact that is no longer a private inode", async () => {
    const dir = directory();
    const bytes = Buffer.from("inactive hard-link target");
    const model = tinyModel("tiny-inactive-hardlink", bytes);
    const outside = join(dir, "outside-inactive.gguf");
    writeFileSync(outside, bytes);
    linkSync(outside, managedArtifactPath(dir, model));

    await expect(deleteInactiveManagedModel(dir, model.id, [model])).rejects.toThrow(
      "inactive_artifact_not_private_regular_file",
    );
    expect(readFileSync(outside)).toEqual(bytes);
  });

  it("never follows a managed artifact symlink", async () => {
    const dir = directory();
    const bytes = Buffer.from("symlink target");
    const model = tinyModel("tiny-symlink", bytes);
    const staged = join(dir, "download.partial");
    writeFileSync(staged, bytes);
    await activateManagedModel(dir, staged, model);
    const target = managedArtifactPath(dir, model);
    rmSync(target);
    const outside = join(dir, "outside.gguf");
    writeFileSync(outside, bytes);
    symlinkSync(outside, target);
    expect(inspectManagedActiveModel(dir, [model])).toEqual({
      state: "invalid",
      reason: "artifact_unreadable",
    });
  });

  it("leaves a verified content-addressed artifact inactive if manifest activation fails", async () => {
    const dir = directory();
    const bytes = Buffer.from("activation cleanup");
    const model = tinyModel("tiny-cleanup", bytes);
    const staged = join(dir, "download.partial");
    writeFileSync(staged, bytes);
    mkdirSync(join(dir, ACTIVE_MODEL_MANIFEST));
    await expect(activateManagedModel(dir, staged, model)).rejects.toThrow();
    expect(existsSync(managedArtifactPath(dir, model))).toBe(true);
  });

  it("recovers a verified publication link left by an interrupted activation", async () => {
    const dir = directory();
    const bytes = Buffer.from("interrupted publication");
    const model = tinyModel("tiny-interrupted", bytes);
    const target = managedArtifactPath(dir, model);
    const orphan = `${target}.12345678-1234-4123-8123-123456789abc.installing`;
    writeFileSync(target, bytes);
    linkSync(target, orphan);
    expect(statSync(target).nlink).toBe(2);

    const staged = join(dir, "retry.partial");
    writeFileSync(staged, bytes);
    await activateManagedModel(dir, staged, model);

    expect(existsSync(orphan)).toBe(false);
    expect(statSync(target).nlink).toBe(1);
    const quarantine = readdirSync(dir).find(name =>
      name.startsWith(".skytwin-orphan-"));
    expect(quarantine).toBeDefined();
    const retained = readdirSync(join(dir, quarantine!)).sort();
    expect(retained).toEqual(["managed-target", "publication-link"]);
    expect(statSync(join(dir, quarantine!, retained[0]!)).nlink).toBe(2);
    expect(inspectManagedActiveModel(dir, [model])).toMatchObject({
      state: "verified",
      model: { id: model.id },
    });
  });

  it("does not delete lookalike installation files or unrelated hard links", async () => {
    const dir = directory();
    const bytes = Buffer.from("untrusted publication collision");
    const model = tinyModel("tiny-untrusted-interrupted", bytes);
    const target = managedArtifactPath(dir, model);
    const outside = join(dir, "outside-hard-link.gguf");
    const lookalike = `${target}.12345678-1234-4123-8123-123456789abc.installing`;
    writeFileSync(target, bytes);
    linkSync(target, outside);
    writeFileSync(lookalike, "unrelated contents");
    const staged = join(dir, "retry.partial");
    writeFileSync(staged, bytes);

    await expect(activateManagedModel(dir, staged, model)).rejects.toThrow(
      "existing_managed_artifact_invalid",
    );
    expect(readFileSync(outside)).toEqual(bytes);
    expect(readFileSync(lookalike, "utf8")).toBe("unrelated contents");
    expect(statSync(target).nlink).toBe(2);
  });

  it("rejects staged symlinks and hard links before copying bytes", async () => {
    const dir = directory();
    const bytes = Buffer.from("private staging file");
    const model = tinyModel("tiny-private", bytes);
    const outside = join(dir, "outside.gguf");
    writeFileSync(outside, bytes);
    const symlink = join(dir, "symlink.partial");
    symlinkSync(outside, symlink);
    await expect(activateManagedModel(dir, symlink, model)).rejects.toThrow();

    const hardlink = join(dir, "hardlink.partial");
    linkSync(outside, hardlink);
    await expect(activateManagedModel(dir, hardlink, model)).rejects.toThrow(
      "staged_artifact_not_private_regular_file",
    );
    expect(existsSync(managedArtifactPath(dir, model))).toBe(false);
  });

  it("never overwrites an existing target symlink during publication", async () => {
    const dir = directory();
    const bytes = Buffer.from("publication collision");
    const model = tinyModel("tiny-publish", bytes);
    const staged = join(dir, "download.partial");
    writeFileSync(staged, bytes);
    const outside = join(dir, "outside.gguf");
    writeFileSync(outside, "do not modify");
    symlinkSync(outside, managedArtifactPath(dir, model));
    await expect(activateManagedModel(dir, staged, model)).rejects.toThrow(
      "existing_managed_artifact_invalid",
    );
    expect(readFileSync(outside, "utf8")).toBe("do not modify");
  });

  it("keeps concurrent activation of the same immutable artifact valid", async () => {
    const dir = directory();
    const bytes = Buffer.from("concurrent immutable activation");
    const model = tinyModel("tiny-concurrent", bytes);
    const first = join(dir, "first.partial");
    const second = join(dir, "second.partial");
    writeFileSync(first, bytes);
    writeFileSync(second, bytes);

    await Promise.all([
      activateManagedModel(dir, first, model),
      activateManagedModel(dir, second, model),
    ]);
    expect(inspectManagedActiveModel(dir, [model]).state).toBe("verified");
  });

  it("serializes deletion behind activation and preserves the newly active artifact", async () => {
    const dir = directory();
    const firstBytes = Buffer.from("first active model");
    const first = tinyModel("tiny-lock-first", firstBytes);
    const firstStage = join(dir, "first.partial");
    writeFileSync(firstStage, firstBytes);
    await activateManagedModel(dir, firstStage, first);

    const nextBytes = Buffer.from("next active model");
    const next = tinyModel("tiny-lock-next", nextBytes);
    const inactiveStage = join(dir, "inactive.partial");
    const activationStage = join(dir, "activation.partial");
    writeFileSync(inactiveStage, nextBytes);
    await activateManagedModel(dir, inactiveStage, next);
    // Switch back so the next artifact exists but is inactive.
    const firstAgain = join(dir, "first-again.partial");
    writeFileSync(firstAgain, firstBytes);
    await activateManagedModel(dir, firstAgain, first);
    writeFileSync(activationStage, nextBytes);

    const activating = activateManagedModel(dir, activationStage, next);
    const deleting = deleteInactiveManagedModel(dir, next.id, [first, next]);
    await activating;
    await expect(deleting).rejects.toThrow("active_model_requires_replacement");
    expect(inspectManagedActiveModel(dir, [first, next]).state).toBe("verified");
  });
});
