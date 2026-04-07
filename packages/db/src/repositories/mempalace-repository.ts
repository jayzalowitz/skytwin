import { query } from '../connection.js';
import type {
  MemoryWingRow,
  MemoryRoomRow,
  MemoryDrawerRow,
  MemoryClosetRow,
  MemoryTunnelRow,
  KnowledgeEntityRow,
  KnowledgeTripleRow,
  EpisodicMemoryRow,
  EntityCodeRow,
} from '../types.js';

// ── Wing operations ────────────────────────────────────────────────

export interface CreateWingInput {
  userId: string;
  name: string;
  description?: string;
  domains?: string[];
}

export interface CreateRoomInput {
  wingId: string;
  name: string;
  description?: string;
  halls?: string[];
}

export interface CreateDrawerInput {
  roomId: string;
  wingId: string;
  userId: string;
  hall: string;
  content: string;
  metadata?: Record<string, unknown>;
  sourceType: string;
  sourceId?: string;
}

export interface CreateClosetInput {
  roomId: string;
  wingId: string;
  userId: string;
  compressedContent: string;
  sourceDrawerIds: string[];
  tokenCount: number;
}

export interface CreateEpisodeInput {
  userId: string;
  situationSummary: string;
  domain: string;
  situationType: string;
  contextSnapshot?: Record<string, unknown>;
  actionTaken?: string;
  outcome?: Record<string, unknown>;
  feedbackType?: string;
  feedbackDetail?: string;
  decisionId?: string;
  signalIds?: string[];
  drawerIds?: string[];
  utilityScore?: number;
}

export interface CreateEntityInput {
  userId: string;
  name: string;
  entityType: string;
  properties?: Record<string, unknown>;
  aliases?: string[];
}

export interface CreateTripleInput {
  userId: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom?: Date;
  confidence?: string;
  sourceClosetId?: string;
  sourceDrawerId?: string;
}

