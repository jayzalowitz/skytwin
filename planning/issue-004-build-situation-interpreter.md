# Issue 004: Build the Situation Interpreter

**Milestone:** [M1 -- Decision Core](./milestone-1-decision-core.md)
**Priority:** P0 (blocking decision engine)
**Estimate:** 2-3 days
**Assignee:** TBD
**Labels:** `decision-engine`, `interpretation`, `M1`
**Depends on:** [Issue 001](./issue-001-bootstrap-repo.md), [Issue 002](./issue-002-define-core-schemas.md)

## Problem

Raw events arrive in varied formats -- an email notification has different fields than a calendar conflict or a subscription renewal notice. The decision engine needs structured, typed `DecisionObject`s to reason about. Something must transform raw event payloads into a normalized representation that the rest of the pipeline can consume.

## Why It Matters

The situation interpreter is the front door of the decision pipeline. If it misclassifies an urgent email as a newsletter, or fails to detect a calendar conflict, every downstream decision is wrong. Garbage in, garbage out. The interpreter must be reliable, well-tested across all situation types, and graceful with malformed input.

## Scope

### SituationInterpreter API

The situation interpreter lives in `@skytwin/decision-engine` (same package as the decision engine, separate module):

```typescript
interface SituationInterpreter {
  interpret(rawEvent: RawEvent): Promise<DecisionObject>;
  getSupportedTypes(): SituationType[];
}

interface RawEvent {
  source: string;           // Where the event came from (e.g., "gmail", "google_calendar", "stripe")
  type: string;             // Event type from the source (e.g., "message.received", "event.conflict")
  payload: Record<string, unknown>;  // Raw event data
  receivedAt: Date;
}
```

### Interpretation Pipeline

1. **Source classification:** Determine the `SituationType` from the event source and type.
2. **Payload extraction:** Pull relevant fields from the raw payload based on the situation type.
3. **Urgency assessment:** Classify urgency as `low`, `medium`, `high`, or `critical` based on event content.
4. **Domain identification:** Assign the event to a domain (e.g., `email`, `calendar`, `finance`, `grocery`, `travel`).
5. **Summary generation:** Create a human-readable summary of the situation.
6. **DecisionObject construction:** Assemble all extracted data into a typed `DecisionObject`.

### Situation Type Handlers

Each `SituationType` has a registered handler that knows how to extract and classify events of that type:

#### Email Triage (`SituationType.EMAIL_TRIAGE`)

Input payload fields:
- `from` (email address, display name)
- `to` (recipients list)
- `subject` (string)
- `labels` (existing labels, e.g., `["inbox", "primary"]`)
- `threadId` (for threading context)
- `hasAttachments` (boolean)
- `receivedAt` (timestamp)
- `snippet` (first ~100 chars of body)
- `isReply` (boolean)

Urgency rules:
- `critical`: Subject contains "urgent", "ASAP", "emergency"; sender is in VIP list (determined later via twin)
- `high`: Is a reply in an active thread; has time-sensitive keywords ("deadline", "by EOD")
- `medium`: Personal email from a known sender; has attachments
- `low`: Newsletter, marketing, automated notification

Domain: `email`

#### Calendar Conflict (`SituationType.CALENDAR_CONFLICT`)

Input payload fields:
- `newEvent` (title, start, end, organizer, attendees, isRequired)
- `conflictingEvent` (title, start, end, organizer, attendees, isRequired)
- `overlapMinutes` (number)
- `calendarId` (which calendar)

Urgency rules:
- `critical`: Conflict is within 1 hour; both events marked as required
- `high`: Conflict is today; one event involves an external stakeholder
- `medium`: Conflict is this week
- `low`: Conflict is more than a week out

Domain: `calendar`

#### Subscription Renewal (`SituationType.SUBSCRIPTION_RENEWAL`)

Input payload fields:
- `service` (service name)
- `currentPlan` (plan name)
- `renewalDate` (when it renews)
- `renewalAmountCents` (cost)
- `currency` (ISO currency code)
- `billingPeriod` (`monthly`, `annual`)
- `autoRenewEnabled` (boolean)

Urgency rules:
- `critical`: Renews within 24 hours
- `high`: Renews within 3 days; amount > $100
- `medium`: Renews within 7 days
- `low`: Renews in more than 7 days

Domain: `finance`

#### Grocery Reorder (`SituationType.GROCERY_REORDER`)

Input payload fields:
- `store` (store name)
- `items` (array of { name, quantity, category, lastOrderedDate })
- `deliveryWindow` (start, end)
- `estimatedTotalCents` (estimated order cost)
- `previousOrderId` (reference to last order)

Urgency rules:
- `critical`: Delivery window closes within 2 hours
- `high`: Delivery window closes today
- `medium`: Delivery window closes within 3 days
- `low`: No time pressure

Domain: `grocery`

#### Travel Decision (`SituationType.TRAVEL_DECISION`)

Input payload fields:
- `tripType` (`business`, `personal`)
- `destination` (city, country)
- `departureDate`, `returnDate`
- `flights` (array of flight options)
- `hotels` (array of hotel options)
- `budgetCents` (trip budget)
- `requiresVisa` (boolean)

Urgency rules:
- `critical`: Departure within 48 hours; requires visa action
- `high`: Departure within 7 days
- `medium`: Departure within 30 days
- `low`: Departure more than 30 days out

Domain: `travel`

#### Generic (`SituationType.GENERIC`)

