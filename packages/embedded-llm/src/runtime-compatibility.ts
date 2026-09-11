import { execFileSync } from "node:child_process";

/** Extract the numeric llama.cpp build from its official `--version` output. */
export function parseLlamaCppBuild(output: string): number | null {
  const match =
    output.match(/(?:^|\n)\s*version:\s*(\d+)(?:\s|$)/i) ??
    output.match(/\bbuild(?:\s+number)?\s*[:=]?\s*(\d+)\b/i) ??
    output.match(/\bb(\d{3,})\b/);
  if (!match) return null;
  const build = Number(match[1]);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

/** Unknown or old binaries fail closed for registry-managed artifacts. */
export function isLlamaCppBuildCompatible(
  binaryPath: string,
  minimumBuild: number,
): boolean {
  try {
    const output = execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const build = parseLlamaCppBuild(output);
    return build !== null && build >= minimumBuild;
  } catch {
    return false;
  }
}
