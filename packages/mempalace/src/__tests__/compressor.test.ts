import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Compressor, type EntityCodeRepositoryPort, type ClosetPersistencePort } from '../compressor.js';
import type { MemoryDrawer, EntityCode } from '@skytwin/shared-types';

function createMockEntityCodeRepo(): EntityCodeRepositoryPort {
  const codes: EntityCode[] = [];
  return {
    getEntityCodes: vi.fn(async () => codes),
    upsertEntityCode: vi.fn(async (_userId, code, fullName, entityId) => {
      const existing = codes.find((c) => c.code === code);
      if (existing) {
        existing.fullName = fullName;
        return existing;
      }
      const entityCode: EntityCode = { code, fullName, entityId };
      codes.push(entityCode);
      return entityCode;
    }),
  };
}

function createMockClosetRepo(): ClosetPersistencePort {
  return {
    createCloset: vi.fn(async (input) => ({
      id: `closet_${Date.now()}`,
      roomId: input.roomId,
      wingId: input.wingId,
      userId: input.userId,
      compressedContent: input.compressedContent,
      sourceDrawerIds: input.sourceDrawerIds,
      drawerCount: input.sourceDrawerIds.length,
      tokenCount: input.tokenCount,
      createdAt: new Date(),
    })),
  };
}

function makeDrawer(content: string, hall: string = 'facts', importance: number = 0.5): MemoryDrawer {
  return {
    id: `drawer_${Date.now()}_${Math.random()}`,
    roomId: 'room_1',
    wingId: 'wing_1',
    userId: 'user1',
    hall: hall as MemoryDrawer['hall'],
    content,
    metadata: {
      importance,
      tags: [],
    },
    sourceType: 'signal',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Compressor', () => {
  let entityCodeRepo: EntityCodeRepositoryPort;
  let closetRepo: ClosetPersistencePort;
  let compressor: Compressor;

  beforeEach(() => {
    entityCodeRepo = createMockEntityCodeRepo();
    closetRepo = createMockClosetRepo();
    compressor = new Compressor(entityCodeRepo, closetRepo);
  });

  describe('getOrCreateCode', () => {
    it('should generate a 3-letter code from a name', async () => {
      const code = await compressor.getOrCreateCode('user1', 'Alice Chen');
      expect(code).toHaveLength(3);
      expect(code).toBe(code.toUpperCase());
    });

    it('should return the same code for the same name', async () => {
      const code1 = await compressor.getOrCreateCode('user1', 'Alice Chen');
      const code2 = await compressor.getOrCreateCode('user1', 'Alice Chen');
      expect(code1).toBe(code2);
    });

    it('should generate different codes for different names', async () => {
      const code1 = await compressor.getOrCreateCode('user1', 'Alice Chen');
      const code2 = await compressor.getOrCreateCode('user1', 'Bob Smith');
      expect(code1).not.toBe(code2);
    });
  });

  describe('compressDrawer', () => {
    it('should produce AAAK-formatted output with hall prefix', async () => {
      const drawer = makeDrawer('Alice Chen sent an email about the project.', 'events');
      const compressed = await compressor.compressDrawer('user1', drawer);

      // Should have hall prefix (EVE for events)
      expect(compressed).toMatch(/^EVE\|/);
    });

    it('should add CORE flag for high-importance drawers', async () => {
      const drawer = makeDrawer('Very important memory', 'facts', 0.9);
      const compressed = await compressor.compressDrawer('user1', drawer);

      expect(compressed).toContain('CORE');
    });

    it('should detect GENESIS flag in content', async () => {
      const drawer = makeDrawer('This was the first time using the new system', 'events');
      const compressed = await compressor.compressDrawer('user1', drawer);

      expect(compressed).toContain('GENESIS');
    });

    it('should truncate very long content', async () => {
      const longContent = 'A'.repeat(500);
      const drawer = makeDrawer(longContent, 'facts');
      const compressed = await compressor.compressDrawer('user1', drawer);

      expect(compressed.length).toBeLessThan(250);
    });
  });

  describe('compress', () => {
    it('should compress multiple drawers into a single closet', async () => {
      const drawers = [
        makeDrawer('First memory'),
        makeDrawer('Second memory'),
        makeDrawer('Third memory'),
      ];

      const closet = await compressor.compress('user1', drawers, 'room_1', 'wing_1');

      expect(closet.sourceDrawerIds).toHaveLength(3);
      expect(closet.compressedContent).toContain('First memory');
      expect(closet.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('decompress', () => {
    it('should remove hall prefix and flags', async () => {
      const compressed = 'FAC|[CORE]Important fact about the system';
      const decompressed = await compressor.decompress('user1', compressed);

      expect(decompressed).not.toContain('FAC|');
      expect(decompressed).not.toContain('[CORE]');
      expect(decompressed).toContain('Important fact');
    });
  });
});
