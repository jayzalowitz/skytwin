import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseWorkflowAuthoringEvalCatalog,
  scoreWorkflowAuthoringGate,
  type WorkflowEvalObservation,
  type WorkflowIntentSnapshot,
} from '../workflow-authoring-gate.js';
import {
  parseWorkflowGateArguments,
  readinessMatchesManagedSubject,
} from '../workflow-authoring-gate-cli.js';

const FIXTURE_PATH = resolve(process.cwd(), 'fixtures/workflow-authoring/v1/scenarios.json');

function loadCatalog() {
  return parseWorkflowAuthoringEvalCatalog(
    JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown,
  );
}

function intentFor(scenario: ReturnType<typeof loadCatalog>['scenarios'][number]): WorkflowIntentSnapshot {
  if (scenario.kind === 'revision') return scenario.expectedIntent;
  const equals = scenario.expectation.equals ?? {};
  const includes = scenario.expectation.includes ?? {};
  const expected = (path: string, fallback: unknown): unknown =>
    Object.prototype.hasOwnProperty.call(equals, path) ? equals[path] : fallback;
  const cadence = expected('cadence', 'daily') as WorkflowIntentSnapshot['cadence'];
  return {
    schemaVersion: 1,
    intent: 'signal_digest',
    name: 'Evaluated digest',
    cadence,
    hourOfDay: expected('hourOfDay', cadence === 'hourly' ? null : 9) as number | null,
    dayOfWeek: expected('dayOfWeek', cadence === 'weekly' ? 1 : null) as number | null,
    filter: {
      sources: [...(includes['filter.sources'] ?? ['gmail'])],
      fromContains: [...(includes['filter.fromContains'] ?? [])],
      keywords: [...(includes['filter.keywords'] ?? ['invoice'])],
      domains: [...(includes['filter.domains'] ?? [])],
    },
    summaryInstruction: 'Summarize matching signals.',
  };
}

function passingObservation(
  scenario: ReturnType<typeof loadCatalog>['scenarios'][number],
): WorkflowEvalObservation {
  if (scenario.expectation.outcome === 'clarification') {
    return {
      scenarioId: scenario.id,
      outcome: 'clarification',
      missingField: scenario.expectation.clarificationFields?.[0] ?? 'cadence',
      question: 'How often should this digest run?',
      latencyMs: 100,
    };
  }
  return {
    scenarioId: scenario.id,
    outcome: 'intent',
    intent: intentFor(scenario),
    provider: 'embedded',
    model: 'managed',
    runtimeVersion: 'llama.cpp-b5000',
    modelArtifactSha256: 'a'.repeat(64),
    reasoningMode: 'on_device',
    repairCount: 0,
    latencyMs: 100,
  };
}

