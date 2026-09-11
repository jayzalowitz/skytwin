import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../connection.js', () => ({ query: queryMock }));

import { reasoningModeRepository } from '../repositories/reasoning-mode-repository.js';

describe('reasoningModeRepository', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns null when no persisted choice exists', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(reasoningModeRepository.getForUser('user-1')).resolves.toBeNull();
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = $1'), ['user-1']);
  });

  it('persists a canonical mode and clears legacy confirmation', async () => {
    const row = {
      user_id: 'user-1', mode: 'on_device', requires_confirmation: false,
      created_at: new Date(), updated_at: new Date(),
    };
    queryMock.mockResolvedValue({ rows: [row] });
    await expect(reasoningModeRepository.setForUser('user-1', 'on_device')).resolves.toBe(row);
    expect(queryMock.mock.calls[0]![0]).toContain('requires_confirmation = false');
    expect(queryMock.mock.calls[0]![1]).toEqual(['user-1', 'on_device']);
  });

  it('creates a privacy-preserving default without overwriting migrated ambiguity', async () => {
    const row = {
      user_id: 'user-1', mode: 'on_device', requires_confirmation: false,
      created_at: new Date(), updated_at: new Date(),
    };
    queryMock.mockResolvedValueOnce({ rows: [row] });
    await expect(reasoningModeRepository.getOrCreateForUser('user-1')).resolves.toBe(row);
    expect(queryMock.mock.calls[0]![0]).toContain('ON CONFLICT (user_id) DO NOTHING');

    const ambiguous = { ...row, mode: null, requires_confirmation: true };
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [ambiguous] });
    await expect(reasoningModeRepository.getOrCreateForUser('user-1')).resolves.toBe(ambiguous);
  });

  it('enforces provider compatibility in the same statement as a mode update', async () => {
    const row = { user_id: 'user-1', mode: 'on_device', requires_confirmation: false };
    queryMock.mockResolvedValueOnce({ rows: [row] });
    await expect(reasoningModeRepository.setForUserIfCompatible(
      'user-1', 'on_device',
    )).resolves.toBe(row);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('ai_provider_settings');
    expect(sql).toContain('6553[0-5]');
    expect(sql).not.toContain('AND EXISTS');
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual(['user-1', 'on_device']);
  });

  it('permits an explicit mode when the provider chain is empty', async () => {
    const row = { user_id: 'user-1', mode: 'on_device', requires_confirmation: false };
    queryMock.mockResolvedValueOnce({ rows: [row] });
    await expect(reasoningModeRepository.setForUserIfCompatible(
      'user-1', 'on_device',
    )).resolves.toBe(row);
  });

  it('returns null when the current provider snapshot is incompatible', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(reasoningModeRepository.setForUserIfCompatible(
      'user-1', 'on_device',
    )).resolves.toBeNull();
  });
});
