# Operations — Self-Hosting SkyTwin

This page covers what a self-hosting operator needs day-to-day:
metrics scraping, health checks, log inspection.

## Health Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health/live` | Liveness — the process is up. Returns 200 with the client IP. Use this as an orchestrator's liveness probe. |
| `GET /api/health/ready` | Readiness — process is ready to serve traffic (DB reachable, pool not saturated). Returns 503 when the pg pool has queued callers (`waitingCount > 0`) or when the database is unreachable. Use as an orchestrator's readiness probe. |
| `GET /api/health` | Legacy human-readable health summary. |

## Metrics (`/metrics`)

The API process exposes a Prometheus-compatible scrape endpoint at
`/metrics`. Read-only and unauthenticated — Prometheus scrapers don't
carry sessions. Self-hosters who want auth can put the API behind a
reverse proxy that filters `/metrics` (Caddy, nginx, etc.).

The payload contains zero per-user data — only process-wide aggregates
— so there's nothing to leak.

### Series exposed today

| Metric | Type | Description |
|---|---|---|
| `skytwin_db_pool_total` | gauge | Total connections in the pg pool |
| `skytwin_db_pool_idle` | gauge | Idle connections in the pg pool |
| `skytwin_db_pool_waiting` | gauge | Callers queued waiting for a connection. **This is the canary** for the pool-exhaustion class of bug (#378) — alert on `> 0` for any duration `> 30s`. |
| `skytwin_process_uptime_seconds` | gauge | Process uptime since boot |
| `skytwin_process_heap_used_bytes` | gauge | V8 heap bytes currently in use |
| `skytwin_process_heap_total_bytes` | gauge | V8 heap bytes allocated |
| `skytwin_process_rss_bytes` | gauge | Resident set size of the API process |

### Series planned

Circuit-breaker state per provider, decision rate, signal ingress
rate, and worker poll latency live in the worker process (not the
API). Adding them requires either an IPC bridge from worker to API,
or a separate worker `/metrics` endpoint plus dual scrape config.
Both are tracked as a follow-up — issue your operator-toolchain
needs there determine the path.

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: skytwin
    metrics_path: /metrics
    static_configs:
      - targets: ['localhost:3100']
    scrape_interval: 15s
```

### Verifying with `promtool`

```sh
curl -s http://localhost:3100/metrics | promtool check metrics
```

Output should be empty (no problems). Any line surfaced by promtool
is a wire-format regression — file an issue against
`packages/observability/src/prometheus.ts`.

### Grafana

A minimal starter dashboard JSON is committed to
`docs/grafana/skytwin-overview.json` — import via
`Dashboards → New → Import` in Grafana, paste the JSON, point it at
your Prometheus data source. Tweaks welcome via PR.

Alert recommendations:

| Condition | Why |
|---|---|
| `skytwin_db_pool_waiting > 0` for 30s | Pool is exhausted; every new request will queue or hang. Root cause of the #378 outage class. |
| `rate(skytwin_process_uptime_seconds[5m]) == 0` | Process is crash-looping (uptime resets to 0 on each boot). |
| `skytwin_process_rss_bytes > <limit>` | Memory leak detection — set the limit to ~2× steady-state RSS in your env. |
