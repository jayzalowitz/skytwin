# SkyTwin TODOs

Generated from CEO review on 2026-04-01. See `planning/milestone-1.5-scope-expansion.md` for full context.

## Phase 1: Foundation Migrations
- [ ] Issue 018: Run all schema migrations (signals, preference_proposals, twin_exports, skill_gap_log, proactive_scans, briefings tables + column additions)

## Phase 2: Core Capabilities (parallel tracks)

### Track A: Execution Router
- [ ] Issue 011: Create @skytwin/execution-router package
- [ ] Issue 011: ExecutionRouter with adapter selection logic
- [ ] Issue 011: OpenClawAdapter (mock-first)
- [ ] Issue 011: Adapter trust characteristics + risk modifier
- [ ] Issue 011: Fallback chains
- [ ] Issue 011: Skill gap detection + logging

### Track B: Twin Query API
- [ ] Issue 012: whatWouldIDo() in decision-engine
- [ ] Issue 012: POST /api/v1/twin/:userId/ask endpoint
- [ ] Issue 012: Token-scoped rate limiting
- [ ] Issue 012: Prediction logging (type='prediction')

### Track C: Twin Export
- [ ] Issue 013: Export function in twin-model (JSON + Markdown)
- [ ] Issue 013: GET /api/v1/twin/:userId/export endpoint
- [ ] Issue 013: twin_exports audit logging

## Phase 3: Higher-Order Features

### Track A: Proactive Mode
- [ ] Issue 014: ProactiveEvaluator in decision-engine
- [ ] Issue 014: Morning briefing generation
- [ ] Issue 014: GET /api/v1/briefings/:userId endpoint
- [ ] Issue 014: Worker cron integration
- [ ] Issue 014: HIGH confidence requirement for proactive auto-execution

### Track B: Preference Archaeology
- [ ] Issue 015: PreferenceArchaeologist analyzer
- [ ] Issue 015: GET/POST /api/v1/preferences/:userId/proposals endpoints
- [ ] Issue 015: Accept → create Preference, Reject → negative signal

### Track C: Undo-with-Learning
- [ ] Issue 016: Extended feedback with undo reasoning
- [ ] Issue 016: Rollback trigger via ExecutionRouter
- [ ] Issue 016: 2x weight correction to twin model

## Phase 4: Integration
- [ ] Issue 017: Signal persistence + retention cleanup
- [ ] Issue 017: Cross-domain correlation rules (at least 2)
- [ ] Issue 011: Skill gap → IronClaw issue creation pipeline
- [ ] Golden path e2e integration test

## Phase 5: Polish
- [ ] Rate limiting implementation
- [ ] Briefing schedule configuration
- [ ] Dashboard updates
- [ ] Export format refinements
