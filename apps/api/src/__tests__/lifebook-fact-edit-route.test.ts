/**
 * Tests for PATCH /api/lifebooks/:userId/:domainName/facts/:index —
 * issue #319 inline fact-edit recorder.
 *
 * Coverage:
 *   1. Happy path — edits the fact, records a user-corrected provenance
 *      node, returns { lifebook, correction } with before/after.
 *   2. 404 when the lifebook doesn't exist (findByDomain null).
 *   3. 404 when the index is out of range (editSampleSignal null but
 *      lifebook exists).
 *   4. 400 on non-integer / negative index.
 *   5. 400 on blank text.
 *   6. Provenance write failure is non-fatal — the edit still succeeds,
 *      correction.provenanceNodeId is null (fail-soft audit trail).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import type { Express } from 'express';

const {
  mockFindByDomain,
  mockEditSampleSignal,
  mockWriteNode,
} = vi.hoisted(() => ({
  mockFindByDomain: vi.fn(),
  mockEditSampleSignal: vi.fn(),
  mockWriteNode: vi.fn(),
}));

vi.mock('@skytwin/db', () => ({
  lifebookRepository: {
    listVisible: vi.fn(),
    listAll: vi.fn(),
    findByDomain: mockFindByDomain,
    hide: vi.fn(),
    unhide: vi.fn(),
    setImportanceOverride: vi.fn(),
    clearImportanceOverride: vi.fn(),
    editSampleSignal: mockEditSampleSignal,
  },
  mempalaceRepository: {
    getRooms: vi.fn(),
    getDrawers: vi.fn(),
  },
  aiProviderRepository: {
    getEnabledForUser: vi.fn(),
  },
  provenanceRepository: {
    writeNode: mockWriteNode,
  },
}));

vi.mock('@skytwin/policy-prompts', () => ({
  runPrompt: vi.fn(),
}));

vi.mock('@skytwin/llm-client', async () => {
  const actual = await vi.importActual<typeof import('@skytwin/llm-client')>(
    '@skytwin/llm-client',
  );
  return {
    ...actual,
    LlmClient: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('../middleware/require-ownership.js', () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

import { createLifebooksRouter } from '../routes/lifebooks.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/lifebooks', createLifebooksRouter());
  return app;
}

async function request(
  app: Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function fakeLifebook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lb-1',
    user_id: USER_ID,
    domain_name: 'Health',
    importance: 'core' as const,
    sample_signals: ['Appointment on 2026-06-01', 'Refill prescription'],
    suggested_capabilities: ['google-calendar-mcp'],
    wing_id: 'wing-1',
    detected_at: new Date(),
    last_seen_at: new Date(),
    hidden_at: null,
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /api/lifebooks/:userId/:domainName/facts/:index — #319', () => {
  it('edits the fact and records a user-corrected provenance node', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockEditSampleSignal.mockResolvedValue(
      fakeLifebook({ sample_signals: ['Appointment on 2026-06-08', 'Refill prescription'] }),
    );
    mockWriteNode.mockResolvedValue({ id: 'node-1' });

    const res = await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/Health/facts/0`,
      { text: 'Appointment on 2026-06-08' },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      lifebook: { sampleSignals: string[] };
      correction: {
        factIndex: number;
        previousText: string;
        correctedText: string;
        provenanceNodeId: string | null;
      };
    };
    expect(body.lifebook.sampleSignals[0]).toBe('Appointment on 2026-06-08');
    expect(body.correction.factIndex).toBe(0);
    expect(body.correction.previousText).toBe('Appointment on 2026-06-01');
    expect(body.correction.correctedText).toBe('Appointment on 2026-06-08');
    expect(body.correction.provenanceNodeId).toBe('node-1');

    // Provenance is recorded as explicitly user-corrected — never inferred.
    expect(mockWriteNode).toHaveBeenCalledTimes(1);
    const nodeArg = mockWriteNode.mock.calls[0]![0];
    expect(nodeArg.nodeType).toBe('feedback');
    expect(nodeArg.refTable).toBe('lifebooks');
    expect(nodeArg.refId).toBe('lb-1');
    expect(nodeArg.wingId).toBe('wing-1');
    expect(nodeArg.payload.kind).toBe('fact_correction');
    expect(nodeArg.payload.userCorrected).toBe(true);
    expect(nodeArg.payload.factIndex).toBe(0);
    expect(nodeArg.payload.previousText).toBe('Appointment on 2026-06-01');
    expect(nodeArg.payload.correctedText).toBe('Appointment on 2026-06-08');
  });

  it('returns 404 when the lifebook does not exist (no edit attempted)', async () => {
    mockFindByDomain.mockResolvedValue(null);
    const res = await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/NoSuchDomain/facts/0`,
      { text: 'whatever' },
    );
    expect(res.status).toBe(404);
    expect(mockEditSampleSignal).not.toHaveBeenCalled();
    expect(mockWriteNode).not.toHaveBeenCalled();
  });

  it('returns 404 when the index is out of range (lifebook exists, edit returns null)', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockEditSampleSignal.mockResolvedValue(null);
    const res = await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/Health/facts/99`,
      { text: 'whatever' },
    );
    expect(res.status).toBe(404);
    const body = res.body as { error: string };
    expect(body.error).toContain('index 99');
    expect(mockWriteNode).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-integer index', async () => {
    const res = await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/Health/facts/3abc`,
      { text: 'whatever' },
    );
    expect(res.status).toBe(400);
    expect(mockFindByDomain).not.toHaveBeenCalled();
    expect(mockEditSampleSignal).not.toHaveBeenCalled();
  });

  it('returns 400 on blank text', async () => {
    const res = await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/Health/facts/0`,
      { text: '   ' },
    );
    expect(res.status).toBe(400);
    expect(mockEditSampleSignal).not.toHaveBeenCalled();
  });

  it('edit still succeeds when provenance write fails (fail-soft audit trail)', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockEditSampleSignal.mockResolvedValue(
      fakeLifebook({ sample_signals: ['Corrected', 'Refill prescription'] }),
    );
    mockWriteNode.mockRejectedValue(new Error('provenance table locked'));

    const res = await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/Health/facts/0`,
      { text: 'Corrected' },
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      lifebook: { sampleSignals: string[] };
      correction: { provenanceNodeId: string | null };
    };
    expect(body.lifebook.sampleSignals[0]).toBe('Corrected');
    // The fact edit stands; the audit node id is null because the write failed.
    expect(body.correction.provenanceNodeId).toBeNull();
  });

  it('trims and caps the corrected text before persisting', async () => {
    mockFindByDomain.mockResolvedValue(fakeLifebook());
    mockEditSampleSignal.mockResolvedValue(fakeLifebook());
    mockWriteNode.mockResolvedValue({ id: 'node-2' });

    const longText = `  ${'x'.repeat(5000)}  `;
    await request(
      buildApp(),
      'PATCH',
      `/api/lifebooks/${USER_ID}/Health/facts/1`,
      { text: longText },
    );

    const editArgs = mockEditSampleSignal.mock.calls[0]!;
    // userId, domainName, index, correctedText
    expect(editArgs[2]).toBe(1);
    expect(editArgs[3]).toHaveLength(2000); // trimmed then capped at 2000
    expect(editArgs[3].startsWith('x')).toBe(true);
  });
});