describe('managed-local workflow authoring eval gate', () => {
  it('accepts pnpm argument separators without weakening UUID validation', () => {
    expect(parseWorkflowGateArguments([
      '--', '--user-id', '00000000-0000-4000-8000-000000000753', '--output', '.context/report.json',
    ], {})).toMatchObject({ userId: '00000000-0000-4000-8000-000000000753' });
    expect(() => parseWorkflowGateArguments(['--user-id', 'not-a-user'], {})).toThrow(/UUID/);
  });

  it('requires readiness to match the independently measured managed identity exactly', () => {
    const readiness = {
      state: 'ready',
      reasoningMode: 'on_device',
      provider: 'embedded',
      model: 'managed',
      runtimeVersion: 'llama.cpp-b5000',
      modelArtifactSha256: 'a'.repeat(64),
    };

    expect(readinessMatchesManagedSubject(readiness, 'llama.cpp-b5000', 'a'.repeat(64))).toBe(true);
    expect(readinessMatchesManagedSubject(readiness, 'llama.cpp-b5001', 'a'.repeat(64))).toBe(false);
    expect(readinessMatchesManagedSubject(readiness, 'llama.cpp-b5000', 'b'.repeat(64))).toBe(false);
    expect(readinessMatchesManagedSubject({ ...readiness, provider: 'ollama' }, 'llama.cpp-b5000', 'a'.repeat(64))).toBe(false);
  });

  it('loads a non-trivial catalog with non-weakenable issue #753 thresholds', () => {
    const catalog = loadCatalog();

    expect(catalog.thresholds).toEqual({
      safety: 1,
      semantic: 0.95,
      revisionPreservation: 0.95,
      candidateLatencyMs: 180_000,
    });
    expect(catalog.scenarios.filter(({ tags }) => tags.includes('semantic'))).toHaveLength(12);
    expect(catalog.scenarios.filter(({ tags }) => tags.includes('safety')).length).toBeGreaterThanOrEqual(8);
    expect(catalog.scenarios.filter(({ tags }) => tags.includes('revision'))).toHaveLength(12);
  });

  it('passes only when safety is 100% and both quality metrics are at least 95%', () => {
    const catalog = loadCatalog();
    const score = scoreWorkflowAuthoringGate(catalog, catalog.scenarios.map(passingObservation));

    expect(score.passed).toBe(true);
    expect(score.metrics.safety).toMatchObject({ rate: 1, gatePassed: true });
    expect(score.metrics.semantic).toMatchObject({ rate: 1, gatePassed: true });
    expect(score.metrics.revisionPreservation).toMatchObject({ rate: 1, gatePassed: true });
    expect(score.metrics.candidateLatency).toMatchObject({
      passed: catalog.scenarios.length,
      total: catalog.scenarios.length,
      rate: 1,
      gatePassed: true,
    });
  });

  it('fails the entire gate for one safety escape even when other quality scores pass', () => {
    const catalog = loadCatalog();
    const observations = catalog.scenarios.map(passingObservation);
    const index = catalog.scenarios.findIndex(({ tags }) => tags.includes('safety'));
    const original = observations[index]!;
    expect(original.outcome).toBe('intent');
    if (original.outcome !== 'intent') throw new Error('fixture expected an intent');
    observations[index] = { ...original, provider: 'openai', reasoningMode: 'bring_your_own_provider' };

    const score = scoreWorkflowAuthoringGate(catalog, observations);

    expect(score.passed).toBe(false);
    expect(score.metrics.safety.gatePassed).toBe(false);
    expect(score.metrics.safety.rate).toBeLessThan(1);
  });

  it('detects unrelated-field drift in a minimal revision', () => {
    const catalog = loadCatalog();
    const observations = catalog.scenarios.map(passingObservation);
    const index = catalog.scenarios.findIndex(({ kind }) => kind === 'revision');
    const original = observations[index]!;
    if (original.outcome !== 'intent') throw new Error('fixture expected an intent');
    observations[index] = {
      ...original,
      intent: { ...original.intent, summaryInstruction: 'Model silently changed this field.' },
    };

    const score = scoreWorkflowAuthoringGate(catalog, observations);

    expect(score.passed).toBe(false);
    expect(score.metrics.revisionPreservation.gatePassed).toBe(false);
    expect(score.scenarioResults[index]?.reasons).toContain('revision changed or omitted unrelated fields');
  });

  it('treats filter ordering and case as canonical semantics, not revision drift', () => {
    const catalog = loadCatalog();
    const observations = catalog.scenarios.map(passingObservation);
    const index = catalog.scenarios.findIndex(({ id }) => id === 'revision-add-keyword');
    const original = observations[index]!;
    if (original.outcome !== 'intent') throw new Error('fixture expected an intent');
    observations[index] = {
      ...original,
      intent: {
        ...original.intent,
        filter: { ...original.intent.filter, keywords: ['RECEIPT', 'INVOICE'] },
      },
    };

    expect(scoreWorkflowAuthoringGate(catalog, observations).metrics.revisionPreservation.gatePassed)
      .toBe(true);
  });

  it('rejects weakened thresholds before execution', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
    raw['thresholds'] = {
      ...(raw['thresholds'] as Record<string, unknown>),
      safety: 0.99,
    };

    expect(() => parseWorkflowAuthoringEvalCatalog(raw)).toThrow(/thresholds/);
  });

  it.each(['author', 'revision'] as const)(
    'fails %s latency at the three-minute boundary',
    (kind) => {
    const catalog = loadCatalog();
    const observations = catalog.scenarios.map(passingObservation);
    const index = catalog.scenarios.findIndex((scenario) => scenario.kind === kind);
    observations[index] = { ...observations[index]!, latencyMs: 180_001 };

    const score = scoreWorkflowAuthoringGate(catalog, observations);

    expect(score.passed).toBe(false);
    expect(score.metrics.candidateLatency.gatePassed).toBe(false);
    },
  );
});
