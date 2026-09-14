import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function sameStat(left, right) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (field) => left[field] === right[field],
  );
}

function openStableRegularFile(root, path) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const rootStat = lstatSync(absoluteRoot, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error(`${root} is not a real directory`);
  const realRoot = realpathSync(absoluteRoot);
  const parent = dirname(absolutePath);
  const parentStat = lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error(`${parent} is not a real directory`);
  const realParent = realpathSync(parent);
  if (!isWithin(realRoot, join(realParent, basename(absolutePath))))
    throw new Error(`${path} escapes artifact root`);
  const beforePath = lstatSync(absolutePath, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink())
    throw new Error(`${path} is not a regular file`);
  const fd = openSync(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = fstatSync(fd, { bigint: true });
  if (!opened.isFile() || !sameStat(beforePath, opened)) {
    closeSync(fd);
    throw new Error(`${path} changed before opening`);
  }
  return { absolutePath, beforePath, fd };
}

function finishStableRead(state) {
  const afterFd = fstatSync(state.fd, { bigint: true });
  const afterPath = lstatSync(state.absolutePath, { bigint: true });
  if (
    !sameStat(state.beforePath, afterFd) ||
    !sameStat(state.beforePath, afterPath)
  )
    throw new Error(`${state.absolutePath} changed while reading`);
}

function hashers() {
  return {
    sha1: createHash("sha1"),
    sha256: createHash("sha256"),
    sha512: createHash("sha512"),
  };
}

function finishHashers(value, size) {
  return {
    sha1: value.sha1.digest("hex"),
    sha256: value.sha256.digest("hex"),
    sha512: value.sha512.digest("base64"),
    size,
  };
}

function consumeStableRegularFile(
  root,
  path,
  { afterOpen, captureBytes, maxBytes },
) {
  const state = openStableRegularFile(root, path);
  try {
    if (maxBytes !== undefined && state.beforePath.size > BigInt(maxBytes))
      throw new Error(`${path} exceeds the ${maxBytes}-byte read limit`);
    afterOpen?.(state.absolutePath);
    const chunks = captureBytes ? [] : null;
    const hashes = hashers();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(state.fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      if (maxBytes !== undefined && position + count > maxBytes)
        throw new Error(`${path} exceeds the ${maxBytes}-byte read limit`);
      const chunk = Buffer.from(buffer.subarray(0, count));
      chunks?.push(chunk);
      for (const hash of Object.values(hashes)) hash.update(chunk);
      position += count;
    }
    finishStableRead(state);
    return {
      ...(chunks ? { bytes: Buffer.concat(chunks, position) } : {}),
      ...finishHashers(hashes, position),
    };
  } finally {
    closeSync(state.fd);
  }
}

/** Read one regular file through a stable descriptor. `afterOpen` is a test-only race hook. */
export function readStableRegularFile(
  root,
  path,
  { afterOpen, maxBytes } = {},
) {
  return consumeStableRegularFile(root, path, {
    afterOpen,
    captureBytes: true,
    maxBytes,
  });
}

export function hashStableRegularFile(root, path, options) {
  return consumeStableRegularFile(root, path, {
    afterOpen: options?.afterOpen,
    captureBytes: false,
    maxBytes: options?.maxBytes,
  });
}

/** Copy and hash through the same stable source descriptor; destination creation is exclusive. */
export function stageStableRegularFile(
  root,
  source,
  destination,
  { afterOpen } = {},
) {
  const state = openStableRegularFile(root, source);
  let outputFd;
  try {
    afterOpen?.(state.absolutePath);
    outputFd = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o644,
    );
    const hashes = hashers();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const count = readSync(state.fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      let written = 0;
      while (written < count)
        written += writeSync(
          outputFd,
          buffer,
          written,
          count - written,
          position + written,
        );
      const chunk = buffer.subarray(0, count);
      for (const hash of Object.values(hashes)) hash.update(chunk);
      position += count;
    }
    finishStableRead(state);
    return finishHashers(hashes, position);
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
    closeSync(state.fd);
  }
}

export function pathsOverlap(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || isWithin(a, b) || isWithin(b, a);
}