Fallback for unrecognized events:
- Pass through all payload fields
- Urgency: `medium` (default)
- Domain: extracted from source if possible, otherwise `unknown`
- Summary: best-effort description from available fields

### Error Handling

- **Unknown source:** Classify as `GENERIC`, log a warning.
- **Missing required fields:** Return `GENERIC` with whatever fields are available. Include `_missingFields` in `rawData` for debugging.
- **Malformed payload:** Do not throw. Return a `DecisionObject` with `situationType: GENERIC` and the raw payload preserved in `rawData`.
- **Validation:** Use runtime type checking (e.g., zod schemas) to validate payload structure before extraction.

### Handler Registry

The interpreter uses a registry pattern to dispatch to the correct handler:

```typescript
class SituationInterpreterImpl implements SituationInterpreter {
  private handlers: Map<string, SituationHandler>;

  registerHandler(sourceType: string, handler: SituationHandler): void;
  interpret(rawEvent: RawEvent): Promise<DecisionObject>;
}

interface SituationHandler {
  canHandle(rawEvent: RawEvent): boolean;
  interpret(rawEvent: RawEvent): Promise<DecisionObject>;
}
```

New situation types can be added by implementing `SituationHandler` and registering it, without modifying the interpreter itself.

## Implementation Notes

### Payload Validation with Zod

Define zod schemas for each situation type's expected payload:

```typescript
const EmailPayloadSchema = z.object({
  from: z.object({ email: z.string().email(), name: z.string().optional() }),
  to: z.array(z.object({ email: z.string().email(), name: z.string().optional() })),
  subject: z.string(),
  labels: z.array(z.string()).default([]),
  threadId: z.string().optional(),
  hasAttachments: z.boolean().default(false),
  receivedAt: z.string().datetime(),
  snippet: z.string().default(''),
  isReply: z.boolean().default(false),
});
```

If parsing fails, fall back to `GENERIC` with the raw payload.

### Urgency as a Function, Not Magic Numbers

Urgency classification should be a standalone, testable function per situation type:

```typescript
function classifyEmailUrgency(email: EmailPayload): 'low' | 'medium' | 'high' | 'critical' {
  if (containsUrgentKeywords(email.subject)) return 'critical';
  if (email.isReply && isActiveThread(email.threadId)) return 'high';
  if (isNewsletter(email)) return 'low';
  return 'medium';
}
```

### Testing Strategy

Each situation type needs:
1. **Happy path test:** Well-formed payload produces correct `DecisionObject` with correct type, domain, urgency, and summary.
2. **Edge case tests:** Missing optional fields, extra unexpected fields, boundary urgency classification.
3. **Malformed input test:** Completely wrong payload structure falls back to `GENERIC`.
4. **Urgency boundary tests:** Verify the exact boundaries (e.g., subscription renewing in exactly 24 hours is `critical`, 25 hours is `high`).

## Acceptance Criteria

- [ ] `SituationInterpreter.interpret(rawEvent)` returns a valid `DecisionObject` for all six situation types.
- [ ] Each situation type has a registered handler that correctly extracts fields from the raw payload.
- [ ] Urgency classification follows the defined rules for each situation type (tested at boundaries).
- [ ] Domain is correctly identified for each situation type.
- [ ] Summary is human-readable and includes the key information (e.g., "Email from alice@example.com: 'Quarterly review reminder'").
- [ ] Unknown event sources produce a `GENERIC` DecisionObject with `rawData` preserved.
- [ ] Missing required fields produce a `GENERIC` DecisionObject without throwing.
- [ ] The handler registry allows adding new situation types without modifying existing code.
- [ ] All payload schemas are validated at runtime (zod or equivalent).
- [ ] At least 5 test cases per situation type (30+ tests total).
- [ ] All tests pass: `pnpm --filter @skytwin/decision-engine test`.

## Non-Goals

- **Natural language processing:** The interpreter works with structured payloads, not raw text. Email body analysis, sentiment detection, etc. are out of scope.
- **Source-specific API integration:** The interpreter receives already-fetched events. It does not call Gmail API, Google Calendar API, etc. Those are connector concerns.
- **User-specific interpretation:** The interpreter does not look up the twin profile. It classifies based on event content only. Twin-aware enrichment happens in the `DecisionContext` assembly step.
- **Batched interpretation:** One event in, one `DecisionObject` out. Batch processing is future work.

## Dependencies

- [Issue 001](./issue-001-bootstrap-repo.md): Workspace structure.
- [Issue 002](./issue-002-define-core-schemas.md): `DecisionObject`, `SituationType`, and related types.

## Risks and Open Questions

| Item | Type | Notes |
|------|------|-------|
| Urgency classification is context-dependent (VIP sender requires twin lookup) | Risk | For M1, urgency is classified from event content only. Twin-aware urgency adjustment can happen at the DecisionContext level. |
| Situation type boundaries are fuzzy (a recurring charge email -- is it email_triage or subscription_renewal?) | Risk | Use the event source as the primary discriminator, not the content. An event from a billing system is `subscription_renewal`; an email about a bill is `email_triage`. Document the classification rules. |
| New situation types will be added over time | Risk | The handler registry pattern makes this safe. New handlers are additive. No existing code changes. |
| Zod adds a runtime dependency | Open question | Acceptable. Zod is small, well-maintained, and widely used in TypeScript projects. Alternatively, use a simpler validation library. |
| Should the interpreter be synchronous or async? | Open question | Decision: async (`Promise<DecisionObject>`). Even though M1 interpretation is synchronous, future interpreters may need to call external services (e.g., threat detection for email attachments). |
