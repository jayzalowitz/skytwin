import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { statfsSync } from "node:fs";
import { Agent, fetch as undiciFetch } from "undici";
import type { ModelEntry } from "@skytwin/embedded-llm";

export type ArtifactTransferErrorCode =
  | "insufficient_disk"
  | "source_unavailable"
  | "source_metadata_mismatch"
  | "unapproved_redirect"
  | "private_source_address"
  | "unexpected_length"
  | "unexpected_content_type"
  | "resume_state_mismatch"
  | "timeout"
  | "cancelled"
  | "network_error";

export class ArtifactTransferError extends Error {
  constructor(
    readonly code: ArtifactTransferErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(message);
  }
}

export interface ResumeValidator {
  etag?: string;
  lastModified?: string;
}
export interface FetchArtifactResult {
  response: Response;
  finalUrl: string;
  validator: ResumeValidator;
  release: () => Promise<void>;
}
export interface ArtifactFetchDependencies {
  request: (
    url: URL,
    init: RequestInit,
    approvedAddresses: readonly string[],
  ) => Promise<{ response: Response; release: () => Promise<void> }>;
  resolve: (hostname: string) => Promise<readonly string[]>;
}

const DEFAULT_DEPS: ArtifactFetchDependencies = {
  request: async (url, init, approvedAddresses) => {
    // Bind the socket lookup to the exact addresses that passed validation.
    // A second system DNS lookup here would reopen a DNS-rebinding window.
    const dispatcher = new Agent({
      connect: {
        lookup: ((_hostname, options, callback) => {
          const records = approvedAddresses.map((address) => ({
            address,
            family: isIP(address) as 4 | 6,
          }));
          if (options.all) callback(null, records);
          else callback(null, records[0]!.address, records[0]!.family);
        }) as NonNullable<ConstructorParameters<typeof Agent>[0]>["connect"] extends infer C
          ? C extends { lookup?: infer L }
            ? L
            : never
          : never,
      },
    });
    try {
      const response = (await undiciFetch(url, {
        ...init,
        dispatcher,
      })) as unknown as Response;
      return {
        response,
        release: async () => {
          await response.body?.cancel().catch(() => undefined);
          await dispatcher.close();
        },
      };
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
  },
  resolve: async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(
      (answer) => answer.address,
    ),
};
const HEADROOM_BYTES = 64 * 1024 * 1024;

export function requiredAvailableBytes(
  exactBytes: number,
  partialBytes = 0,
): number {
  if (
    !Number.isSafeInteger(exactBytes) ||
    exactBytes <= 0 ||
    partialBytes < 0 ||
    partialBytes > exactBytes
  ) {
    throw new ArtifactTransferError(
      "resume_state_mismatch",
      "Invalid artifact or partial byte count",
    );
  }
  // Activation copies the verified partial into an exclusively-created,
  // content-addressed file before switching the manifest. The full copy must
  // fit alongside whatever remains to download.
  return exactBytes - partialBytes + exactBytes + HEADROOM_BYTES;
}

export function assertSufficientDisk(
  directory: string,
  exactBytes: number,
  partialBytes = 0,
  reservedBytes = 0,
): void {
  const stats = statfsSync(directory);
  const available = Math.max(0, stats.bavail * stats.bsize - reservedBytes);
  assertAvailableDisk(available, exactBytes, partialBytes);
}

/** Process-wide reservation ledger; callers serialize check + reserve. */
export class DiskReservationLedger {
  private readonly reservations = new Map<string, number>();

  get totalBytes(): number {
    let total = 0;
    for (const bytes of this.reservations.values()) total += bytes;
    return total;
  }

  reserve(id: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new ArtifactTransferError(
        "resume_state_mismatch",
        "Invalid disk reservation",
      );
    this.reservations.set(id, bytes);
  }

  consume(id: string, bytes: number): void {
    const reserved = this.reservations.get(id);
    if (reserved === undefined) return;
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > reserved)
      throw new ArtifactTransferError(
        "resume_state_mismatch",
        "Invalid disk reservation consumption",
      );
    const remaining = reserved - bytes;
    if (remaining === 0) this.reservations.delete(id);
    else this.reservations.set(id, remaining);
  }

  release(id: string): void {
    this.reservations.delete(id);
  }
}

export function assertAvailableDisk(
  available: number,
  exactBytes: number,
  partialBytes = 0,
): void {
  const required = requiredAvailableBytes(exactBytes, partialBytes);
  if (!Number.isSafeInteger(available) || available < required) {
    throw new ArtifactTransferError(
      "insufficient_disk",
      "Not enough disk space for verified model installation",
      {
        requiredBytes: required,
        availableBytes: Math.max(0, available),
      },
    );
  }
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const dottedMapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dottedMapped) return isPublicAddress(dottedMapped[1]!);
    const hexMapped = normalized.match(
      /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/,
    );
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1]!, 16);
      const low = Number.parseInt(hexMapped[2]!, 16);
      return isPublicAddress(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    // IANA global-unicast space is currently 2000::/3. A positive allowlist
    // avoids accidentally admitting translation, documentation, benchmark,
    // link-local, unique-local, multicast, or future special-purpose ranges.
    return /^[23][0-9a-f]{0,3}:/.test(normalized) &&
      !normalized.startsWith("2001:db8:") &&
      !normalized.startsWith("2001:2:");
  }
  return false;
}

