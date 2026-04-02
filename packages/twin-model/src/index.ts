export { TwinService, type TwinRepositoryPort, type PatternRepositoryPort } from './twin-service.js';
export {
  InferenceEngine,
  type ContradictionReport,
  type Contradiction,
} from './inference-engine.js';
export { PreferenceArchaeologist } from './preference-archaeologist.js';
export { CrossDomainCorrelator } from './cross-domain-correlator.js';
export {
  PreferenceEvolutionTracker,
  type PreferenceHistoryRepositoryPort,
  type PreferenceHistoryEntry,
  type PreferenceHistoryInput,
  type EvolutionSummary,
} from './preference-evolution.js';
export type { TwinExport } from '@skytwin/shared-types';