export const mempalaceRepository = {
  // ── Wings ──────────────────────────────────────────────────────

  async createWing(input: CreateWingInput): Promise<MemoryWingRow> {
    const result = await query<MemoryWingRow>(
      `INSERT INTO memory_wings (user_id, name, description, domains)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, name) DO UPDATE SET
         description = EXCLUDED.description,
         domains = EXCLUDED.domains,
         updated_at = now()
       RETURNING *`,
      [input.userId, input.name, input.description ?? '', input.domains ?? []],
    );
    return result.rows[0]!;
  },

  async getWings(userId: string): Promise<MemoryWingRow[]> {
    const result = await query<MemoryWingRow>(
      'SELECT * FROM memory_wings WHERE user_id = $1 ORDER BY name',
      [userId],
    );
    return result.rows;
  },

  async getWingByName(userId: string, name: string): Promise<MemoryWingRow | null> {
    const result = await query<MemoryWingRow>(
      'SELECT * FROM memory_wings WHERE user_id = $1 AND name = $2',
      [userId, name],
    );
    return result.rows[0] ?? null;
  },

  // ── Rooms ──────────────────────────────────────────────────────

  async createRoom(input: CreateRoomInput): Promise<MemoryRoomRow> {
    const result = await query<MemoryRoomRow>(
      `INSERT INTO memory_rooms (wing_id, name, description, halls)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wing_id, name) DO UPDATE SET
         description = EXCLUDED.description,
         halls = EXCLUDED.halls,
         updated_at = now()
       RETURNING *`,
      [input.wingId, input.name, input.description ?? '', input.halls ?? []],
    );
    return result.rows[0]!;
  },

  async getRooms(wingId: string): Promise<MemoryRoomRow[]> {
    const result = await query<MemoryRoomRow>(
      'SELECT * FROM memory_rooms WHERE wing_id = $1 ORDER BY name',
      [wingId],
    );
    return result.rows;
  },

  async getRoomByName(wingId: string, name: string): Promise<MemoryRoomRow | null> {
    const result = await query<MemoryRoomRow>(
      'SELECT * FROM memory_rooms WHERE wing_id = $1 AND name = $2',
      [wingId, name],
    );
    return result.rows[0] ?? null;
  },

  async getRoomsByTopic(userId: string, topic: string): Promise<MemoryRoomRow[]> {
    const result = await query<MemoryRoomRow>(
      `SELECT r.* FROM memory_rooms r
       JOIN memory_wings w ON r.wing_id = w.id
       WHERE w.user_id = $1 AND r.name = $2`,
      [userId, topic],
    );
    return result.rows;
  },

  // ── Drawers ────────────────────────────────────────────────────

  async createDrawer(input: CreateDrawerInput): Promise<MemoryDrawerRow> {
    const result = await query<MemoryDrawerRow>(
      `INSERT INTO memory_drawers (room_id, wing_id, user_id, hall, content, metadata, source_type, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.roomId, input.wingId, input.userId, input.hall,
        input.content, JSON.stringify(input.metadata ?? {}),
        input.sourceType, input.sourceId ?? null,
      ],
    );

    // Update drawer counts
    await query(
      'UPDATE memory_rooms SET drawer_count = drawer_count + 1, updated_at = now() WHERE id = $1',
      [input.roomId],
    );
    await query(
      'UPDATE memory_wings SET drawer_count = drawer_count + 1, updated_at = now() WHERE id = $1',
      [input.wingId],
    );

    return result.rows[0]!;
  },

  async getDrawers(userId: string, options?: {
    hall?: string;
    wingId?: string;
    roomId?: string;
    limit?: number;
  }): Promise<MemoryDrawerRow[]> {
    const conditions = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (options?.hall) {
      conditions.push(`hall = $${paramIdx}`);
      params.push(options.hall);
      paramIdx++;
    }
    if (options?.wingId) {
      conditions.push(`wing_id = $${paramIdx}`);
      params.push(options.wingId);
      paramIdx++;
    }
    if (options?.roomId) {
      conditions.push(`room_id = $${paramIdx}`);
      params.push(options.roomId);
      paramIdx++;
    }

    const limit = options?.limit ?? 100;
    const result = await query<MemoryDrawerRow>(
      `SELECT * FROM memory_drawers
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params,
    );
    return result.rows;
  },

  async searchDrawers(userId: string, searchTerms: string[], limit: number = 20): Promise<MemoryDrawerRow[]> {
    // Text-based search across drawer content and metadata
    const likeConditions = searchTerms.map((_, i) => `(content ILIKE $${i + 2} OR metadata::STRING ILIKE $${i + 2})`);
    const params: unknown[] = [userId, ...searchTerms.map((t) => `%${t}%`)];

    const result = await query<MemoryDrawerRow>(
      `SELECT * FROM memory_drawers
       WHERE user_id = $1 AND (${likeConditions.join(' OR ')})
       ORDER BY created_at DESC
       LIMIT ${limit}`,
      params,
    );
    return result.rows;
  },

  async findDrawerBySourceId(userId: string, sourceType: string, sourceId: string): Promise<MemoryDrawerRow | null> {
    const result = await query<MemoryDrawerRow>(
      `SELECT * FROM memory_drawers
       WHERE user_id = $1 AND source_type = $2 AND source_id = $3
       LIMIT 1`,
      [userId, sourceType, sourceId],
    );
    return result.rows[0] ?? null;
  },

  async deleteDrawer(drawerId: string): Promise<boolean> {
    const drawer = await query<MemoryDrawerRow>(
      'SELECT room_id, wing_id FROM memory_drawers WHERE id = $1',
      [drawerId],
    );
    if (!drawer.rows[0]) return false;

    await query('DELETE FROM memory_drawers WHERE id = $1', [drawerId]);

    // Update counts
    await query(
      'UPDATE memory_rooms SET drawer_count = GREATEST(drawer_count - 1, 0), updated_at = now() WHERE id = $1',
      [drawer.rows[0].room_id],
    );
    await query(
      'UPDATE memory_wings SET drawer_count = GREATEST(drawer_count - 1, 0), updated_at = now() WHERE id = $1',
      [drawer.rows[0].wing_id],
    );

    return true;
  },

  // ── Closets ────────────────────────────────────────────────────

  async createCloset(input: CreateClosetInput): Promise<MemoryClosetRow> {
    const result = await query<MemoryClosetRow>(
      `INSERT INTO memory_closets (room_id, wing_id, user_id, compressed_content, source_drawer_ids, drawer_count, token_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.roomId, input.wingId, input.userId,
        input.compressedContent, input.sourceDrawerIds,
        input.sourceDrawerIds.length, input.tokenCount,
      ],
    );
    return result.rows[0]!;
  },

  async getClosets(userId: string, roomId?: string): Promise<MemoryClosetRow[]> {
    if (roomId) {
      const result = await query<MemoryClosetRow>(
        'SELECT * FROM memory_closets WHERE user_id = $1 AND room_id = $2 ORDER BY created_at DESC',
        [userId, roomId],
      );
      return result.rows;
    }
    const result = await query<MemoryClosetRow>(
      'SELECT * FROM memory_closets WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    );
    return result.rows;
  },

  // ── Tunnels ────────────────────────────────────────────────────

  async upsertTunnel(
    userId: string,
    topic: string,
    roomIds: string[],
    wingIds: string[],
    strength: number = 1.0,
  ): Promise<MemoryTunnelRow> {
    const result = await query<MemoryTunnelRow>(
      `INSERT INTO memory_tunnels (user_id, topic, connected_room_ids, connected_wing_ids, strength)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, topic) DO UPDATE SET
         connected_room_ids = EXCLUDED.connected_room_ids,
         connected_wing_ids = EXCLUDED.connected_wing_ids,
         strength = EXCLUDED.strength,
         updated_at = now()
       RETURNING *`,
      [userId, topic, roomIds, wingIds, strength],
    );
    return result.rows[0]!;
  },

  async getTunnels(userId: string): Promise<MemoryTunnelRow[]> {
    const result = await query<MemoryTunnelRow>(
      'SELECT * FROM memory_tunnels WHERE user_id = $1 ORDER BY strength DESC',
      [userId],
    );
    return result.rows;
  },

  // ── Knowledge Graph: Entities ──────────────────────────────────

  async upsertEntity(input: CreateEntityInput): Promise<KnowledgeEntityRow> {
    const result = await query<KnowledgeEntityRow>(
      `INSERT INTO knowledge_entities (user_id, name, entity_type, properties, aliases)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, name, entity_type) DO UPDATE SET
         properties = EXCLUDED.properties,
         aliases = EXCLUDED.aliases,
         updated_at = now()
       RETURNING *`,
      [
        input.userId, input.name, input.entityType,
        JSON.stringify(input.properties ?? {}), input.aliases ?? [],
      ],
    );
    return result.rows[0]!;
  },

  async getEntities(userId: string, entityType?: string): Promise<KnowledgeEntityRow[]> {
    if (entityType) {
      const result = await query<KnowledgeEntityRow>(
        'SELECT * FROM knowledge_entities WHERE user_id = $1 AND entity_type = $2 ORDER BY name',
        [userId, entityType],
      );
      return result.rows;
    }
    const result = await query<KnowledgeEntityRow>(
      'SELECT * FROM knowledge_entities WHERE user_id = $1 ORDER BY name',
      [userId],
    );
    return result.rows;
  },

  async findEntity(userId: string, name: string): Promise<KnowledgeEntityRow | null> {
    const result = await query<KnowledgeEntityRow>(
      `SELECT * FROM knowledge_entities
       WHERE user_id = $1 AND (name = $2 OR $2 = ANY(aliases))
       LIMIT 1`,
      [userId, name],
    );
    return result.rows[0] ?? null;
  },

  // ── Knowledge Graph: Triples ───────────────────────────────────

  async addTriple(input: CreateTripleInput): Promise<KnowledgeTripleRow> {
    const result = await query<KnowledgeTripleRow>(
      `INSERT INTO knowledge_triples (user_id, subject, predicate, object, valid_from, confidence, source_closet_id, source_drawer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.userId, input.subject, input.predicate, input.object,
        input.validFrom ?? new Date(), input.confidence ?? 'moderate',
        input.sourceClosetId ?? null, input.sourceDrawerId ?? null,
      ],
    );
    return result.rows[0]!;
  },

  async queryTriples(userId: string, options?: {
    subject?: string;
    predicate?: string;
    object?: string;
    asOf?: Date;
    limit?: number;
  }): Promise<KnowledgeTripleRow[]> {
    const conditions = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (options?.subject) {
      conditions.push(`subject = $${paramIdx}`);
      params.push(options.subject);
      paramIdx++;
    }
    if (options?.predicate) {
      conditions.push(`predicate = $${paramIdx}`);
      params.push(options.predicate);
      paramIdx++;
    }
    if (options?.object) {
      conditions.push(`object = $${paramIdx}`);
      params.push(options.object);
      paramIdx++;
    }
    if (options?.asOf) {
      conditions.push(`valid_from <= $${paramIdx} AND (valid_to IS NULL OR valid_to > $${paramIdx})`);
      params.push(options.asOf);
      paramIdx++;
    }

    const limit = options?.limit ?? 100;
    const result = await query<KnowledgeTripleRow>(
      `SELECT * FROM knowledge_triples
       WHERE ${conditions.join(' AND ')}
       ORDER BY extracted_at DESC
       LIMIT ${limit}`,
      params,
    );
    return result.rows;
  },

  async invalidateTriple(tripleId: string, validTo?: Date): Promise<void> {
    await query(
      'UPDATE knowledge_triples SET valid_to = $2 WHERE id = $1',
      [tripleId, validTo ?? new Date()],
    );
  },

  // ── Episodic Memories ──────────────────────────────────────────

  async createEpisode(input: CreateEpisodeInput): Promise<EpisodicMemoryRow> {
    const result = await query<EpisodicMemoryRow>(
      `INSERT INTO episodic_memories
       (user_id, situation_summary, domain, situation_type, context_snapshot,
        action_taken, outcome, feedback_type, feedback_detail,
        decision_id, signal_ids, drawer_ids, utility_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        input.userId, input.situationSummary, input.domain, input.situationType,
        JSON.stringify(input.contextSnapshot ?? {}),
        input.actionTaken ?? null,
        input.outcome ? JSON.stringify(input.outcome) : null,
        input.feedbackType ?? null, input.feedbackDetail ?? null,
        input.decisionId ?? null, input.signalIds ?? [], input.drawerIds ?? [],
        input.utilityScore ?? 0.5,
      ],
    );
    return result.rows[0]!;
  },

  async getEpisodes(userId: string, options?: {
    domain?: string;
    situationType?: string;
    limit?: number;
    minUtility?: number;
  }): Promise<EpisodicMemoryRow[]> {
    const conditions = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (options?.domain) {
      conditions.push(`domain = $${paramIdx}`);
      params.push(options.domain);
      paramIdx++;
    }
    if (options?.situationType) {
      conditions.push(`situation_type = $${paramIdx}`);
      params.push(options.situationType);
      paramIdx++;
    }
    if (options?.minUtility !== undefined) {
      conditions.push(`utility_score >= $${paramIdx}`);
      params.push(options.minUtility);
      paramIdx++;
    }

    const limit = options?.limit ?? 50;
    const result = await query<EpisodicMemoryRow>(
      `SELECT * FROM episodic_memories
       WHERE ${conditions.join(' AND ')}
       ORDER BY utility_score DESC, created_at DESC
       LIMIT ${limit}`,
      params,
    );
    return result.rows;
  },

  async getEpisodeByDecision(decisionId: string): Promise<EpisodicMemoryRow | null> {
    const result = await query<EpisodicMemoryRow>(
      'SELECT * FROM episodic_memories WHERE decision_id = $1',
      [decisionId],
    );
    return result.rows[0] ?? null;
  },

  async updateEpisode(
    episodeId: string,
    updates: Partial<Pick<EpisodicMemoryRow, 'outcome' | 'feedback_type' | 'feedback_detail' | 'utility_score' | 'action_taken' | 'drawer_ids'>>,
  ): Promise<EpisodicMemoryRow | null> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (updates.outcome !== undefined) {
      setClauses.push(`outcome = $${paramIdx}`);
      params.push(JSON.stringify(updates.outcome));
      paramIdx++;
    }
    if (updates.feedback_type !== undefined) {
      setClauses.push(`feedback_type = $${paramIdx}`);
      params.push(updates.feedback_type);
      paramIdx++;
    }
    if (updates.feedback_detail !== undefined) {
      setClauses.push(`feedback_detail = $${paramIdx}`);
      params.push(updates.feedback_detail);
      paramIdx++;
    }
    if (updates.utility_score !== undefined) {
      setClauses.push(`utility_score = $${paramIdx}`);
      params.push(updates.utility_score);
      paramIdx++;
    }
    if (updates.action_taken !== undefined) {
      setClauses.push(`action_taken = $${paramIdx}`);
      params.push(updates.action_taken);
      paramIdx++;
    }
    if (updates.drawer_ids !== undefined) {
      setClauses.push(`drawer_ids = $${paramIdx}`);
      params.push(updates.drawer_ids);
      paramIdx++;
    }

    if (setClauses.length === 0) return null;

    setClauses.push('updated_at = now()');
    params.push(episodeId);

    const result = await query<EpisodicMemoryRow>(
      `UPDATE episodic_memories SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params,
    );
    return result.rows[0] ?? null;
  },

  async searchEpisodes(
    userId: string,
    searchTerms: string[],
    limit: number = 10,
  ): Promise<EpisodicMemoryRow[]> {
    const likeConditions = searchTerms.map(
      (_, i) => `(situation_summary ILIKE $${i + 2} OR action_taken ILIKE $${i + 2} OR context_snapshot::STRING ILIKE $${i + 2})`,
    );
    const params: unknown[] = [userId, ...searchTerms.map((t) => `%${t}%`)];

    const result = await query<EpisodicMemoryRow>(
      `SELECT * FROM episodic_memories
       WHERE user_id = $1 AND (${likeConditions.join(' OR ')})
       ORDER BY utility_score DESC, created_at DESC
       LIMIT ${limit}`,
      params,
    );
    return result.rows;
  },

  // ── Entity Codes (AAAK) ────────────────────────────────────────

  async upsertEntityCode(
    userId: string,
    code: string,
    fullName: string,
    entityId?: string,
  ): Promise<EntityCodeRow> {
    const result = await query<EntityCodeRow>(
      `INSERT INTO entity_codes (user_id, code, full_name, entity_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, code) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         entity_id = EXCLUDED.entity_id
       RETURNING *`,
      [userId, code, fullName, entityId ?? null],
    );
    return result.rows[0]!;
  },

  async getEntityCodes(userId: string): Promise<EntityCodeRow[]> {
    const result = await query<EntityCodeRow>(
      'SELECT * FROM entity_codes WHERE user_id = $1 ORDER BY code',
      [userId],
    );
    return result.rows;
  },

  // ── Palace Status ──────────────────────────────────────────────

  async getStatus(userId: string): Promise<{
    wingCount: number;
    roomCount: number;
    drawerCount: number;
    closetCount: number;
    tunnelCount: number;
    entityCount: number;
    tripleCount: number;
    episodeCount: number;
    oldestMemory: Date | null;
    newestMemory: Date | null;
  }> {
    const counts = await query<{
      wing_count: string;
      room_count: string;
      drawer_count: string;
      closet_count: string;
      tunnel_count: string;
      entity_count: string;
      triple_count: string;
      episode_count: string;
      oldest: Date | null;
      newest: Date | null;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM memory_wings WHERE user_id = $1) AS wing_count,
        (SELECT COUNT(*) FROM memory_rooms r JOIN memory_wings w ON r.wing_id = w.id WHERE w.user_id = $1) AS room_count,
        (SELECT COUNT(*) FROM memory_drawers WHERE user_id = $1) AS drawer_count,
        (SELECT COUNT(*) FROM memory_closets WHERE user_id = $1) AS closet_count,
        (SELECT COUNT(*) FROM memory_tunnels WHERE user_id = $1) AS tunnel_count,
        (SELECT COUNT(*) FROM knowledge_entities WHERE user_id = $1) AS entity_count,
        (SELECT COUNT(*) FROM knowledge_triples WHERE user_id = $1) AS triple_count,
        (SELECT COUNT(*) FROM episodic_memories WHERE user_id = $1) AS episode_count,
        (SELECT MIN(created_at) FROM memory_drawers WHERE user_id = $1) AS oldest,
        (SELECT MAX(created_at) FROM memory_drawers WHERE user_id = $1) AS newest`,
      [userId],
    );

    const row = counts.rows[0]!;
    return {
      wingCount: parseInt(String(row.wing_count), 10),
      roomCount: parseInt(String(row.room_count), 10),
      drawerCount: parseInt(String(row.drawer_count), 10),
      closetCount: parseInt(String(row.closet_count), 10),
      tunnelCount: parseInt(String(row.tunnel_count), 10),
      entityCount: parseInt(String(row.entity_count), 10),
      tripleCount: parseInt(String(row.triple_count), 10),
      episodeCount: parseInt(String(row.episode_count), 10),
      oldestMemory: row.oldest,
      newestMemory: row.newest,
    };
  },
};
