/**
 * Signal topic clustering for the digest (#spec 04, #477).
 *
 * Groups the briefing's awareness signals into named topic clusters scoped to
 * life domains, for the "Topics to catch up on" section (spec 01). Clusters
 * anchor to the user's KNOWN domains (from domain-extraction) when one fits, so
 * SkyTwin beats the reference product's mis-filing — only genuine no-fit signals
 * land in "More updates".
 *
 * Ships the deterministic fallback (group by the domain already tagged on each
 * signal); an LLM strategy can layer on via `ClusterStrategy`. Pure + testable.
 */

export interface ClusterSignal {
  ref: string;
  domain: string | null;
  subject?: string;
  summary?: string;
}

export interface TopicCluster {
  domain: string;
  title: string;
  signalRefs: string[];
  confidence: number;
}

export interface ClusterOptions {
  /** Known life domains (from domain-extraction) to anchor clusters to. */
  knownDomains?: string[];
  /** Hard cap on cluster count (default 8). Overflow merges into "More updates". */
  maxClusters?: number;
  /** Optional callback when overflow merging happens (caller logs it). */
  onMerge?: (mergedDomains: string[]) => void;
}

export interface ClusterStrategy {
  cluster(signals: ClusterSignal[], opts: ClusterOptions): TopicCluster[];
}

const OTHER_DOMAIN = 'other';
const OTHER_TITLE = 'More updates';

function titleFor(domain: string): string {
  if (domain === OTHER_DOMAIN) return OTHER_TITLE;
  return domain.charAt(0).toUpperCase() + domain.slice(1).replace(/[_-]+/g, ' ');
}

/**
 * Deterministically cluster signals by their tagged domain, anchored to
 * `knownDomains`. Guarantees: every signal appears in exactly one cluster;
 * output length never exceeds `maxClusters` (overflow merges into "More
 * updates"); a signal whose domain is a known domain is never placed in "other".
 */
export function clusterSignals(
  signals: ClusterSignal[],
  opts: ClusterOptions = {},
  strategy?: ClusterStrategy,
): TopicCluster[] {
  if (strategy) return strategy.cluster(signals, opts);

  const known = new Set(opts.knownDomains ?? []);
  const maxClusters = Math.max(1, opts.maxClusters ?? 8);

  // Bucket by domain (anchored to known domains; else "other").
  const buckets = new Map<string, string[]>();
  for (const s of signals) {
    const fits = s.domain && (known.size === 0 || known.has(s.domain));
    const key = fits ? (s.domain as string) : OTHER_DOMAIN;
    const arr = buckets.get(key) ?? [];
    arr.push(s.ref);
    buckets.set(key, arr);
  }

  let clusters: TopicCluster[] = [...buckets.entries()].map(([domain, refs]) => ({
    domain,
    title: titleFor(domain),
    signalRefs: refs,
    confidence: domain === OTHER_DOMAIN ? 0.5 : 0.9,
  }));

  // Cap: keep the largest (maxClusters - 1) named clusters, merge the rest +
  // any existing "other" into a single "More updates" cluster.
  if (clusters.length > maxClusters) {
    clusters.sort((a, b) => b.signalRefs.length - a.signalRefs.length);
    const keep = clusters.slice(0, maxClusters - 1).filter((c) => c.domain !== OTHER_DOMAIN);
    const overflow = clusters.filter((c) => !keep.includes(c));
    const mergedRefs = overflow.flatMap((c) => c.signalRefs);
    const mergedDomains = overflow.map((c) => c.domain).filter((d) => d !== OTHER_DOMAIN);
    if (opts.onMerge && mergedDomains.length > 0) opts.onMerge(mergedDomains);
    clusters = [
      ...keep,
      { domain: OTHER_DOMAIN, title: OTHER_TITLE, signalRefs: mergedRefs, confidence: 0.5 },
    ];
  }

  return clusters;
}
