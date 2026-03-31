import type { PatternRepositoryPort } from '@skytwin/twin-model';
import type { BehavioralPattern, CrossDomainTrait } from '@skytwin/shared-types';
import { patternRepository } from '../repositories/pattern-repository.js';

/**
 * Adapter bridging PatternRepositoryPort to the concrete patternRepository.
 *
 * The concrete repository already uses the same method names and domain types
 * as the port, so this is a thin passthrough.
 */
export class PatternRepositoryAdapter implements PatternRepositoryPort {
  async getPatterns(userId: string): Promise<BehavioralPattern[]> {
    return patternRepository.getPatterns(userId);
  }

  async upsertPattern(userId: string, pattern: BehavioralPattern): Promise<BehavioralPattern> {
    return patternRepository.upsertPattern(userId, pattern);
  }

  async getTraits(userId: string): Promise<CrossDomainTrait[]> {
    return patternRepository.getTraits(userId);
  }

  async upsertTrait(userId: string, trait: CrossDomainTrait): Promise<CrossDomainTrait> {
    return patternRepository.upsertTrait(userId, trait);
  }
}
