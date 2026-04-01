# Issue 011: Build Execution Router

**Status:** Not started
**Milestone:** Phase 2A
**Estimate:** 2-3 days (human) / 20 min (CC)
**Depends on:** Phase 1 migrations (adapter_used column)
**CEO Review Decision:** #1 — New @skytwin/execution-router package

## Goal

Create a new `@skytwin/execution-router` package that selects the appropriate execution adapter (IronClaw, OpenClaw, Direct) based on action risk level, skill availability, and credential requirements. Includes adapter risk modifiers and skill gap detection.

## Scope

### In scope
- New package: `packages/execution-router/`
- `ExecutionRouter` class with adapter selection logic
- `OpenClawAdapter` implementing the same interface as IronClawAdapter (mock-first)
- Adapter trust characteristics declaration (reversibility_guarantee, auth_model, audit_trail)
- Risk modifier system: less-trusted adapters get +1 risk tier bump for irreversible actions
- Fallback chains: IronClaw → OpenClaw → Direct for low-risk
- Skill gap detection: when no adapter can handle an action, log to skill_gap_log table
- Skill gap → IronClaw issue creation pipeline (Phase 4, stub here)

### Out of scope
- Real OpenClaw API integration (mock-first per risk mitigation)
- Actual IronClaw issue creation (stub the interface)

## Implementation

```
packages/execution-router/
  src/
    execution-router.ts    # Router with adapter selection + fallback
    openclaw-adapter.ts    # Mock OpenClaw adapter
    adapter-registry.ts    # Register adapters with trust characteristics
    risk-modifier.ts       # Apply risk adjustments per adapter
    skill-gap-logger.ts    # Detect and log skill gaps
    types.ts               # AdapterTrustProfile, RoutingDecision, SkillGap
    index.ts
  __tests__/
    execution-router.test.ts
    risk-modifier.test.ts
  package.json
  tsconfig.json
```

### AdapterTrustProfile
```typescript
interface AdapterTrustProfile {
  name: string;
  reversibilityGuarantee: 'full' | 'partial' | 'none';
  authModel: 'hmac' | 'oauth' | 'none';
  auditTrail: boolean;
  riskModifier: number; // 0 = no change, 1 = +1 tier bump
}
```

### Routing Logic
1. Get all registered adapters that can handle the action type
2. Filter by credential availability
3. Sort by trust profile (prefer IronClaw > Direct > OpenClaw for high-risk)
4. Apply risk modifier from selected adapter
5. If no adapter can handle: log skill gap, return escalation

## Success Criteria
1. Router selects IronClaw for high-risk credentialed actions
2. Router falls back to Direct for low-risk local actions
3. Router applies +1 risk tier for OpenClaw irreversible actions
4. Skill gap logged when no handler exists
5. All tests pass
