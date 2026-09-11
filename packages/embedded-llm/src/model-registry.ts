/** Curated local text-model registry. Entries are an integrity boundary. */
export type RamBracket = "4gb" | "8gb" | "16gb" | "32gb-plus";

export interface ModelArtifactSource {
  repository: string;
  revision: string;
  filename: string;
  downloadUrl: string;
  metadataUrl: string;
  allowedRedirectHosts: readonly string[];
}
export interface ModelLicense {
  spdxId: string;
  name: string;
  url: string;
}
export interface ModelRuntimeCompatibility {
  runtime: "llama.cpp";
  format: "GGUFv3";
  architecture: "qwen2";
  minimumBuild: number;
  minimumBuildCommit: string;
  sourceUrl: string;
  modelUsageUrl: string;
}
export interface ModelEntry {
  id: string;
  displayName: string;
  ramBracket: RamBracket;
  /** Exact size, retained under the old key for API compatibility. */
  approxBytes: number;
  exactBytes: number;
  contextWindow: number;
  recommendationPriority: number;
  /** @deprecated Compatibility sentinel. Zero means no maintained benchmark claim. */
  qualityScore: number;
  quantization: "Q4_K_M";
  minimumRamBytes: number;
  supportedArchitectures: readonly ("arm64" | "x64")[];
  source: ModelArtifactSource;
  downloadUrl: string;
  sha256: string;
  license: ModelLicense;
  runtime: ModelRuntimeCompatibility;
  version: number;
}
export interface RegistryValidationError {
  index: number;
  field: string;
  message: string;
}
export interface RegistryValidationResult {
  valid: boolean;
  errors: RegistryValidationError[];
}

const IMMUTABLE_REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9.-]*$/;

export function validateModelRegistry(
  entries: readonly ModelEntry[],
): RegistryValidationResult {
  const errors: RegistryValidationError[] = [];
  const ids = new Set<string>();
  const artifacts = new Set<string>();
  const fail = (index: number, field: string, message: string): void => {
    errors.push({ index, field, message });
  };
  entries.forEach((entry, index) => {
    if (!SAFE_ID.test(entry.id))
      fail(index, "id", "must be a stable lowercase identifier");
    if (ids.has(entry.id)) fail(index, "id", "duplicate id");
    ids.add(entry.id);
    if (!Number.isSafeInteger(entry.exactBytes) || entry.exactBytes <= 0)
      fail(index, "exactBytes", "must be a positive safe integer");
    if (entry.approxBytes !== entry.exactBytes)
      fail(index, "approxBytes", "must equal exactBytes");
    if (!Number.isSafeInteger(entry.contextWindow) || entry.contextWindow <= 0)
      fail(index, "contextWindow", "must be positive");
    if (
      !Number.isSafeInteger(entry.recommendationPriority) ||
      entry.recommendationPriority < 0
    )
      fail(index, "recommendationPriority", "must be a non-negative integer");
    if (entry.qualityScore !== 0)
      fail(
        index,
        "qualityScore",
        "must remain the zero compatibility sentinel until benchmark evidence exists",
      );
    if (!SHA256.test(entry.sha256) || /^0+$/.test(entry.sha256))
      fail(index, "sha256", "must be a non-placeholder lowercase SHA-256");
    if (!IMMUTABLE_REVISION.test(entry.source.revision))
      fail(index, "source.revision", "must be an immutable commit");
    if (
      entry.source.filename !== entry.source.filename.split("/").pop() ||
      !entry.source.filename.toLowerCase().endsWith(".gguf")
    )
      fail(index, "source.filename", "must be a .gguf basename");
    const artifactKey = `${entry.source.repository}@${entry.source.revision}/${entry.source.filename}`;
    if (artifacts.has(artifactKey)) fail(index, "source", "duplicate artifact");
    artifacts.add(artifactKey);
    let download: URL | null = null;
    try {
      download = new URL(entry.source.downloadUrl);
    } catch {
      /* checked below */
    }
    const expectedPath = `/${entry.source.repository}/resolve/${entry.source.revision}/${entry.source.filename}`;
    if (
      download?.protocol !== "https:" ||
      download.port !== "" ||
      download.hostname !== "huggingface.co" ||
      download.pathname !== expectedPath ||
      download.search !== ""
    )
      fail(
        index,
        "source.downloadUrl",
        "must be the canonical pinned Hugging Face HTTPS URL on the default port",
      );
    if (entry.downloadUrl !== entry.source.downloadUrl)
      fail(index, "downloadUrl", "must mirror source.downloadUrl");
    if (
      /(?:^|\/)(?:main|master|latest)(?:\/|$)/i.test(entry.source.downloadUrl)
    )
      fail(index, "source.downloadUrl", "mutable branch names are forbidden");
    if (
      !entry.source.metadataUrl.startsWith(
        "https://huggingface.co/api/models/",
      ) ||
      !entry.source.metadataUrl.includes(`/revision/${entry.source.revision}`)
    )
      fail(
        index,
        "source.metadataUrl",
        "must cite the pinned official model API revision",
      );
    if (
      entry.source.allowedRedirectHosts.length === 0 ||
      entry.source.allowedRedirectHosts.some(
        (host) => host.startsWith("*") || host.includes("/"),
      )
    )
      fail(index, "source.allowedRedirectHosts", "must use explicit DNS hosts");
    if (!entry.license.spdxId || !entry.license.name)
      fail(index, "license", "SPDX id and name are required");
    if (
      !IMMUTABLE_REVISION.test(entry.source.revision) ||
      !entry.license.url.includes(`/blob/${entry.source.revision}/LICENSE`)
    )
      fail(
        index,
        "license.url",
        "must pin license to immutable artifact revision",
      );
    if (
      !Number.isInteger(entry.runtime.minimumBuild) ||
      entry.runtime.minimumBuild <= 0 ||
      !IMMUTABLE_REVISION.test(entry.runtime.minimumBuildCommit) ||
      !entry.runtime.sourceUrl.endsWith(
        `/commit/${entry.runtime.minimumBuildCommit}`,
      ) ||
      !entry.runtime.modelUsageUrl.includes(
        `/blob/${entry.source.revision}/README.md`,
      )
    )
      fail(
        index,
        "runtime",
        "must identify immutable runtime and model usage evidence",
      );
    if (
      entry.minimumRamBytes < entry.exactBytes ||
      entry.supportedArchitectures.length === 0
    )
      fail(index, "hardware", "RAM and architecture guidance required");
  });
  if (entries.length === 0)
    fail(-1, "registry", "must contain at least one artifact");
  return { valid: errors.length === 0, errors };
}

