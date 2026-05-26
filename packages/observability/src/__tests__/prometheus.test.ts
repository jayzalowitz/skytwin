/**
 * Tests for the Prometheus exposition formatter (#392).
 *
 * Spec reference: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * If a change here ever breaks `promtool check metrics` on the
 * output, the scrape will silently start dropping our metrics in
 * production. The string-shape assertions are deliberately
 * brittle — better a unit-test failure than a missing dashboard.
 */
import { describe, it, expect } from 'vitest';
import { formatPrometheus, PROMETHEUS_CONTENT_TYPE } from '../prometheus.js';

describe('formatPrometheus', () => {
  it('renders the minimum gauge shape with HELP + TYPE + value + trailing newline', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_db_pool_total',
        type: 'gauge',
        help: 'Total connections in the pg pool',
        samples: [{ value: 20 }],
      },
    ]);
    expect(out).toBe(
      '# HELP skytwin_db_pool_total Total connections in the pg pool\n' +
        '# TYPE skytwin_db_pool_total gauge\n' +
        'skytwin_db_pool_total 20\n',
    );
  });

  it('emits the spec-required Content-Type constant', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('appends `unit` to the metric name once per series (HELP, TYPE, every sample)', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_process_uptime',
        type: 'gauge',
        unit: 'seconds',
        help: 'Process uptime',
        samples: [{ value: 12.5 }],
      },
    ]);
    expect(out).toContain('# HELP skytwin_process_uptime_seconds');
    expect(out).toContain('# TYPE skytwin_process_uptime_seconds gauge');
    expect(out).toContain('skytwin_process_uptime_seconds 12.5');
    // The bare (un-suffixed) name MUST NOT appear — a scraper would
    // see two distinct series otherwise.
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines.every((l) => !/skytwin_process_uptime\b(?!_seconds)/.test(l))).toBe(true);
  });

  it('renders labels in alphabetical order with proper escaping', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_circuit_breaker_state',
        type: 'gauge',
        help: 'Per-user circuit breaker state',
        samples: [
          {
            // Out-of-order keys intentionally — formatter must sort
            // them so diffs across scrapes stay stable.
            labels: { user: 'u-1', provider: 'google', state: 'open' },
            value: 1,
          },
        ],
      },
    ]);
    expect(out).toContain(
      'skytwin_circuit_breaker_state{provider="google",state="open",user="u-1"} 1',
    );
  });

  it('escapes backslash, double-quote, and newline in label values per spec', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_x',
        type: 'gauge',
        help: 'h',
        samples: [
          {
            labels: { msg: 'a\\b"c\nd' },
            value: 1,
          },
        ],
      },
    ]);
    expect(out).toContain('skytwin_x{msg="a\\\\b\\"c\\nd"} 1');
  });

  it('skips undefined and null label values rather than rendering "undefined"', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_x',
        type: 'gauge',
        help: 'h',
        samples: [
          {
            labels: { kept: 'yes', dropped: undefined, also_dropped: null },
            value: 1,
          },
        ],
      },
    ]);
    expect(out).toContain('skytwin_x{kept="yes"} 1');
    expect(out).not.toContain('dropped');
  });

  it('omits the {…} block entirely when there are no usable labels', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_x',
        type: 'gauge',
        help: 'h',
        samples: [{ labels: { dropped: undefined }, value: 1 }],
      },
    ]);
    expect(out).toContain('skytwin_x 1');
    expect(out).not.toContain('skytwin_x{');
  });

  it('renders NaN, +Inf, and -Inf per Prometheus rules', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_x',
        type: 'gauge',
        help: 'h',
        samples: [
          { labels: { kind: 'nan' }, value: Number.NaN },
          { labels: { kind: 'pos_inf' }, value: Number.POSITIVE_INFINITY },
          { labels: { kind: 'neg_inf' }, value: Number.NEGATIVE_INFINITY },
        ],
      },
    ]);
    expect(out).toContain('skytwin_x{kind="nan"} NaN');
    expect(out).toContain('skytwin_x{kind="pos_inf"} +Inf');
    expect(out).toContain('skytwin_x{kind="neg_inf"} -Inf');
  });

  it('handles multiple metrics in one render pass', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_a',
        type: 'counter',
        help: 'A',
        samples: [{ value: 1 }],
      },
      {
        name: 'skytwin_b',
        type: 'gauge',
        help: 'B',
        samples: [{ value: 2 }],
      },
    ]);
    // Each metric gets its own HELP + TYPE header — the scraper
    // rejects a series whose declared TYPE was never emitted.
    expect(out.match(/# HELP/g)).toHaveLength(2);
    expect(out.match(/# TYPE/g)).toHaveLength(2);
    expect(out).toContain('skytwin_a 1');
    expect(out).toContain('skytwin_b 2');
  });

  it('escapes backslash + newline in HELP text', () => {
    const out = formatPrometheus([
      {
        name: 'skytwin_x',
        type: 'gauge',
        help: 'line1\nline2 with \\ backslash',
        samples: [{ value: 1 }],
      },
    ]);
    expect(out).toContain('# HELP skytwin_x line1\\nline2 with \\\\ backslash');
  });

  it('outputs an empty payload (just trailing newline) when given no metrics', () => {
    expect(formatPrometheus([])).toBe('\n');
  });
});
