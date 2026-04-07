import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeGraph, type KnowledgeGraphRepositoryPort } from '../knowledge-graph.js';
import type { KnowledgeEntity, KnowledgeTriple } from '@skytwin/shared-types';

function createMockRepo(): KnowledgeGraphRepositoryPort {
  const entities: KnowledgeEntity[] = [];
  const triples: KnowledgeTriple[] = [];

  return {
    upsertEntity: vi.fn(async (_userId, name, entityType, properties, aliases) => {
      const existing = entities.find((e) => e.name === name && e.entityType === entityType);
      if (existing) {
        existing.properties = properties;
        existing.aliases = aliases;
        existing.updatedAt = new Date();
        return existing;
      }
      const entity: KnowledgeEntity = {
        id: `ent_${name}`,
        userId: _userId,
        name,
        entityType: entityType as KnowledgeEntity['entityType'],
        properties,
        aliases,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      entities.push(entity);
      return entity;
    }),

    getEntities: vi.fn(async (_userId, entityType) => {
      if (entityType) return entities.filter((e) => e.entityType === entityType);
      return entities;
    }),

    findEntity: vi.fn(async (_userId, name) =>
      entities.find((e) => e.name === name || e.aliases.includes(name)) ?? null,
    ),

    addTriple: vi.fn(async (_userId, subject, predicate, object, validFrom, confidence, sourceDrawerId) => {
      const triple: KnowledgeTriple = {
        id: `triple_${triples.length}`,
        userId: _userId,
        subject,
        predicate,
        object,
        validFrom,
        validTo: null,
        confidence,
        sourceDrawerId,
        extractedAt: new Date(),
      };
      triples.push(triple);
      return triple;
    }),

    queryTriples: vi.fn(async (_userId, options) => {
      let result = triples.filter((t) => t.userId === _userId);
      if (options?.subject) result = result.filter((t) => t.subject === options.subject);
      if (options?.predicate) result = result.filter((t) => t.predicate === options.predicate);
      if (options?.object) result = result.filter((t) => t.object === options.object);
      if (options?.asOf) {
        result = result.filter((t) =>
          t.validFrom <= options.asOf! && (t.validTo === null || t.validTo > options.asOf!),
        );
      }
      return result.slice(0, options?.limit ?? 100);
    }),

    invalidateTriple: vi.fn(async (tripleId, validTo) => {
      const triple = triples.find((t) => t.id === tripleId);
      if (triple) triple.validTo = validTo ?? new Date();
    }),
  };
}

describe('KnowledgeGraph', () => {
  let repo: KnowledgeGraphRepositoryPort;
  let kg: KnowledgeGraph;

  beforeEach(() => {
    repo = createMockRepo();
    kg = new KnowledgeGraph(repo);
  });

  describe('recordEntity', () => {
    it('should create an entity', async () => {
      const entity = await kg.recordEntity('user1', 'Alice Chen', 'person', { role: 'colleague' });
      expect(entity.name).toBe('Alice Chen');
      expect(entity.entityType).toBe('person');
      expect(entity.properties).toEqual({ role: 'colleague' });
    });
  });

  describe('recordFact', () => {
    it('should create a temporal triple', async () => {
      const triple = await kg.recordFact('user1', 'Alice', 'works_at', 'Acme Corp');
      expect(triple.subject).toBe('Alice');
      expect(triple.predicate).toBe('works_at');
      expect(triple.object).toBe('Acme Corp');
      expect(triple.validTo).toBeNull();
    });

    it('should invalidate old fact when recording a new one with same subject+predicate', async () => {
      await kg.recordFact('user1', 'Alice', 'works_at', 'Acme Corp');
      await kg.recordFact('user1', 'Alice', 'works_at', 'NewCo');

      expect(repo.invalidateTriple).toHaveBeenCalledOnce();
    });

    it('should not invalidate if the object is the same', async () => {
      await kg.recordFact('user1', 'Alice', 'works_at', 'Acme Corp');
      await kg.recordFact('user1', 'Alice', 'works_at', 'Acme Corp');

      expect(repo.invalidateTriple).not.toHaveBeenCalled();
    });
  });

  describe('queryEntity', () => {
    it('should return facts about an entity at a point in time', async () => {
      await kg.recordFact('user1', 'Alice', 'works_at', 'Acme Corp');
      await kg.recordFact('user1', 'Alice', 'lives_in', 'SF');

      const facts = await kg.queryEntity('user1', 'Alice');
      expect(facts.length).toBe(2);
    });
  });

  describe('getTimeline', () => {
    it('should return all facts for an entity over time', async () => {
      await kg.recordFact('user1', 'Project X', 'status', 'planning');
      await kg.recordFact('user1', 'Project X', 'status', 'active');

      const timeline = await kg.getTimeline('user1', 'Project X');
      expect(timeline.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('extractEntitiesFromText', () => {
    it('should extract capitalized names as person entities', () => {
      const entities = kg.extractEntitiesFromText('Alice Chen sent a message to Bob Smith about the project.');
      const names = entities.map((e) => e.name);
      expect(names).toContain('Alice Chen');
      expect(names).toContain('Bob Smith');
    });

    it('should extract email domains as organizations', () => {
      const entities = kg.extractEntitiesFromText('Got an email from team@acme.com about the deadline.');
      const orgs = entities.filter((e) => e.entityType === 'organization');
      expect(orgs.length).toBeGreaterThanOrEqual(1);
      expect(orgs[0]!.name).toBe('acme.com');
    });

    it('should skip common sentence starters', () => {
      const entities = kg.extractEntitiesFromText('The Quick Brown Fox jumped over.');
      const names = entities.map((e) => e.name);
      expect(names).not.toContain('The Quick Brown');
    });
  });
});
