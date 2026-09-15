#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { clearEmbeddedPortCache } from "@skytwin/llm-client";
import { getLlmClientFromConfigFresh } from "../lib/llm-client-factory.js";

const NONCE = /^[a-f0-9]{64}$/u;
const REMOTE_PROVIDER_ENV = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OLLAMA_BASE_URL",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export interface OnDeviceProbeArguments {
  binaryPath: string;
  modelPath: string;
  nonce: string;
}

export interface OnDeviceProbeResult {
  schemaVersion: 1;
  generatedBy: "packaged-on-device-inference-probe";
  result: "pass";
  provider: "embedded";
  modelName: string;
  reasoningMode: "on_device";
  executionLocation: "on_device";
  networkScope: "none";
  confidentiality: "device_local";
  pricingKind: "zero";
  responseBytes: number;
  responseSha256: string;
  nonceSha256: string;
}

function privateRegularFile(path: string, description: string): string {
  assert(isAbsolute(path), `${description} must be absolute`);
  const stat = lstatSync(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    `${description} must be a private regular non-symlink file`,
  );
  assert(realpathSync(path) === path, `${description} path is not canonical`);
  return path;
}

export function parseOnDeviceProbeArguments(
  argv: readonly string[],
): OnDeviceProbeArguments {
  assert(
    argv.length === 6 &&
      argv[0] === "--binary" &&
      argv[2] === "--model" &&
      argv[4] === "--nonce",
    "arguments must be exactly --binary PATH --model PATH --nonce HEX",
  );
  const binaryPath = privateRegularFile(argv[1]!, "llama.cpp binary");
  const modelPath = privateRegularFile(argv[3]!, "GGUF model");
  const nonce = argv[5]!;
  assert(NONCE.test(nonce), "probe nonce must be 32 random bytes");
  return { binaryPath, modelPath, nonce };
}

export async function runOnDeviceProbe(
  args: OnDeviceProbeArguments,
): Promise<OnDeviceProbeResult> {
  for (const name of REMOTE_PROVIDER_ENV) {
    assert(!process.env[name], `${name} must be absent from the probe process`);
  }

  process.env["SKYTWIN_LLAMACPP_BIN"] = args.binaryPath;
  process.env["SKYTWIN_LLAMA_MODEL"] = args.modelPath;
  process.env["SKYTWIN_REASONING_MODE"] = "on_device";
  process.env["SKYTWIN_DISABLE_EMBEDDED"] = "0";
  clearEmbeddedPortCache();

  const client = getLlmClientFromConfigFresh({
    SKYTWIN_LLAMACPP_BIN: args.binaryPath,
    SKYTWIN_LLAMA_MODEL: args.modelPath,
    SKYTWIN_REASONING_MODE: "on_device",
    SKYTWIN_DISABLE_EMBEDDED: "0",
  });
  assert(client, "packaged API did not admit the embedded provider");

  const response = await client.generate(
    `Return one short word for this local inference availability probe. Probe nonce: ${args.nonce}`,
    {
      invocationKind: "interactive",
      maxTokens: 16,
      temperature: 0,
    },
  );
  const content = Buffer.from(response.content, "utf8");
  const capabilities = response.execution.capabilities;
  assert(
    content.length > 0 && content.length <= 64 * 1024,
    "embedded inference returned an empty or oversized response",
  );
  assert(
    response.provider === "embedded",
    "inference used a non-embedded provider",
  );
  assert(
    response.model === args.modelPath,
    "inference used a different model path",
  );
  assert(
    response.execution.reasoningMode === "on_device" &&
      capabilities.executionLocation === "on_device" &&
      capabilities.networkScope === "none" &&
      capabilities.confidentiality === "device_local" &&
      capabilities.pricing.kind === "zero",
    "embedded execution facts did not retain the on-device boundary",
  );

  return {
    schemaVersion: 1,
    generatedBy: "packaged-on-device-inference-probe",
    result: "pass",
    provider: "embedded",
    modelName: basename(args.modelPath),
    reasoningMode: "on_device",
    executionLocation: "on_device",
    networkScope: "none",
    confidentiality: "device_local",
    pricingKind: "zero",
    responseBytes: content.length,
    responseSha256: createHash("sha256").update(content).digest("hex"),
    nonceSha256: createHash("sha256").update(args.nonce).digest("hex"),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const result = await runOnDeviceProbe(parseOnDeviceProbeArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
