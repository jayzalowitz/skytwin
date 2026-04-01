# Milestone 1.5: Scope Expansion (CEO Review)

**Status:** Not Started
**Generated:** 2026-04-01 via /plan-ceo-review (SCOPE EXPANSION mode)
**Depends on:** [Milestone 0 -- Foundations](./milestone-0-foundations.md) (complete), [Milestone 1 -- Decision Core](./milestone-1-decision-core.md) (complete in code, needs integration test)

## Goal

Expand SkyTwin from a reactive decision pipeline into a proactive personal judgment layer. Seven new capabilities accepted through CEO review, organized into 5 build phases with 13 architecture decisions locked in.

## Build Phases

### Phase 1: Foundation Extensions
| Issue | Title | Estimate |
|-------|-------|----------|
| [018](./issue-018-phase1-migrations.md) | Phase 1 DB Migrations | 0.5 day |

### Phase 2: Core New Capabilities (parallel)
| Issue | Title | Track | Estimate |
|-------|-------|-------|----------|
| [011](./issue-011-execution-router.md) | Execution Router | A | 2-3 days |
| [012](./issue-012-twin-query-api.md) | Twin Query API (whatWouldIDo) | B | 1-2 days |
| [013](./issue-013-twin-export.md) | Twin Export + Portability | C | 0.5-1 day |

### Phase 3: Higher-Order Features
| Issue | Title | Track | Estimate |
|-------|-------|-------|----------|
| [014](./issue-014-proactive-mode.md) | Proactive Mode + Morning Briefing | A | 2-3 days |
| [015](./issue-015-preference-archaeology.md) | Preference Archaeology | B | 1-2 days |
| [016](./issue-016-undo-with-learning.md) | Undo-with-Learning | C | 1 day |

### Phase 4: Integration
| Issue | Title | Estimate |
|-------|-------|----------|
| [017](./issue-017-cross-domain-correlation.md) | Cross-Domain Correlation (time-boxed) | 1 week |
| — | Skill Gap → IronClaw Issues | included in 011 |
| — | Golden Path E2E Test | 1-2 days |

### Phase 5: Polish
- Rate limiting on /ask endpoint
- Briefing schedule configuration
- Dashboard updates
- Export format refinements

## Dependency Graph

```
Phase 1: [018 Migrations] ─────────────────────────────────────────────┐
                                                                        │
Phase 2: [011 Router]──┐   [012 Query API]──┐   [013 Export]           │
         (Track A)     │   (Track B)        │   (Track C)              │
                       │                    │                           │
Phase 3: [014 Proactive]   [015 Archaeology]   [016 Undo]             │
         needs 012     │   needs 018         │   needs 011, 018        │
                       │                    │                           │
Phase 4: [017 Cross-Domain] ◀── needs 018, twin-model                 │
         [Golden Path E2E] ◀── needs all of above                     │
                                                                        │
Phase 5: Polish ◀───────────────────────────────────────────────────────┘
```

## Architecture Decisions

See full CEO plan at `~/.gstack/projects/jayzalowitz-skytwin/ceo-plans/2026-04-01-skytwin-full-build.md`

Key decisions:
1. New `@skytwin/execution-router` package (not in ironclaw-adapter)
2. Proactive evaluator lives in decision-engine (reuses scoring)
3. whatWouldIDo() runs full pipeline, no execution
4. Signals stored in CRDB (memory AI coming)
5. Separate preference_proposals table
6. Undo extends feedback_events (unified stream)
7. Predictions logged with type='prediction'
8. Adapter risk modifiers for OpenClaw
9. Token-scoped rate limiting on /ask
10. Golden path e2e test
11. 5-phase sequencing approved
12. Dashboard-first briefing delivery
13. Three risk mitigations: time-box cross-domain, mock OpenClaw, HIGH confidence for proactive

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Cross-domain scope creep | Time-boxed to 1 week |
| OpenClaw API uncertainty | Mock-first adapter |
| Proactive false positives | Require HIGH confidence for auto-execution |

## Success Criteria

1. whatWouldIDo() returns accurate predictions matching actual system behavior
2. ExecutionRouter correctly selects between IronClaw/OpenClaw/Direct
3. Morning briefing generated and served via dashboard
4. Preference archaeology detects and proposes implicit patterns
5. Undo reasoning captured and fed back to twin model
6. Cross-domain correlation foundation operational (at least 2 rules)
7. Twin export produces valid JSON and readable Markdown
8. Golden path e2e test passes end-to-end
9. All 119+ existing tests still pass
