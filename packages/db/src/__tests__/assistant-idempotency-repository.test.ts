import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const PROCESSING_TOKEN = '55555555-5555-4555-8555-555555555555';
vi.mock('node:crypto', () => ({ randomUUID: () => PROCESSING_TOKEN }));
vi.mock('../connection.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: { query: typeof mockClientQuery }) => unknown) =>
    fn({ query: mockClientQuery }),
}));

const { assistantRepository } = await import('../repositories/assistant-repository.js');

const ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  thread_id: '22222222-2222-2222-2222-222222222222',
  role: 'user',
  content: 'archive that email',
  created_at: new Date(),
  metadata: null,
  client_request_id: '33333333-3333-3333-3333-333333333333',
};

describe('assistantRepository idempotent user append', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses a user-scoped unique request key and returns a replayed row', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [ROW] });

    const result = await assistantRepository.appendOrGetUserMessage(
      '44444444-4444-4444-4444-444444444444',
      ROW.thread_id,
      ROW.content,
      ROW.client_request_id,
    );

    expect(result).toMatchObject({ created: false, message: { id: ROW.id } });
    expect(mockClientQuery.mock.calls[0]![0]).toContain(
      'ON CONFLICT (user_id, client_request_id, role)',
    );
    expect(mockClientQuery.mock.calls[0]![0]).toContain('WHERE id = $1 AND user_id = $3');
    expect(mockClientQuery.mock.calls[1]![0]).toContain('user_id = $1');
  });

  it('atomically creates a new thread and first keyed message', async () => {
    const threadRow = {
      id: ROW.thread_id,
      user_id: '44444444-4444-4444-4444-444444444444',
      title: ROW.content,
      created_at: new Date(),
      updated_at: new Date(),
    };
    mockClientQuery.mockResolvedValueOnce({ rows: [threadRow] }).mockResolvedValueOnce({
      rows: [{ ...ROW, request_processing_token: PROCESSING_TOKEN }],
    });

    const result = await assistantRepository.createThreadWithUserMessage(
      threadRow.user_id,
      ROW.content,
      ROW.client_request_id,
    );

    expect(result.created).toBe(true);
    expect(result.thread.id).toBe(ROW.thread_id);
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls[1]![0]).toContain('request_processing_token');
  });

  it('recovers ownership when atomic new-thread commit response is lost', async () => {
    const threadRow = {
      id: ROW.thread_id,
      user_id: '44444444-4444-4444-4444-444444444444',
      title: ROW.content,
      created_at: new Date(),
      updated_at: new Date(),
    };
    mockClientQuery.mockRejectedValueOnce(new Error('SECRET_MARKER response lost'));
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ ...ROW, request_processing_token: PROCESSING_TOKEN }],
      })
      .mockResolvedValueOnce({ rows: [threadRow] })
      .mockResolvedValueOnce({ rows: [ROW] });

    const result = await assistantRepository.createThreadWithUserMessage(
      threadRow.user_id,
      ROW.content,
      ROW.client_request_id,
    );

    expect(result.created).toBe(true);
    expect(result.message.id).toBe(ROW.id);
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('reconciles a lost commit response by reading the durable row', async () => {
    mockClientQuery.mockRejectedValueOnce(new Error('SECRET_MARKER connection lost'));
    mockQuery.mockResolvedValueOnce({ rows: [ROW] });

    const result = await assistantRepository.appendOrGetUserMessage(
      '44444444-4444-4444-4444-444444444444',
      ROW.thread_id,
      ROW.content,
      ROW.client_request_id,
    );

    expect(result).toMatchObject({ created: false, message: { id: ROW.id } });
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('reconciles an assistant response by the same user-scoped request key', async () => {
    const assistantRow = {
      ...ROW,
      role: 'assistant',
      content: 'Approval required.',
    };
    mockClientQuery.mockRejectedValueOnce(new Error('SECRET_MARKER response lost'));
    mockQuery.mockResolvedValueOnce({ rows: [assistantRow] });

    const result = await assistantRepository.appendOrGetAssistantMessage(
      '44444444-4444-4444-4444-444444444444',
      ROW.thread_id,
      assistantRow.content,
      ROW.client_request_id,
    );

    expect(result.role).toBe('assistant');
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
    expect(mockQuery.mock.calls[0]![0]).toContain("role = 'assistant'");
  });
});
