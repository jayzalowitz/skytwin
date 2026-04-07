import type {
  MemoryDrawer,
  MemoryCloset,
  EntityCode,
  AAAKFlag,
} from '@skytwin/shared-types';

/**
 * Port interface for entity code persistence.
 */
export interface EntityCodeRepositoryPort {
  getEntityCodes(userId: string): Promise<EntityCode[]>;
  upsertEntityCode(userId: string, code: string, fullName: string, entityId?: string): Promise<EntityCode>;
}

/**
 * Port interface for closet persistence.
 */
export interface ClosetPersistencePort {
  createCloset(input: {
    roomId: string;
    wingId: string;
    userId: string;
    compressedContent: string;
    sourceDrawerIds: string[];
    tokenCount: number;
  }): Promise<MemoryCloset>;
}

/**
 * The Compressor implements AAAK-style compression for memory drawers.
 * It produces compact, LLM-readable summaries that drastically reduce
 * token count while preserving key information.
 *
 * AAAK format:
 * - Entity codes: 3-letter uppercase (ALC=Alice, MAX=Max)
 * - Emotion markers: *warm*, *fierce*, *raw*
 * - Pipe-separated fields
 * - Flags: ORIGIN, CORE, SENSITIVE, PIVOT, GENESIS, DECISION, TECHNICAL
 */
export class Compressor {
  private entityCodes = new Map<string, string>();

  constructor(
    private readonly entityCodeRepo: EntityCodeRepositoryPort,
    private readonly closetRepo: ClosetPersistencePort,
  ) {}

  /**
   * Load existing entity codes for a user.
   */
  async loadCodes(userId: string): Promise<void> {
    const codes = await this.entityCodeRepo.getEntityCodes(userId);
    this.entityCodes.clear();
    for (const code of codes) {
      this.entityCodes.set(code.fullName.toLowerCase(), code.code);
    }
  }

  /**
   * Get or create a 3-letter entity code for a name.
   */
  async getOrCreateCode(userId: string, fullName: string): Promise<string> {
    const key = fullName.toLowerCase();
    const existing = this.entityCodes.get(key);
    if (existing) return existing;

    const code = this.generateCode(fullName);
    await this.entityCodeRepo.upsertEntityCode(userId, code, fullName);
    this.entityCodes.set(key, code);
    return code;
  }

  /**
   * Compress a set of drawers into a single closet.
   */
  async compress(
    userId: string,
    drawers: MemoryDrawer[],
    roomId: string,
    wingId: string,
  ): Promise<MemoryCloset> {
    await this.loadCodes(userId);

    const lines: string[] = [];

    for (const drawer of drawers) {
      const compressed = await this.compressDrawer(userId, drawer);
      lines.push(compressed);
    }

    const content = lines.join('\n');
    const tokenCount = Math.ceil(content.length / 4);

    return this.closetRepo.createCloset({
      roomId,
      wingId,
      userId,
      compressedContent: content,
      sourceDrawerIds: drawers.map((d) => d.id),
      tokenCount,
    });
  }

  /**
   * Compress a single drawer into AAAK format.
   */
  async compressDrawer(userId: string, drawer: MemoryDrawer): Promise<string> {
    let content = drawer.content;

    // Replace known entity names with codes
    for (const [name, code] of this.entityCodes.entries()) {
      const regex = new RegExp(this.escapeRegex(name), 'gi');
      content = content.replace(regex, code);
    }

    // Extract and replace any new entities
    const names = this.extractNames(drawer.content);
    for (const name of names) {
      const code = await this.getOrCreateCode(userId, name);
      const regex = new RegExp(this.escapeRegex(name), 'gi');
      content = content.replace(regex, code);
    }

    // Add flags
    const flags = this.detectFlags(drawer);
    const flagStr = flags.length > 0 ? `[${flags.join(',')}]` : '';

    // Add hall type
    const hallPrefix = drawer.hall.toUpperCase().slice(0, 3);

    // Compact whitespace
    content = content.replace(/\s+/g, ' ').trim();

    // Truncate if very long
    if (content.length > 200) {
      content = content.slice(0, 197) + '...';
    }

    return `${hallPrefix}|${flagStr}${content}`;
  }

  /**
   * Decompress AAAK content back to human-readable text.
   */
  async decompress(userId: string, compressed: string): Promise<string> {
    await this.loadCodes(userId);

    let text = compressed;

    // Remove hall prefix
    const pipeIdx = text.indexOf('|');
    if (pipeIdx >= 0) {
      text = text.slice(pipeIdx + 1);
    }

    // Remove flags
    text = text.replace(/\[[\w,]+\]/g, '');

    // Replace entity codes with full names
    const reverseMap = new Map<string, string>();
    for (const [name, code] of this.entityCodes.entries()) {
      reverseMap.set(code, name);
    }

    for (const [code, name] of reverseMap.entries()) {
      const regex = new RegExp(`\\b${this.escapeRegex(code)}\\b`, 'g');
      text = text.replace(regex, name);
    }

    return text.trim();
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Generate a 3-letter uppercase code from a name.
   */
  private generateCode(name: string): string {
    const parts = name.trim().split(/\s+/);
    let code: string;

    if (parts.length >= 2) {
      // First letter of first name + first two letters of last name
      code = (parts[0]![0]! + parts[parts.length - 1]!.slice(0, 2)).toUpperCase();
    } else {
      // First three letters
      code = name.slice(0, 3).toUpperCase();
    }

    // Ensure uniqueness
    const existing = new Set(this.entityCodes.values());
    let attempt = code;
    let suffix = 0;
    while (existing.has(attempt)) {
      suffix++;
      attempt = code.slice(0, 2) + String(suffix);
    }

    return attempt;
  }

  /**
   * Extract potential person names from text using simple heuristics.
   */
  private extractNames(text: string): string[] {
    const names: string[] = [];
    const matches = text.match(/(?:[A-Z][a-z]+ ){1,2}[A-Z][a-z]+/g) ?? [];

    for (const match of matches) {
      const trimmed = match.trim();
      // Skip common non-name phrases
      if (['The End', 'New York', 'United States'].includes(trimmed)) continue;
      if (!this.entityCodes.has(trimmed.toLowerCase())) {
        names.push(trimmed);
      }
    }

    return names;
  }

  /**
   * Detect AAAK flags from drawer metadata and content.
   */
  private detectFlags(drawer: MemoryDrawer): AAAKFlag[] {
    const flags: AAAKFlag[] = [];
    const meta = drawer.metadata;

    if (meta.importance >= 0.8) flags.push('CORE');
    if (meta.tags?.includes('sensitive') || meta.tags?.includes('private')) flags.push('SENSITIVE');
    if (meta.decisionId) flags.push('DECISION');
    if (meta.tags?.includes('technical')) flags.push('TECHNICAL');

    // Check content for pivot/origin markers
    const content = drawer.content.toLowerCase();
    if (content.includes('first time') || content.includes('started') || content.includes('began')) {
      flags.push('GENESIS');
    }
    if (content.includes('changed') || content.includes('switched') || content.includes('pivoted')) {
      flags.push('PIVOT');
    }

    return flags;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
