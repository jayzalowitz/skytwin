import { afterEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link input without following it",
    () => {
      const value = fixture();
      const alias = join(value.root, "alias.bin");
      symlinkSync(value.path, alias);
      expect(() => readStableRegularFile(value.root, alias)).toThrow(
        "contains a symbolic-link component",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link directory component inside the root",
    () => {
      const value = fixture();
      const target = join(value.root, "target");
      const alias = join(value.root, "alias");
      mkdirSync(target);
      writeFileSync(join(target, "subject.bin"), "subject");
      symlinkSync(target, alias);
      expect(() =>
        readStableRegularFile(value.root, join(alias, "subject.bin")),
      ).toThrow("contains a symbolic-link component");
    },
  );
});
