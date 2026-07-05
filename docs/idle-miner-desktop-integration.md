# Idle-miner → desktop integration (build-ready spec)

Status: **not yet wired.** `@skytwin/idle-miner` (`startIdleMiner`, #201) and the desktop
`IdleBridge` (#239) both exist, but nothing calls `startIdleMiner` from the desktop.
This doc front-loads the design decisions an implementer needs so the wiring is a
single focused PR rather than a discovery exercise. It exists because a flag-gated
call alone would be **non-functional dead code** — `startIdleMiner` has hard
dependencies (a signal emitter, two persistence repos, a resolved `userId`) that
don't exist for the desktop yet.

Source of truth: `packages/idle-miner/src/runtime.ts` (`StartIdleMinerOptions`),
`packages/idle-miner/src/miner.ts` (`MinerOptions`), `apps/desktop/src/idle-bridge.ts`.

## Architecture correction (post-build) — it does NOT run in the Electron main process

The "Where it runs" section below was the original assumption and is **wrong**.
Starting the implementation surfaced two hard facts:

1. **`apps/desktop` is a deliberate thin shell with ZERO `@skytwin/*` dependencies,
   compiled as CommonJS** (`apps/desktop/package.json` has no workspace deps;
   `tsconfig.json` is `"module": "commonjs"`). It manages the API / worker /
   CockroachDB as child processes via `ServiceManager` and talks to them over
   HTTP/IPC. Pulling `@skytwin/idle-miner` (an ESM workspace package, plus its
   transitive deps) into the Electron main process would break that boundary. So
   idle-miner cannot run in desktop-main.
2. **The worker is PAUSED exactly when idle-miner would want to run.**
   `IdlePauseController` (`apps/desktop/src/idle-pause-controller.ts`, #382) calls
   `ServiceManager.pause()` — which stops the worker child process — when the user
   goes idle. So idle-miner cannot piggyback the worker either: the worker is dead
   during idle.

**Corrected host: a separately-managed idle-miner child process.** Spawn it from the
desktop's `ServiceManager` the same way `api` / `worker` / `cockroach` are spawned
(the shell owns lifecycle via process spawn, never an in-process import). That
process is ESM, carries the `@skytwin/idle-miner` dep, owns the device-local store,
and is started/stopped on the desktop's idle/active transitions (reuse the same
`IdleBridge` signal the pause controller consumes — but to START mining on idle,
not pause). It is exempt from the idle-pause that stops the *worker*.

**That process is now built: `apps/idle-miner-runner`.** It is the ESM managed
process the desktop spawns. Its logic is fail-closed and unit-tested: `config.ts`
parses + validates the environment the `ServiceManager` passes
(`SKYTWIN_IDLE_MINER_ENABLED` must be `true`; `SKYTWIN_IDLE_MINER_USER_ID` /
`_INGEST_URL` / `_DATA_DIR` required; home from `SKYTWIN_IDLE_MINER_HOME` / `HOME`
/ `USERPROFILE`), and `runner.ts` assembles the miner from the package pieces
(`SnapshotFileStore` at the data dir, `createHttpSignalEmitter` at the ingest URL,
`expandAllowlist`→`FsScanRoot[]`, `DEFAULT_EXTRACTORS`) driven by an
`EventDrivenIdleDetector`. Because a plain Node child has no `powerMonitor`, it
does NOT self-detect idle — the parent writes one control word per line to the
child's **stdin**: `idle` / `active` / `stop`, which the runner relays to the
detector. It shuts down cleanly (SIGTERM/SIGINT/stdin-close → stop miner + flush
index). **Remaining (the desktop side):** `ServiceManager` spawning this process +
piping `IdleBridge` transitions to its stdin + the embedded-build packaging, and
resolving the paired `userId` (persist to a desktop pref on pair). The
`EventDrivenIdleDetector` is exported from `@skytwin/idle-miner`.

**Persistence is now provided.** `@skytwin/idle-miner` ships `SnapshotFileStore`
(`packages/idle-miner/src/snapshot-store.ts`) — a device-local, atomic-snapshot
`FileIndexRepo` + `CursorRepo`, so the host no longer reimplements the repos. Point
it at the child process's data dir. This was the load-bearing, design-heavy piece
(persistence is required, not optional — see "device-local, NOT CockroachDB" below);
it is implemented and unit-tested.

**The emitter is now provided too.** `@skytwin/idle-miner` ships
`createHttpSignalEmitter({ ingestUrl, userId })` and the pure `toIngestEvent`
transform (`packages/idle-miner/src/ingest-adapter.ts`), so the host no longer
hand-writes the filesystem-`RawSignal` → ingest-event mapping. It POSTs with
bounded retry and never throws into the miner loop (a dropped signal is
re-attempted on a later scan). With the store + emitter + `DEFAULT_EXTRACTORS` +
`expandAllowlist` + `ElectronIdleDetector` all package-provided, the only
host-specific work left is the managed process, the resolved `userId`, and the
flag.

The remaining sections describe the dependency assembly (emitter transform, roots,
userId, flag), which all still apply — they just move from "desktop main" into the
managed idle-miner process.

## Where it runs (ORIGINAL ASSUMPTION — superseded by the correction above)

The desktop **Electron main process** (`apps/desktop/src/main.ts`). It has Node, can
`require('electron').powerMonitor` (idle-miner's default `ElectronIdleDetector` uses
it), can reach the local API at `http://localhost:3200`, and can own device-local
storage. The main process already constructs `IdleBridge` (`main.ts:268`) — the new
module hangs off the same idle/active transitions.

## The 8 required `MinerOptions` and how to supply each

All of `MinerOptions` are required (no optionals — `packages/idle-miner/src/miner.ts`):

| Option | Supply with |
|--------|-------------|
| `roots` | `expandAllowlist(os.homedir())` — `DEFAULT_ALLOWLIST_RELATIVE` is Documents/Downloads/Desktop/Projects/Code/dev/src |
| `extractors` | `DEFAULT_EXTRACTORS` (exported) |
| `governor` | default `new ResourceGovernor({})` (via `startIdleMiner`'s `governorOptions`) |
| `idleDetector` | default `ElectronIdleDetector` (omit to use it) |
| `homedir` | `os.homedir()` |
| `signalEmitter` | **new** — transform + POST, see below |
| `fileIndexRepo` | **new** — device-local persistent, see below |
| `cursorRepo` | **new** — device-local persistent, see below |
| `userId` | **resolve** — see below |

### `signalEmitter` — transform, don't pass through

Gotcha: idle-miner's `RawSignal` (`@skytwin/shared-types`: `id/userId/rootId/absPath/
relPath/sizeBytes/mtimeMs/mimeType/contentHash/structuredFields/skippedReason/
extractedAt`) is a **different shape** than the connector `RawSignal` the worker
forwards (`.data/.source/.type`). The ingest endpoint (`apps/api/src/routes/events.ts:188`,
`POST /api/events/ingest`) expects the **event** shape. Mirror the worker's
`forwardSignalToApi` (`apps/worker/src/index.ts:189`) but build the body from the
filesystem signal:

```ts
const body = JSON.stringify({
  source: 'fs',                       // matches signalKindFromRow's 'fs' → kind:'fs'
  type: signal.skippedReason ? 'file_skipped' : 'file_indexed',
  signalId: signal.id,
  userId,
  absPath: signal.absPath,
  relPath: signal.relPath,
  mimeType: signal.mimeType,
  contentHash: signal.contentHash,
  ...signal.structuredFields,         // package.json name, git remote, etc.
});
// POST http://localhost:3200/api/events/ingest with withRetry (mirror forwardSignalToApi)
```

`capability-inference.ts:34` already maps `source: 'fs'` → `kind: 'fs'`, so fs signals
flow through the capability path once ingested. Confirm `/api/events/ingest` accepts an
`fs` source (it dispatches by `source`/`type`); add the `fs` source case if missing —
that is part of this PR's scope.

### `fileIndexRepo` + `cursorRepo` — device-local, NOT CockroachDB

These track "which files on **this machine** have I already scanned, and where did the
last scan stop" (`FileIndexRepo.lookup/upsert`, `CursorRepo.load/save` —
`packages/idle-miner/src/types.ts`). That is **device-local** state: a second paired
device has different files. Putting it in the shared CRDB would let one device's index
suppress scans on another. So this is the one idle-miner store that deliberately does
**not** follow the "CockroachDB as source of truth" rule.

Persistence is **load-bearing, not an optimization**: the ingest pipeline has no
content dedup (verified — `events.ts:188` does not dedup by `signalId`/`contentHash`),
and the allowlist spans thousands of files. With in-memory repos, **every desktop
restart re-emits every file** as a new signal, flooding the decision pipeline. So an
in-memory first cut is not acceptable even behind the flag.

Recommended mechanism: a small device-local store in Electron `userData`
(`app.getPath('userData')`). Options, in order of preference:
1. **better-sqlite3** if already a desktop dep (check `apps/desktop/package.json`) —
   two tables keyed by `(rootId, relativePath)` and `(rootId)`. Cheap per-upsert.
2. A keyed store with **debounced snapshot-to-disk** (Map + write-behind every N
   upserts / M seconds). Simpler, fine for bounded counts, risks losing the last
   window's index on a hard crash (acceptable — worst case is a re-scan of that window).

Whichever: it implements the two interfaces verbatim and is unit-tested against a temp
dir.

### `userId` — the missing plumbing

The Electron **main** process does not currently track the paired user — `userId`
reaches main only as an IPC argument from the renderer (the vault handlers,
`main.ts:399+`). Idle mining runs without a renderer in focus, so it needs main to know
the user independently. Resolve it by one of:
1. Persist the active `userId` to a desktop preference (`desktop-preferences.ts`) when
   the renderer authenticates / pairs, and read it in main. **Preferred** — explicit,
   testable.
2. Query the local API for the single active user on a single-user install
   (`GET /api/users` → first/only id). Acceptable as a fallback; brittle for multi-user.

Until a `userId` is resolved, the miner must **not** start (log once, stay inert) — the
same fail-closed posture as the draft-email per-user gate.

## Flag + wiring

- Flag `SKYTWIN_IDLE_MINER_ENABLED`, **default off** (mirror `SKYTWIN_DRAFTS_ENABLED` /
  `SKYTWIN_CAPABILITY_INFERENCE_ENABLED`). It scans the user's real filesystem, so it
  must never run without explicit opt-in.
- New module `apps/desktop/src/idle-miner-runtime.ts`: assembles the options above,
  exposes `start(userId)` / `stop()`, holds the `IdleMinerHandle`. (Idle-miner has its
  own `ElectronIdleDetector`, so it self-gates on idle; the desktop just needs to
  construct it once the flag is on and a `userId` is known, and `stop()` on quit.)
- In `main.ts`: when the flag is on and a `userId` resolves, construct the runtime after
  services are healthy; `handle.stop()` in the existing `idleBridge?.stop()` teardown
  (`main.ts:521`). Decision of whether to *also* gate scanning on `IdleBridge` state vs.
  rely solely on `ElectronIdleDetector` is an open item below.

## Test plan

- `signalEmitter`: a filesystem `RawSignal` → the exact ingest body (source `fs`, type
  by `skippedReason`, structuredFields spread); ret/non-retryable status handling
  (mirror the worker's `forwardSignalToApi` tests).
- repos: round-trip `upsert`→`lookup` and `save`→`load` against a temp `userData`;
  survives a simulated process restart (new instance, same dir, index intact → no
  re-emit).
- flag gate: off by default; miner not constructed when off or when `userId` unresolved.
- `/api/events/ingest`: accepts an `fs`-source event and produces an fs-kind signal.

## Open design decisions (resolve in the PR)

1. **better-sqlite3 vs snapshot store** — pick per what the desktop already bundles.
2. **Double idle gate** — rely on idle-miner's `ElectronIdleDetector` alone, or also
   pause when `IdleBridge` reports `active`? They use the same `powerMonitor`; running
   both is redundant but lets the desktop apply its own thresholds.
3. **`fs` source in the decision pipeline** — confirm/extend that `/api/events/ingest`
   and the situation interpreter handle an `fs` source end-to-end (capability inference
   already does; the core decision path may treat it as low-signal).
