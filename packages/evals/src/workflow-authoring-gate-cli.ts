#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseWorkflowAuthoringEvalCatalog,
  scoreWorkflowAuthoringGate,
  type WorkflowAuthoringEvalCatalog,
  type WorkflowEvalObservation,
  type WorkflowIntentSnapshot,
} from './workflow-authoring-gate.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CATALOG_PATH = join(REPO_ROOT, 'packages/evals/fixtures/workflow-authoring/v1/scenarios.json');
const DEFAULT_OUTPUT = join(REPO_ROOT, 'artifacts/workflow-authoring-managed-local-eval.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface WorkflowAuthoringServicePort {
  probeReadiness(userId: string): Promise<unknown>;
  authorSignalDigest(userId: string, description: string, options?: { timeoutMs?: number }): Promise<unknown>;
  reviseSignalDigest(userId: string, base: unknown, feedback: string, options?: { timeoutMs?: number }): Promise<unknown>;
}

interface WorkflowAuthoringModule {
  createWorkflowAuthoringCandidateEvaluationService(): WorkflowAuthoringServicePort;
}

interface EmbeddedLlmModule {
  detectEmbeddedRuntimes(): Promise<{
    llamaCpp: { available: boolean; binaryPath: string | null };
  }>;
  inspectManagedActiveModelAsync(modelDir: string): Promise<
    | { state: 'missing' }
    | { state: 'invalid'; reason: string }
    | {
        state: 'verified';
        manifest: {
          modelId: string;
          registryVersion: number;
          revision: string;
          filename: string;
          exactBytes: number;
          sha256: string;
          verifiedAt: string;
        };
        model: { runtime: { minimumBuild: number } };
      }
  >;
  parseLlamaCppBuild(output: string): number | null;
}

interface CliArguments {
  userId: string;
  outputPath: string;
}