async function approvedAddressesForUrl(
  url: URL,
  model: ModelEntry,
  initial: boolean,
  deps: ArtifactFetchDependencies,
): Promise<readonly string[]> {
  const hostApproved = initial
    ? url.hostname === "huggingface.co" && url.href === model.source.downloadUrl
    : model.source.allowedRedirectHosts.includes(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username ||
    url.password ||
    !hostApproved
  ) {
    throw new ArtifactTransferError(
      "unapproved_redirect",
      "Artifact source redirected outside its approved HTTPS origins",
    );
  }
  let addresses: readonly string[];
  try {
    addresses = await deps.resolve(url.hostname);
  } catch {
    throw new ArtifactTransferError(
      "source_unavailable",
      "Artifact source DNS lookup failed",
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicAddress(address))
  ) {
    throw new ArtifactTransferError(
      "private_source_address",
      "Artifact source resolved to a non-public address",
    );
  }
  return addresses;
}

export async function fetchApprovedArtifact(
  model: ModelEntry,
  resumeFrom: number,
  previousValidator: ResumeValidator | null,
  signal: AbortSignal,
  dependencies: ArtifactFetchDependencies = DEFAULT_DEPS,
): Promise<FetchArtifactResult> {
  const discard = async (
    response: Response,
    release: () => Promise<void>,
  ): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
    await release();
  };
  if (
    resumeFrom > 0 &&
    (!previousValidator ||
      (!previousValidator.etag && !previousValidator.lastModified))
  ) {
    throw new ArtifactTransferError(
      "resume_state_mismatch",
      "Resume requires a persisted HTTP validator",
    );
  }
  let url = new URL(model.source.downloadUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const approvedAddresses = await approvedAddressesForUrl(
      url,
      model,
      redirects === 0,
      dependencies,
    );
    const headers: Record<string, string> = {};
    if (resumeFrom > 0) {
      headers["Range"] = `bytes=${resumeFrom}-`;
      headers["If-Range"] =
        previousValidator!.etag ?? previousValidator!.lastModified!;
    }
    let response: Response;
    let release: () => Promise<void> = async () => {};
    try {
      const requested = await dependencies.request(
        url,
        { headers, redirect: "manual", signal },
        approvedAddresses,
      );
      response = requested.response;
      release = requested.release;
    } catch (error) {
      if (signal.aborted)
        throw new ArtifactTransferError(
          "cancelled",
          "Artifact transfer was cancelled",
        );
      throw new ArtifactTransferError(
        "network_error",
        error instanceof Error ? error.message : "Artifact request failed",
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 0) {
        const linkedSize = Number(response.headers.get("x-linked-size"));
        const linkedDigest = (
          response.headers.get("x-linked-etag") ?? ""
        ).replace(/^"|"$/g, "");
        if (
          response.headers.get("x-repo-commit") !== model.source.revision ||
          linkedSize !== model.exactBytes ||
          linkedDigest !== model.sha256
        ) {
          await discard(response, release);
          throw new ArtifactTransferError(
            "source_metadata_mismatch",
            "Canonical artifact metadata did not match the registry",
          );
        }
      }
      const location = response.headers.get("location");
      if (!location || redirects === 5) {
        await discard(response, release);
        throw new ArtifactTransferError(
          "unapproved_redirect",
          "Artifact redirect chain was invalid",
        );
      }
      await discard(response, release);
      url = new URL(location, url);
      continue;
    }
    if (
      (resumeFrom === 0 && response.status !== 200) ||
      (resumeFrom > 0 && response.status !== 206)
    ) {
      await discard(response, release);
      throw new ArtifactTransferError(
        "source_unavailable",
        `Artifact source returned HTTP ${response.status}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    const expectedLength = model.exactBytes - resumeFrom;
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength !== expectedLength
    ) {
      await release();
      throw new ArtifactTransferError(
        "unexpected_length",
        "Artifact response length did not match registry",
        {
          expectedBytes: expectedLength,
          actualBytes: Number.isFinite(contentLength) ? contentLength : -1,
        },
      );
    }
    if (resumeFrom > 0) {
      const contentRange = response.headers.get("content-range");
      if (
        contentRange !==
        `bytes ${resumeFrom}-${model.exactBytes - 1}/${model.exactBytes}`
      ) {
        await discard(response, release);
        throw new ArtifactTransferError(
          "resume_state_mismatch",
          "Artifact Content-Range did not match local state",
        );
      }
    }
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (
      ![
        "application/octet-stream",
        "binary/octet-stream",
        "application/x-gguf",
      ].includes(contentType)
    ) {
      await discard(response, release);
      throw new ArtifactTransferError(
        "unexpected_content_type",
        "Artifact source returned an unexpected content type",
      );
    }
    const validator = {
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
    if (!validator.etag && !validator.lastModified) {
      await discard(response, release);
      throw new ArtifactTransferError(
        "source_metadata_mismatch",
        "Artifact response did not provide a stable resume validator",
      );
    }
    if (resumeFrom > 0) {
      const expected =
        previousValidator!.etag ?? previousValidator!.lastModified;
      const actual = validator.etag ?? validator.lastModified;
      if (!actual || actual !== expected) {
        await discard(response, release);
        throw new ArtifactTransferError(
          "resume_state_mismatch",
          "Artifact validator changed during resume",
        );
      }
    }
    return { response, finalUrl: url.href, validator, release };
  }
  throw new ArtifactTransferError(
    "unapproved_redirect",
    "Artifact redirect limit exceeded",
  );
}
