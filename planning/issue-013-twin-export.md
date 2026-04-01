# Issue 013: Twin Export + Portability

**Status:** Not started
**Milestone:** Phase 2C
**Estimate:** 0.5-1 day (human) / 10 min (CC)
**Depends on:** None (all dependencies exist)
**CEO Review Decision:** Scope item #6

## Goal

Enable users to export their complete twin profile as portable JSON or Markdown. Reinforces user sovereignty — your twin data is yours.

## Scope

### In scope
- Export function in `@skytwin/twin-model`
- Serializes: profile, preferences, inferences, patterns, traits, temporal profile
- JSON format (machine-readable, re-importable)
- Markdown format (human-readable)
- GET `/api/v1/twin/:userId/export?format=json|markdown` endpoint
- `twin_exports` audit table (who exported, when, what format)

### Out of scope
- Import from export (future issue)
- Export scheduling / automatic backups

## Implementation

```typescript
// In twin-model
export async function exportTwin(
  userId: string,
  format: 'json' | 'markdown'
): Promise<TwinExport> {
  const profile = await twinService.getOrCreateProfile(userId);
  const patterns = await twinService.getPatterns(userId);
  const traits = await twinService.getTraits(userId);
  const temporal = await twinService.getTemporalProfile(userId);
  // ... serialize to requested format
}
```

## Success Criteria
1. JSON export contains all twin data and is valid JSON
2. Markdown export is human-readable with sections for each data type
3. Export audit logged to twin_exports table
4. Endpoint returns correct content-type headers
