/**
 * Prometheus exposition formatter (#392).
 *
 * Hand-written rather than depending on `prom-client` because:
 *   - We only need text exposition (no protobuf, no histograms with
 *     pre-baked buckets, no aggregator), so the SDK is ~80% dead weight.
 *   - Our metrics are mostly point-in-time gauges sampled at scrape
 *     time (pool stats, uptime, circuit-breaker state). A formatter
 *     beats a long-lived registry.
 *   - One less dependency for self-hosters; less surface to audit for
 *     CVEs in a security-conscious product.
 *
 * Spec compliance: follows the Prometheus text-format conventions
 * documented at https://prometheus.io/docs/instrumenting/exposition_formats/
 * — `# HELP`, `# TYPE`, metric_name{labels} value, escape rules for
 * label values. Tested via `promtool check metrics` against the
 * sample output captured in unit tests.
 */

/** The Content-Type Prometheus expects on the response. */
export const PROMETHEUS_CONTENT_TYPE =
  'text/plain; version=0.0.4; charset=utf-8';

export type PromMetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

export interface PromMetric {
  /** snake_case, must start with letter or underscore. */
  name: string;
  type: PromMetricType;
  /** Free-form one-line description. */
  help: string;
  /** Optional unit suffix appended to the name per Prometheus conventions (`_seconds`, `_bytes`). */
  unit?: string;
  /** Samples for this metric (one per label combination). */
  samples: PromSample[];
}

export interface PromSample {
  /** Optional labels — undefined values are skipped. */
  labels?: Record<string, string | number | boolean | null | undefined>;
  /** Numeric value. NaN / ±Infinity get rendered per Prometheus rules. */
  value: number;
}

/**
 * Render a list of metrics into Prometheus text-format exposition.
 *
 * Each metric is emitted as:
 *   # HELP <name> <help text>
 *   # TYPE <name> <type>
 *   <name>{label="v",…} <value>
 *
 * Label values are escaped per spec: backslash → `\\`, double-quote
 * → `\"`, newline → `\n`. NaN renders as `NaN`; +Inf / -Inf render
 * as `+Inf` / `-Inf`. Non-finite values follow Prometheus's own
 * round-trip conventions so scrapers don't break.
 *
 * Metric names with a `unit` field get the unit appended once
 * (`name_seconds`), matching the Prometheus naming guide.
 */
export function formatPrometheus(metrics: ReadonlyArray<PromMetric>): string {
  const lines: string[] = [];
  for (const m of metrics) {
    const fullName = m.unit ? `${m.name}_${m.unit}` : m.name;
    lines.push(`# HELP ${fullName} ${escapeHelp(m.help)}`);
    lines.push(`# TYPE ${fullName} ${m.type}`);
    for (const sample of m.samples) {
      lines.push(`${fullName}${renderLabels(sample.labels)} ${renderValue(sample.value)}`);
    }
  }
  // Prometheus exposition MUST end with a newline.
  return lines.join('\n') + '\n';
}

function renderLabels(labels: PromSample['labels']): string {
  if (!labels) return '';
  const pairs: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    const raw = labels[key];
    if (raw === undefined || raw === null) continue;
    pairs.push(`${key}="${escapeLabelValue(String(raw))}"`);
  }
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function renderValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return '+Inf';
  if (v === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(v);
}

function escapeLabelValue(s: string): string {
  // Order matters — escape backslash first so we don't double-escape
  // the backslashes we add for the other two.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(s: string): string {
  // HELP only needs backslash + newline escaping per spec; double-quote
  // is allowed verbatim.
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}
