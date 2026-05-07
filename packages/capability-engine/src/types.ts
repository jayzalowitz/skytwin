import type { RegistryClient } from '@skytwin/registry-client';

export interface SignalMention {
  registryId: string;
  signalId: string;
  signalKind: 'email' | 'calendar' | 'fs' | 'browser_history' | 'graph_triple';
  excerpt: string;
  occurredAt: Date;
}

export interface EvidenceSource {
  kind: SignalMention['signalKind'];
  ref: string;
  excerpt: string;
  at: string;
}

export interface AppSuggestionInput {
  userId: string;
  registryId: string;
  displayName: string;
  evidenceCount: number;
  evidenceSources: EvidenceSource[];
  evidenceKindsDistinct: number;
  firstEvidenceAt: Date;
  lastEvidenceAt: Date;
  confidenceScore: number;
  reasonSummary: string;
}

export interface InferenceEngineOptions {
  registry: RegistryClient;
  surfacingThreshold?: { evidenceCount: number; kindsDistinct: number };
}

export interface SignalLike {
  id: string;
  kind: SignalMention['signalKind'];
  excerpt: string;
  occurredAt: Date;
}
