import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_REGISTRY, type ModelEntry } from "@skytwin/embedded-llm";
import { restorePartialCheckpoint } from "../downloader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(): { partial: string; model: ModelEntry } {
  const dir = mkdtempSync(join(tmpdir(), "skytwin-checkpoint-"));
  dirs.push(dir);
  const partial = join(dir, "model.partial");
  const base = MODEL_REGISTRY[0]!;
  const model = {
    ...base,
    exactBytes: 10,
    approxBytes: 10,
    minimumRamBytes: 10,
  };
  writeFileSync(partial, Buffer.from("1234567"));
  writeFileSync(
    `${partial}.json`,
    JSON.stringify({
      schemaVersion: 1,
      modelId: model.id,
      revision: model.source.revision,
      sourceUrl: model.source.downloadUrl,
      exactBytes: 10,
      bytesDownloaded: 4,
      validator: { etag: '"immutable"' },
    }),
  );
  return { partial, model };
}

describe("durable partial checkpoints", () => {
  it("discards an uncommitted crash tail and resumes from the fsynced state/DB checkpoint", () => {
    const { partial, model } = setup();
    const restored = restorePartialCheckpoint(
      partial,
      { model_id: model.id, bytes_downloaded: 4 },
      model,
    );
    expect(restored).toMatchObject({
      resumeFrom: 4,
      validator: { etag: '"immutable"' },
    });
    expect(statSync(partial).size).toBe(4);
  });

  it("normalizes a raw Cockroach INT8 string before using it as a file offset", () => {
    const { partial, model } = setup();
    const restored = restorePartialCheckpoint(
      partial,
      {
        model_id: model.id,
        bytes_downloaded: "4" as unknown as number,
      },
      model,
    );
    expect(restored.resumeFrom).toBe(4);
    expect(typeof restored.resumeFrom).toBe("number");
    expect(statSync(partial).size).toBe(4);
  });

  it("fails closed when the database and checkpoint disagree", () => {
    const { partial, model } = setup();
    expect(() =>
      restorePartialCheckpoint(
        partial,
        { model_id: model.id, bytes_downloaded: 5 },
        model,
      ),
    ).toThrow("Partial file, database and HTTP validator did not agree");
  });

  it("uses the older DB boundary when a crash happened after state fsync but before DB CAS", () => {
    const { partial, model } = setup();
    const state = JSON.parse(readFileSync(`${partial}.json`, "utf8")) as Record<
      string,
      unknown
    >;
    state["bytesDownloaded"] = 5;
    writeFileSync(`${partial}.json`, JSON.stringify(state));
    const restored = restorePartialCheckpoint(
      partial,
      { model_id: model.id, bytes_downloaded: 4 },
      model,
    );
    expect(restored.resumeFrom).toBe(4);
    expect(statSync(partial).size).toBe(4);
  });
});
