import type { CrossDomainTrait, Inference, BehavioralPattern } from '@skytwin/shared-types';
import { ConfidenceLevel } from '@skytwin/shared-types';

/**
 * Trait definition: what to look for across domains.
 */
interface TraitDefinition {
  name: string;
  description: string;
  detect(inferences: Inference[], patterns: BehavioralPattern[]): {
    found: boolean;
    domains: string[];
    evidenceCount: number;
  };
}

const TRAIT_DEFINITIONS: TraitDefinition[] = [
  {
    name: 'cautious_spender',
    description: 'Consistently rejects or escalates financial actions across domains',
    detect(inferences, patterns) {
      const financialDomains = new Set<string>();
      let count = 0;

      for (const inf of inferences) {
        const val = String(inf.value).toLowerCase();
        if (val.includes('reject') || val.includes('escalat') || val.includes('deny')) {
          if (inf.key.includes('cost') || inf.key.includes('spend') || inf.key.includes('financial')) {
            financialDomains.add(inf.domain);
            count++;
          }
        }
      }

      for (const pat of patterns) {
        if (pat.observedAction.includes('cancel') || pat.observedAction.includes('reject')) {
          if (pat.trigger.domain === 'subscriptions' || pat.trigger.domain === 'shopping' || pat.trigger.domain === 'travel') {
            financialDomains.add(pat.trigger.domain ?? 'unknown');
            count += pat.frequency;
          }
        }
      }

      return { found: financialDomains.size >= 2, domains: Array.from(financialDomains), evidenceCount: count };
    },
  },
  {
    name: 'quick_responder',
    description: 'Responds to urgent items quickly across domains',
    detect(inferences, patterns) {
      const quickDomains = new Set<string>();
      let count = 0;

      for (const pat of patterns) {
        if (pat.patternType === 'temporal' || pat.patternType === 'habit') {
          const meta = pat.metadata as Record<string, unknown>;
          const avgResponse = meta['avgResponseMs'] as number | undefined;
          if (avgResponse !== undefined && avgResponse < 300000) { // < 5 minutes
            quickDomains.add(pat.trigger.domain ?? 'unknown');
            count += pat.frequency;
          }
        }
      }

      for (const inf of inferences) {
        const val = String(inf.value).toLowerCase();
        if (val.includes('immediate') || val.includes('quick') || val.includes('fast')) {
          quickDomains.add(inf.domain);
          count++;
        }
      }

      return { found: quickDomains.size >= 2, domains: Array.from(quickDomains), evidenceCount: count };
    },
  },
  {
    name: 'privacy_conscious',
    description: 'Escalates or rejects actions with privacy implications',
    detect(inferences, patterns) {
      const privacyDomains = new Set<string>();
      let count = 0;

      for (const inf of inferences) {
        const key = inf.key.toLowerCase();
        const val = String(inf.value).toLowerCase();
        if (key.includes('privacy') || key.includes('sharing') || key.includes('data')) {
          if (val.includes('reject') || val.includes('deny') || val.includes('escalat')) {
            privacyDomains.add(inf.domain);
            count++;
          }
        }
      }

      for (const pat of patterns) {
        if (pat.observedAction.includes('reject') || pat.observedAction.includes('deny')) {
          const desc = pat.description.toLowerCase();
          if (desc.includes('privacy') || desc.includes('sharing')) {
            privacyDomains.add(pat.trigger.domain ?? 'unknown');
            count += pat.frequency;
          }
        }
      }

      return { found: privacyDomains.size >= 2, domains: Array.from(privacyDomains), evidenceCount: count };
    },
  },
  {
    name: 'routine_driven',
    description: 'Strong temporal patterns with high consistency',
    detect(_inferences, patterns) {
      const routineDomains = new Set<string>();
      let count = 0;

      for (const pat of patterns) {
        if (pat.patternType === 'habit' && pat.frequency >= 10 &&
            (pat.confidence === ConfidenceLevel.HIGH || pat.confidence === ConfidenceLevel.CONFIRMED)) {
          routineDomains.add(pat.trigger.domain ?? 'unknown');
          count += pat.frequency;
        }
      }

      return { found: routineDomains.size >= 2, domains: Array.from(routineDomains), evidenceCount: count };
    },
  },
  {
    name: 'delegation_averse',
    description: 'Rarely auto-executes even when trust tier allows',
    detect(inferences, _patterns) {
      const averseDomains = new Set<string>();
      let count = 0;

      for (const inf of inferences) {
        const val = String(inf.value).toLowerCase();
        if (val.includes('manual') || val.includes('review') || val.includes('approval')) {
          averseDomains.add(inf.domain);
          count++;
        }
      }

      return { found: averseDomains.size >= 2, domains: Array.from(averseDomains), evidenceCount: count };
    },
  },
];

/**
 * Detects cross-domain traits by analyzing inferences and patterns
 * across multiple domains for consistent behaviors.
 */
export class CrossDomainAnalyzer {
  /**
   * Detect traits from inferences and behavioral patterns.
   * Each trait requires evidence from at least 2 different domains.
   */
  detectTraits(
    inferences: Inference[],
    patterns: BehavioralPattern[],
  ): CrossDomainTrait[] {
    const traits: CrossDomainTrait[] = [];

    for (const definition of TRAIT_DEFINITIONS) {
      const result = definition.detect(inferences, patterns);
      if (!result.found) continue;

      traits.push({
        id: `trait_${definition.name}_${Date.now()}`,
        traitName: definition.name,
        confidence: this.domainCountToConfidence(result.domains.length),
        supportingDomains: result.domains,
        evidenceCount: result.evidenceCount,
        description: definition.description,
      });
    }

    return traits;
  }

  private domainCountToConfidence(domainCount: number): ConfidenceLevel {
    if (domainCount >= 4) return ConfidenceLevel.HIGH;
    if (domainCount >= 3) return ConfidenceLevel.MODERATE;
    return ConfidenceLevel.LOW;
  }
}
