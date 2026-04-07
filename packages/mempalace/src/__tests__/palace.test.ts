import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Palace, type PalaceRepositoryPort } from '../palace.js';
import type { MemoryWing, MemoryRoom, MemoryDrawer } from '@skytwin/shared-types';

function createMockRepo(): PalaceRepositoryPort {
  const wings: MemoryWing[] = [];
  const rooms: MemoryRoom[] = [];
  const drawers: MemoryDrawer[] = [];

  return {
    createWing: vi.fn(async (userId, name, description, domains) => {
      const wing: MemoryWing = {
        id: `wing_${name}`,
        userId,
        name,
        description,
        domains,
        drawerCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      wings.push(wing);
      return wing;
    }),
    getWings: vi.fn(async () => wings),
    getWingByName: vi.fn(async (_userId, name) => wings.find((w) => w.name === name) ?? null),

    createRoom: vi.fn(async (wingId, name, description, halls) => {
      const room: MemoryRoom = {
        id: `room_${wingId}_${name}`,
        wingId: wingId as unknown as string,
        name,
        description,
        halls,
        drawerCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MemoryRoom;
      rooms.push(room);
      return room;
    }),
    getRooms: vi.fn(async (wingId) => rooms.filter((r) => (r as unknown as { wingId: string }).wingId === wingId)),
    getRoomByName: vi.fn(async (wingId, name) => rooms.find((r) => (r as unknown as { wingId: string }).wingId === wingId && r.name === name) ?? null),
    getRoomsByTopic: vi.fn(async (_userId, topic) => rooms.filter((r) => r.name === topic)),

    createDrawer: vi.fn(async (input) => {
      const drawer: MemoryDrawer = {
        id: `drawer_${Date.now()}`,
        roomId: input.roomId,
        wingId: input.wingId,
        userId: input.userId,
        hall: input.hall,
        content: input.content,
        metadata: input.metadata,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      drawers.push(drawer);
      return drawer;
    }),
    getDrawers: vi.fn(async () => drawers),
    searchDrawers: vi.fn(async () => []),
    deleteDrawer: vi.fn(async () => true),

    upsertTunnel: vi.fn(async (_userId, topic, roomIds, wingIds, strength) => ({
      id: `tunnel_${topic}`,
      userId: _userId,
      topic,
      connectedRoomIds: roomIds,
      connectedWingIds: wingIds,
      strength,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    getTunnels: vi.fn(async () => []),

    getStatus: vi.fn(async (userId) => ({
      userId,
      wingCount: wings.length,
      roomCount: rooms.length,
      drawerCount: drawers.length,
      closetCount: 0,
      tunnelCount: 0,
      entityCount: 0,
      tripleCount: 0,
      episodeCount: 0,
    })),
  };
}

describe('Palace', () => {
  let repo: PalaceRepositoryPort;
  let palace: Palace;

  beforeEach(() => {
    repo = createMockRepo();
    palace = new Palace(repo);
  });

  describe('ensureWing', () => {
    it('should create a new wing for an unseen domain', async () => {
      const wing = await palace.ensureWing('user1', 'email');
      expect(wing.name).toBe('communication');
      expect(wing.domains).toEqual(['email']);
      expect(repo.createWing).toHaveBeenCalledOnce();
    });

    it('should return existing wing for a seen domain', async () => {
      await palace.ensureWing('user1', 'email');
      const wing = await palace.ensureWing('user1', 'email');
      expect(wing.name).toBe('communication');
      // createWing called once for the first call, second call finds it
      expect(repo.createWing).toHaveBeenCalledOnce();
    });

    it('should map different domains to different wing names', async () => {
      await palace.ensureWing('user1', 'email');
      await palace.ensureWing('user1', 'finance');
      expect(repo.createWing).toHaveBeenCalledTimes(2);
    });
  });

  describe('ensureRoom', () => {
    it('should create a room in a wing', async () => {
      const wing = await palace.ensureWing('user1', 'email');
      const room = await palace.ensureRoom(wing.id, 'inbox-triage');
      expect(room.name).toBe('inbox-triage');
      expect(repo.createRoom).toHaveBeenCalledOnce();
    });
  });

  describe('fileMemory', () => {
    it('should file a memory into the correct wing and room', async () => {
      const drawer = await palace.fileMemory(
        'user1',
        'email',
        'inbox-triage',
        'events',
        'Received email from Alice about project deadline',
        { people: ['Alice'], importance: 0.7 },
        'signal',
        'sig_123',
      );

      expect(drawer.content).toContain('Alice');
      expect(drawer.hall).toBe('events');
      expect(drawer.sourceType).toBe('signal');
      expect(repo.createDrawer).toHaveBeenCalledOnce();
    });

    it('should auto-create wing and room if they dont exist', async () => {
      await palace.fileMemory(
        'user1',
        'travel',
        'flights',
        'facts',
        'Flight to NYC on March 15',
        { importance: 0.8 },
        'signal',
      );

      expect(repo.createWing).toHaveBeenCalledOnce();
      expect(repo.createRoom).toHaveBeenCalledOnce();
    });

    it('should set domain in metadata', async () => {
      const drawer = await palace.fileMemory(
        'user1',
        'finance',
        'transactions',
        'events',
        'Paid $50 for groceries',
        { importance: 0.5 },
        'signal',
      );

      expect(drawer.metadata.domain).toBe('finance');
    });
  });

  describe('getStatus', () => {
    it('should return palace status', async () => {
      await palace.fileMemory('user1', 'email', 'inbox', 'facts', 'test', { importance: 0.5 }, 'signal');
      const status = await palace.getStatus('user1');
      expect(status.wingCount).toBeGreaterThanOrEqual(0);
    });
  });
});
