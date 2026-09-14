export interface StableFileReadOptions {
  afterOpen?: (path: string) => void;
  maxBytes?: number;
}

export interface StableFileRead {
  bytes: Buffer;
  sha1: string;
  sha256: string;
  sha512: string;
  size: number;
}

export function readStableRegularFile(
  root: string,
  path: string,
  options?: StableFileReadOptions,
): StableFileRead;

export function hashStableRegularFile(
  root: string,
  path: string,
  options?: StableFileReadOptions,
): Omit<StableFileRead, 'bytes'>;

export function stageStableRegularFile(
  root: string,
  source: string,
  destination: string,
  options?: Pick<StableFileReadOptions, 'afterOpen'>,
): Omit<StableFileRead, 'bytes'>;

export function pathsOverlap(left: string, right: string): boolean;