interface PrerequisiteFailure {
  schemaVersion: 1;
  generatedBy: 'managed-local-workflow-authoring-gate';
  status: 'not_run';
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readinessMatchesManagedSubject(
  readiness: unknown,
  expectedRuntimeVersion: string,
  expectedArtifactSha256: string,
): boolean {
  return isRecord(readiness)
    && readiness['state'] === 'ready'
    && readiness['reasoningMode'] === 'on_device'
    && readiness['provider'] === 'embedded'
    && readiness['model'] === 'managed'
    && readiness['runtimeVersion'] === expectedRuntimeVersion
    && readiness['modelArtifactSha256'] === expectedArtifactSha256;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputPath(raw: string | undefined): string {
  if (!raw) return DEFAULT_OUTPUT;
  return isAbsolute(raw) ? raw : join(REPO_ROOT, raw);
}

export function parseWorkflowGateArguments(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliArguments {
  let userId = env['SKYTWIN_EVAL_USER_ID'] ?? '';
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === '--') continue;
    if ((flag === '--user-id' || flag === '--output') && value && !value.startsWith('--')) {
      if (flag === '--user-id') userId = value;
      else output = outputPath(value);
      index += 1;
      continue;
    }
    throw new Error('usage: eval:workflow-authoring:managed --user-id UUID [--output PATH]');
  }
  if (!UUID.test(userId)) {
    throw new Error('a UUID --user-id (or SKYTWIN_EVAL_USER_ID) with an embedded managed provider is required');
  }
  return { userId, outputPath: output };
}

function catalogFromDisk(): { catalog: WorkflowAuthoringEvalCatalog; sha256: string } {
  const bytes = readFileSync(CATALOG_PATH);
  return {
    catalog: parseWorkflowAuthoringEvalCatalog(JSON.parse(bytes.toString('utf8')) as unknown),
    sha256: sha256(bytes),
  };
}

function sourceIdentity(): { commit: string; ref: string; cleanTree: boolean } {
  const run = (args: string[]): string => {
    const result = spawnSync('/usr/bin/git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout.trim();
  };
  const commit = run(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('git did not return a full commit');
  const refResult = spawnSync('/usr/bin/git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (refResult.error || (refResult.status !== 0 && refResult.status !== 1)) {
    throw new Error('git symbolic-ref failed');
  }
  return {
    commit,
    ref: refResult.status === 0 ? refResult.stdout.trim() : 'DETACHED',
    cleanTree: run(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']) === '',
  };
}

function intentFromResult(value: Record<string, unknown>): WorkflowIntentSnapshot | null {
  const intent = value['intent'];
  if (!isRecord(intent) || intent['schemaVersion'] !== 1 || intent['intent'] !== 'signal_digest'
      || typeof intent['name'] !== 'string' || typeof intent['summaryInstruction'] !== 'string'
      || !isRecord(intent['filter'])) return null;
  return intent as unknown as WorkflowIntentSnapshot;
}

function observationFromResult(
  scenarioId: string,
  raw: unknown,
  latencyMs: number,
  expectedRuntimeVersion: string,
  expectedArtifactSha256: string,
): WorkflowEvalObservation {
  if (!isRecord(raw)) {
    return { scenarioId, outcome: 'failure', state: 'invalid_result', reason: 'authoring returned a non-object', latencyMs };
  }
  if (raw['success'] === true) {
    const intent = intentFromResult(raw);
    const inference = raw['inference'];
    if (!intent || !isRecord(inference)) {
      return { scenarioId, outcome: 'failure', state: 'invalid_result', reason: 'success lacked intent or inference', latencyMs };
    }
    if (inference['runtimeVersion'] !== expectedRuntimeVersion
        || inference['modelArtifactSha256'] !== expectedArtifactSha256) {
      return {
        scenarioId,
        outcome: 'failure',
        state: 'managed_identity_mismatch',
        reason: 'inference runtime/artifact identity did not match the independently measured subject',
        latencyMs,
      };
    }
    return {
      scenarioId,
      outcome: 'intent',
      intent,
      provider: String(inference['provider'] ?? ''),
      model: String(inference['model'] ?? ''),
      runtimeVersion: String(inference['runtimeVersion']),
      modelArtifactSha256: String(inference['modelArtifactSha256']),
      reasoningMode: String(inference['reasoningMode'] ?? ''),
      repairCount: Number(inference['repairCount'] ?? -1),
      latencyMs,
    };
  }
  if (raw['state'] === 'clarification_required') {
    return {
      scenarioId,
      outcome: 'clarification',
      missingField: String(raw['missingField'] ?? ''),
      question: String(raw['question'] ?? ''),
      latencyMs,
    };
  }
  return {
    scenarioId,
    outcome: 'failure',
    state: String(raw['state'] ?? 'unknown_failure'),
    reason: String(raw['reason'] ?? 'workflow authoring failed'),
    latencyMs,
  };
}

function revisionPayload(intent: WorkflowIntentSnapshot): Record<string, unknown> {
  return {
    name: intent.name,
    cadence: intent.cadence,
    action: 'digest',
    filter: intent.filter,
    summaryInstruction: intent.summaryInstruction,
    ...(intent.hourOfDay === null ? {} : { hourOfDay: intent.hourOfDay }),
    ...(intent.dayOfWeek === null ? {} : { dayOfWeek: intent.dayOfWeek }),
  };
}

async function loadSourceModule<T>(relativePath: string): Promise<T> {
  return await import(pathToFileURL(join(REPO_ROOT, relativePath)).href) as T;
}

function writeReport(path: string, report: unknown): void {
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { encoding: 'utf8', flag: 'w' });
  writeFileSync(`${path}.sha256`, `${sha256(bytes)}  ${basename(path)}\n`, { encoding: 'utf8', flag: 'w' });
}

function notRun(output: string, reason: string): number {
  const report: PrerequisiteFailure = {
    schemaVersion: 1,
    generatedBy: 'managed-local-workflow-authoring-gate',
    status: 'not_run',
    reason,
  };
  writeReport(output, report);
  process.stderr.write(`managed-local workflow eval not run: ${reason}\nreport: ${output}\n`);
  return 2;
}

export async function runManagedLocalWorkflowGate(args = process.argv.slice(2)): Promise<number> {
  const parsed = parseWorkflowGateArguments(args);
  const { catalog, sha256: catalogSha256 } = catalogFromDisk();
  const embedded = await loadSourceModule<EmbeddedLlmModule>('packages/embedded-llm/src/index.ts');
  const modelDir = process.env['SKYTWIN_LLAMA_MODELS'] ?? join(homedir(), '.skytwin', 'models', 'llama');
  const artifact = await embedded.inspectManagedActiveModelAsync(modelDir);
  if (artifact.state !== 'verified') {
    return notRun(parsed.outputPath, artifact.state === 'invalid'
      ? `managed artifact invalid: ${artifact.reason}`
      : 'managed artifact is not installed');
  }
  const runtimes = await embedded.detectEmbeddedRuntimes();
  const binaryPath = runtimes.llamaCpp.binaryPath;
  if (!runtimes.llamaCpp.available || binaryPath === null) {
    return notRun(parsed.outputPath, 'llama.cpp runtime is not installed or configured');
  }
  const version = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  });
  if (version.error || version.status !== 0 || version.signal !== null) {
    return notRun(parsed.outputPath, 'llama.cpp runtime version could not be measured');
  }
  const versionText = `${version.stdout}\n${version.stderr}`.trim();
  const runtimeBuild = embedded.parseLlamaCppBuild(versionText);
  if (runtimeBuild === null || runtimeBuild < artifact.model.runtime.minimumBuild) {
    return notRun(parsed.outputPath, 'llama.cpp runtime is unversioned or incompatible with the managed artifact');
  }

  const authoringModule = await loadSourceModule<WorkflowAuthoringModule>('apps/api/src/lib/workflow-authoring.ts');
  const service = authoringModule.createWorkflowAuthoringCandidateEvaluationService();
  const readiness = await service.probeReadiness(parsed.userId);
  if (!isRecord(readiness) || readiness['state'] !== 'ready') {
    return notRun(parsed.outputPath, isRecord(readiness)
      ? `workflow readiness is ${String(readiness['state'])}: ${String(readiness['reason'] ?? '')}`
      : 'workflow readiness returned an invalid result');
  }
  const expectedRuntimeVersion = `llama.cpp-b${runtimeBuild}`;
  if (!readinessMatchesManagedSubject(readiness, expectedRuntimeVersion, artifact.manifest.sha256)) {
    return notRun(
      parsed.outputPath,
      'workflow readiness must be embedded/managed/on_device and match the independently measured runtime/artifact identity',
    );
  }

  const observations: WorkflowEvalObservation[] = [];
  for (const scenario of catalog.scenarios) {
    const startedAt = performance.now();
    const result = scenario.kind === 'author'
      ? await service.authorSignalDigest(parsed.userId, scenario.prompt, { timeoutMs: 60_000 })
      : await service.reviseSignalDigest(
          parsed.userId,
          revisionPayload(scenario.base),
          scenario.feedback,
          { timeoutMs: 60_000 },
        );
    observations.push(observationFromResult(
      scenario.id,
      result,
      Math.round(performance.now() - startedAt),
      expectedRuntimeVersion,
      artifact.manifest.sha256,
    ));
  }

  const score = scoreWorkflowAuthoringGate(catalog, observations);
  const latencyValues = observations.map(({ latencyMs }) => latencyMs).sort((left, right) => left - right);
  const percentile = (ratio: number): number => latencyValues[Math.max(0, Math.ceil(latencyValues.length * ratio) - 1)] ?? 0;
  const report = {
    schemaVersion: 1,
    generatedBy: 'managed-local-workflow-authoring-gate',
    status: score.passed ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    source: sourceIdentity(),
    catalog: { path: 'packages/evals/fixtures/workflow-authoring/v1/scenarios.json', sha256: catalogSha256 },
    subject: {
      userIdSha256: sha256(parsed.userId),
      provider: readiness['provider'],
      configuredModel: readiness['model'],
      reasoningMode: readiness['reasoningMode'],
      readinessRuntimeVersion: readiness['runtimeVersion'],
      readinessModelArtifactSha256: readiness['modelArtifactSha256'],
      managedArtifact: {
        modelId: artifact.manifest.modelId,
        registryVersion: artifact.manifest.registryVersion,
        revision: artifact.manifest.revision,
        filename: artifact.manifest.filename,
        exactBytes: artifact.manifest.exactBytes,
        sha256: artifact.manifest.sha256,
        verifiedAt: artifact.manifest.verifiedAt,
      },
      runtime: {
        name: 'llama.cpp',
        build: runtimeBuild,
        versionOutputSha256: sha256(versionText),
      },
    },
    score,
    latency: {
      unit: 'milliseconds',
      minimum: latencyValues[0] ?? 0,
      p50: percentile(0.5),
      p95: percentile(0.95),
      maximum: latencyValues.at(-1) ?? 0,
      candidateThreshold: catalog.thresholds.candidateLatencyMs,
      activationJourneyMeasured: false,
      activationJourneyReason: 'This model-quality gate does not mutate CockroachDB or activate workflows.',
    },
    observations,
  };
  writeReport(parsed.outputPath, report);
  process.stdout.write(
    `managed-local workflow eval: ${score.passed ? 'PASS' : 'FAIL'}\n`
    + `safety: ${score.metrics.safety.passed}/${score.metrics.safety.total}\n`
    + `semantic: ${score.metrics.semantic.passed}/${score.metrics.semantic.total}\n`
    + `revision preservation: ${score.metrics.revisionPreservation.passed}/${score.metrics.revisionPreservation.total}\n`
    + `candidate latency: ${score.metrics.candidateLatency.passed}/${score.metrics.candidateLatency.total}\n`
    + `report: ${parsed.outputPath}\n`,
  );
  return score.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runManagedLocalWorkflowGate().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`managed-local workflow eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
