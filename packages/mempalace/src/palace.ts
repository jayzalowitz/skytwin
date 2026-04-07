import type {
  MemoryWing,
  MemoryRoom,
  MemoryHall,
  MemoryDrawer,
  MemoryTunnel,
  DrawerSource,
  DrawerMetadata,
  PalaceStatus,
} from '@skytwin/shared-types';

/**
 * Port interface for palace persistence. Business logic depends on this
 * interface, not on concrete DB repositories.
 */
export interface PalaceRepositoryPort {
  createWing(userId: string, name: string, description: string, domains: string[]): Promise<MemoryWing>;
  getWings(userId: string): Promise<MemoryWing[]>;
  getWingByName(userId: string, name: string): Promise<MemoryWing | null>;

  createRoom(wingId: string, name: string, description: string, halls: MemoryHall[]): Promise<MemoryRoom>;
  getRooms(wingId: string): Promise<MemoryRoom[]>;
  getRoomByName(wingId: string, name: string): Promise<MemoryRoom | null>;
  getRoomsByTopic(userId: string, topic: string): Promise<MemoryRoom[]>;

  createDrawer(input: {
    roomId: string;
    wingId: string;
    userId: string;
    hall: MemoryHall;
    content: string;
    metadata: DrawerMetadata;
    sourceType: DrawerSource;
    sourceId?: string;
  }): Promise<MemoryDrawer>;
  getDrawers(userId: string, options?: {
    hall?: MemoryHall;
    wingId?: string;
    roomId?: string;
    limit?: number;
  }): Promise<MemoryDrawer[]>;
  searchDrawers(userId: string, terms: string[], limit?: number): Promise<MemoryDrawer[]>;
  deleteDrawer(drawerId: string): Promise<boolean>;

  upsertTunnel(userId: string, topic: string, roomIds: string[], wingIds: string[], strength: number): Promise<MemoryTunnel>;
  getTunnels(userId: string): Promise<MemoryTunnel[]>;

  getStatus(userId: string): Promise<PalaceStatus>;
}

/**
 * The Palace manages the spatial structure of a user's memory.
 * It handles wing/room creation, drawer filing, and tunnel detection.
 */
export class Palace {
  constructor(private readonly repository: PalaceRepositoryPort) {}

  /**
   * Get or create a wing for a given domain. Maps SkyTwin domains
   * to palace wings automatically.
   */
  async ensureWing(userId: string, domain: string): Promise<MemoryWing> {
    const wingName = this.domainToWingName(domain);
    const existing = await this.repository.getWingByName(userId, wingName);
    if (existing) return existing;

    return this.repository.createWing(
      userId,
      wingName,
      `Memories related to ${domain}`,
      [domain],
    );
  }

  /**
   * Get or create a room within a wing for a specific topic.
   */
  async ensureRoom(
    wingId: string,
    topic: string,
    hall: MemoryHall = 'facts',
  ): Promise<MemoryRoom> {
    const existing = await this.repository.getRoomByName(wingId, topic);
    if (existing) return existing;

    return this.repository.createRoom(wingId, topic, '', [hall]);
  }

  /**
   * File a new memory into the palace. Automatically creates the wing
   * and room if they don't exist, and detects cross-wing tunnels.
   */
  async fileMemory(
    userId: string,
    domain: string,
    topic: string,
    hall: MemoryHall,
    content: string,
    metadata: Partial<DrawerMetadata>,
    sourceType: DrawerSource,
    sourceId?: string,
  ): Promise<MemoryDrawer> {
    const wing = await this.ensureWing(userId, domain);
    const room = await this.ensureRoom(wing.id, topic, hall);

    const fullMetadata: DrawerMetadata = {
      importance: 0.5,
      ...metadata,
      domain,
    };

    const drawer = await this.repository.createDrawer({
      roomId: room.id,
      wingId: wing.id,
      userId,
      hall,
      content,
      metadata: fullMetadata,
      sourceType,
      sourceId,
    });

    // Check for cross-wing tunnel opportunities
    await this.detectTunnel(userId, topic);

    return drawer;
  }

  /**
   * Detect and create tunnels when a room name appears in multiple wings.
   */
  async detectTunnel(userId: string, topic: string): Promise<MemoryTunnel | null> {
    const rooms = await this.repository.getRoomsByTopic(userId, topic);
    if (rooms.length < 2) return null;

    const roomIds = rooms.map((r) => r.id);
    // We need wing IDs — rooms have wing_id from the DB
    const wingIds = [...new Set(rooms.map((r) => {
      // MemoryRoom doesn't have wingId on the interface, but the DB row does
      // The repository will need to return this. For now, use a workaround.
      return (r as unknown as { wingId: string }).wingId;
    }))].filter(Boolean);

    if (wingIds.length < 2) return null;

    const strength = Math.min(rooms.length / 2, 5);
    return this.repository.upsertTunnel(userId, topic, roomIds, wingIds, strength);
  }

  /**
   * Get all wings for a user.
   */
  async getWings(userId: string): Promise<MemoryWing[]> {
    return this.repository.getWings(userId);
  }

  /**
   * Get all rooms in a wing.
   */
  async getRooms(wingId: string): Promise<MemoryRoom[]> {
    return this.repository.getRooms(wingId);
  }

  /**
   * Search drawers across the entire palace.
   */
  async search(userId: string, terms: string[], limit: number = 20): Promise<MemoryDrawer[]> {
    return this.repository.searchDrawers(userId, terms, limit);
  }

  /**
   * Get the full status of a user's memory palace.
   */
  async getStatus(userId: string): Promise<PalaceStatus> {
    return this.repository.getStatus(userId);
  }

  /**
   * Get all tunnels (cross-wing connections).
   */
  async getTunnels(userId: string): Promise<MemoryTunnel[]> {
    return this.repository.getTunnels(userId);
  }

  /**
   * Map a SkyTwin domain to a wing name.
   */
  private domainToWingName(domain: string): string {
    const wingMap: Record<string, string> = {
      email: 'communication',
      calendar: 'scheduling',
      subscriptions: 'services',
      shopping: 'commerce',
      travel: 'travel',
      finance: 'finance',
      smart_home: 'home',
      tasks: 'productivity',
      social_media: 'social',
      documents: 'documents',
      health: 'wellbeing',
      general: 'general',
    };
    return wingMap[domain] ?? domain;
  }
}
