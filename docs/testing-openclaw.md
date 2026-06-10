# Testing the OpenClaw execution adapter (safely)

How to exercise SkyTwin's OpenClaw execution adapter end-to-end without any real
external side effects (no real Gmail/Calendar, no touching a running demo API).

## What OpenClaw is, in this repo

- `@skytwin/execution-router` exposes `OpenClawAdapter`
  (`packages/execution-router/src/openclaw-adapter.ts`). It implements the
  `IronClawAdapter` interface and talks to an OpenClaw **server** over HTTP:
  `POST {apiUrl}/execute`, `POST {apiUrl}/rollback`, `GET {apiUrl}/health`,
  `GET {apiUrl}/status/{planId}`.
- `apps/openclaw-bridge/server.mjs` is a tiny reference OpenClaw server. It
  bridges those endpoints to a **local Ollama** instance — it asks the model to
  *reason about* an action and returns a simulated result. It never sends a real
  email, books a real event, etc. That makes it the safe target for live tests.
- The adapter makes **real HTTP calls** to whatever `apiUrl` you give it. Point
  it at the bridge (local Ollama) and nothing real is touched. There is **no
  built-in mock/dry-run** for OpenClaw — with no `apiUrl`, `execute()` *throws*
  and `healthCheck()` reports unhealthy (by design — never silently succeeds).
  Contrast IronClaw, which has `USE_MOCK_IRONCLAW=true`.

## Config wiring (exact)

`packages/config/src/index.ts`:

- `OPENCLAW_API_URL` -> `config.openclawApiUrl` (default `''`)
- `OPENCLAW_API_KEY` -> `config.openclawApiKey` (default `''`, optional; sent as
  `Authorization: Bearer <key>` when present)

`apps/api/src/execution-setup.ts` (`resolveOpenClawConfig` + `createExecutionRouter`):

- The DB `serviceCredentialRepository` row for service `openclaw`
  (`api_url`, `api_key`) **overrides** the env values.
- OpenClaw is registered **only if** a non-empty `apiUrl` resolves. Otherwise you
  get the log line: `OpenClaw not configured (no URL) — skipping`.
- The bridge's default port is **3456** (`server.mjs`, `package.json` dev/start
  scripts). `bin/skytwin-dev` and the root `package.json dev` script both default
  `OPENCLAW_API_URL=http://localhost:3456`, i.e. the API expects the bridge there.
  (Note: the comment header in `server.mjs` mentions a 4100 default — stale; the
  code default is 3456.)

Bridge env (`apps/openclaw-bridge/server.mjs`):

- `OLLAMA_HOST` (default `http://localhost:11434`)
- `OLLAMA_MODEL` (default `gemma4:latest`)
- `BRIDGE_PORT` (code default `3456`)

## Router selection — important nuance

`packages/execution-router/src/execution-router.ts`:

```
const BUILTIN_TRUST_RANKING = ['ironclaw', 'direct', 'openclaw'];
```

OpenClaw is **last**. The `direct` adapter is registered with **no skill set**, so
`AdapterRegistry.canHandle('direct', anyAction)` returns `true` for everything.
Result: for any standard action type, the router selects `direct` (or `ironclaw`
if configured) as **primary**, and OpenClaw is only a **fallback** that runs when
the higher-trust adapter *throws* before/at execution.

So to actually see OpenClaw do the work, do one of:

1. **Isolated adapter test (cleanest):** instantiate `OpenClawAdapter` directly and
   call `buildPlan()` + `execute()` against the bridge. No router, no DB.
2. **Router with only OpenClaw registered:** build an `AdapterRegistry`, register
   just `openclaw` with `OPENCLAW_TRUST_PROFILE` + `OPENCLAW_SKILLS`, and route.
3. **Force fallback:** register a primary adapter whose `buildPlan`/`execute`
   throws for the chosen action type, so the router falls through to OpenClaw.

`OPENCLAW_TRUST_PROFILE`: `reversibilityGuarantee: 'none'`, `authModel: 'api_key'`,
`riskModifier: 1` (so irreversible actions get a +1 risk-tier bump under OpenClaw).

## Safe live-test steps (verified working on this machine)

Prereqs (already true here): Ollama installed (`/usr/local/bin/ollama`), running on
`:11434`, with `gemma4:latest` pulled.

```bash
# 0. (only if needed) install + start Ollama and pull a model
#    brew install ollama && ollama serve &  # or: open -a Ollama
#    ollama pull gemma4:latest

# 1. Start the bridge on an ISOLATED port (4199), away from the demo API and
#    away from the default 3456 so it can't be picked up by anything by accident.
cd apps/openclaw-bridge
BRIDGE_PORT=4199 OLLAMA_MODEL=gemma4:latest node server.mjs &
# wait for it to bind, then:
curl -s http://localhost:4199/health        # -> {"status":"ok",...,"modelAvailable":true}

# 2. Fire a FAKE action at /execute (mirrors the exact shape OpenClawAdapter
#    POSTs). Nothing real is touched — the bridge only asks Ollama to reason.
curl -s http://localhost:4199/execute -H 'Content-Type: application/json' -d '{
  "planId": "test_plan_safe_001",
  "decisionId": "test_decision_safe_001",
  "action": {
    "type": "archive_email",
    "description": "Archive a newsletter from test@example.invalid",
    "parameters": { "messageId": "FAKE-MSG-DOES-NOT-EXIST", "userId": "test-user-no-tokens" },
    "domain": "email"
  },
  "steps": [
    { "id": "step_1", "type": "archive_email", "description": "Archive the message",
      "parameters": { "messageId": "FAKE-MSG-DOES-NOT-EXIST" } }
  ]
}'
# -> {"status":"completed","adapter":"openclaw-bridge","model":"gemma4:latest",...,"latencyMs":~19000}

# 3. Rollback (always simulated in bridge mode):
curl -s http://localhost:4199/rollback -H 'Content-Type: application/json' \
  -d '{"planId":"test_plan_safe_001"}'
# -> {"status":"rolled_back",...}

# 4. Clean up
kill %1   # or kill the bridge PID
```

### Optional: full router path against the bridge, via the API

Only do this against a **non-production API instance** (do NOT restart the demo API
on :3110). Start a *separate* API with OpenClaw pointed at the bridge:

```bash
OPENCLAW_API_URL=http://localhost:4199 API_PORT=3120 \
  node apps/api/dist/index.js
```

Then trigger an action through the decision/approval flow for an **isolated,
tokenless test user**. Because `direct` outranks `openclaw`, pick an action type
the direct handlers reject (so the router falls back to OpenClaw), or assert on the
adapter in an isolated unit test (option 1/2 above) instead.

## Safety notes

- The bridge only reaches **local Ollama**. No outbound internet, no Gmail/Calendar.
- Use a **tokenless test user** + **fake message/event IDs** so even the `direct`
  path (if it ever runs) has nothing real to act on.
- Don't reuse the demo API's port (3110) or DB-stored `openclaw` credentials.
- Keep the bridge on an isolated port; tear it down when finished.