const source: ModelArtifactSource = Object.freeze({
  repository: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
  revision: "91cad51170dc346986eccefdc2dd33a9da36ead9",
  filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  downloadUrl:
    "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  metadataUrl:
    "https://huggingface.co/api/models/Qwen/Qwen2.5-1.5B-Instruct-GGUF/revision/91cad51170dc346986eccefdc2dd33a9da36ead9?blobs=true",
  // Pinned objects are currently served from regional hf.co LFS/Xet hosts.
  allowedRedirectHosts: Object.freeze(["us.aws.cdn.hf.co"]),
});

export const MODEL_REGISTRY: readonly ModelEntry[] = Object.freeze([
  Object.freeze({
    id: "qwen2.5-1.5b-instruct-q4-k-m",
    displayName: "Qwen2.5 1.5B Instruct (Q4_K_M)",
    ramBracket: "4gb",
    approxBytes: 1_117_320_736,
    exactBytes: 1_117_320_736,
    contextWindow: 32_768,
    recommendationPriority: 1,
    qualityScore: 0,
    quantization: "Q4_K_M",
    minimumRamBytes: 4 * 1024 ** 3,
    supportedArchitectures: Object.freeze(["arm64", "x64"] as const),
    source,
    downloadUrl: source.downloadUrl,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    license: Object.freeze({
      spdxId: "Apache-2.0",
      name: "Apache License 2.0",
      url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE",
    }),
    runtime: Object.freeze({
      runtime: "llama.cpp",
      format: "GGUFv3",
      architecture: "qwen2",
      minimumBuild: 4000,
      minimumBuildCommit: "c02e5ab2a675c8bc1abc8b1e4cb6a93b26bdcce7",
      sourceUrl:
        "https://github.com/ggml-org/llama.cpp/commit/c02e5ab2a675c8bc1abc8b1e4cb6a93b26bdcce7",
      modelUsageUrl:
        "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/91cad51170dc346986eccefdc2dd33a9da36ead9/README.md#quickstart",
    }),
    version: 1,
  }),
]);

const check = validateModelRegistry(MODEL_REGISTRY);
if (!check.valid)
  throw new Error(
    `Invalid embedded model registry: ${JSON.stringify(check.errors)}`,
  );

export function findById(id: string): ModelEntry | null {
  return MODEL_REGISTRY.find((model) => model.id === id) ?? null;
}
export function listByBracket(bracket: RamBracket): ModelEntry[] {
  return MODEL_REGISTRY.filter((model) => model.ramBracket === bracket).slice();
}
export interface UpgradeRecommendation {
  currentId: string;
  recommended: ModelEntry;
  /** @deprecated Compatibility sentinel. Zero means no benchmark delta is claimed. */
  qualityDeltaPct: number;
  rationale: string;
}
export function checkForUpgrade(
  currentModelId: string,
  registry: readonly ModelEntry[] = MODEL_REGISTRY,
): UpgradeRecommendation | null {
  const current = registry.find((model) => model.id === currentModelId);
  if (!current) return null;
  const candidates = registry.filter(
    (model) =>
      model.ramBracket === current.ramBracket &&
      model.recommendationPriority > current.recommendationPriority,
  );
  if (candidates.length === 0) return null;
  const best = candidates.reduce((left, right) =>
    left.recommendationPriority > right.recommendationPriority ? left : right,
  );
  return {
    currentId: currentModelId,
    recommended: best,
    qualityDeltaPct: 0,
    rationale: `${best.displayName} is the maintained artifact for the same RAM bracket (${current.ramBracket}), ${(best.exactBytes / 1024 ** 3).toFixed(1)}GB download. No benchmark improvement is claimed.`,
  };
}
export function recommendDefault(bracket: RamBracket): ModelEntry {
  const candidates = listByBracket(bracket);
  if (candidates.length === 0) return MODEL_REGISTRY[0]!;
  return candidates.reduce((left, right) =>
    left.recommendationPriority > right.recommendationPriority ? left : right,
  );
}
