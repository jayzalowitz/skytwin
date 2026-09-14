import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStableRegularFile } from "./file-integrity.mjs";

const temporary = [];

afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skytwin-stable-file-"));
  temporary.push(root);
  const path = join(root, "subject.bin");
  writeFileSync(path, "subject");
  return { root, path };
}

describe("stable regular-file reads", () => {
  it("enforces a bounded read while a file grows after opening", () => {
    const value = fixture();
    expect(() =>
      readStableRegularFile(value.root, value.path, {
        maxBytes: 8,
        afterOpen(path) {
          appendFileSync(path, Buffer.alloc(64));
        },
      }),
    ).toThrow("exceeds the 8-byte read limit");
  });

  it("detects metadata-only ctime changes during a read", () => {
    const value = fixture();
    expect(() =>
      readStableRegularFile(value.root, value.path, {
        afterOpen(path) {
          chmodSync(path, 0o600);
        },
      }),
    ).toThrow("changed while reading");
  });
});
