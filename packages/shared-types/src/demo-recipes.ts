/**
 * Demo recipe library (#405) — canned sample-decision recipes for the in-app
 * tour / demo.
 *
 * Each recipe is a self-contained, fictional sample situation that the demo
 * surface can drop into the "Ask your twin" box so a first-time visitor sees
 * the twin reason out loud across SkyTwin's headline workflows before they
 * connect any real account. Every recipe also carries the `situation` string
 * the dashboard wires behind a "Try this on your real data" button — clicking
 * it runs the same prompt against the user's *own* connected twin via the
 * existing `whatWouldIDo` path (read-only prediction, nothing executes).
 *
 * These are data, not behavior: no policy decision, execution, or provenance
 * lives here. The prediction path that consumes a recipe's `situation` is the
 * one that applies trust-tier / policy / injection-guard checks (the
 * `/api/v1/demo/preview` and `/v1/twin/ask` routes). A recipe is just a
 * pre-written situation prompt plus presentation copy.
 *
 * Content is fictional — no real names, companies, amounts, or addresses.
 */

/** A demo recipe `domain` maps onto the dashboard's existing domain labels/icons. */
export type DemoRecipeDomain =
  | 'email'
  | 'calendar'
  | 'subscriptions'
  | 'finance'
  | 'task_management';

/**
 * A single canned sample-decision recipe.
 *
 * `situation` is the plain-language prompt fed to the prediction path. It is
 * intentionally first-person and concrete so the twin's reasoning reads well
 * in the demo. The same string is what "Try this on your real data" submits.
 */
export interface DemoRecipe {
  /** Stable, URL-safe identifier — used as a `data-recipe` attribute key. */
  readonly slug: string;
  /** Short human title for the recipe card. */
  readonly title: string;
  /** Which dashboard domain this recipe demonstrates. */
  readonly domain: DemoRecipeDomain;
  /** One-sentence framing of what the twin is being asked to weigh in on. */
  readonly description: string;
  /** First-person situation prompt fed to the prediction path. */
  readonly situation: string;
}

/**
 * The canned recipe library. At least the six named launch workflows
 * (#405): newsletter triage, calendar conflict resolution, subscription
 * renewal review, meeting prep, expense report categorization, and recurring
 * task auto-handling.
 *
 * Frozen so a consumer can't mutate the shared array in place.
 */
export const DEMO_RECIPES: readonly DemoRecipe[] = Object.freeze([
  {
    slug: 'newsletter-triage',
    title: 'Newsletter triage',
    domain: 'email',
    description: 'A recurring newsletter you usually skim and archive lands again.',
    situation:
      "The weekly product newsletter from a tool I use just arrived. I've archived the last 11 of these without opening them. What would you do?",
  },
  {
    slug: 'calendar-conflict-resolution',
    title: 'Calendar conflict resolution',
    domain: 'calendar',
    description: 'A new invite double-books a slot you already hold.',
    situation:
      'A new meeting invite for Tuesday at 2pm just landed, but I already have a one-on-one with my manager at that time. What would you do?',
  },
  {
    slug: 'subscription-renewal-review',
    title: 'Subscription renewal review',
    domain: 'subscriptions',
    description: 'A recurring charge is about to renew — keep it or cancel?',
    situation:
      "My streaming subscription is about to renew at $15.99/month. I've opened it 3 times this month. What would you do?",
  },
  {
    slug: 'meeting-prep',
    title: 'Meeting prep',
    domain: 'calendar',
    description: 'A meeting is coming up — what should be ready beforehand?',
    situation:
      "I have a kickoff call with a new partner tomorrow morning and I haven't put together an agenda or notes yet. What would you do?",
  },
  {
    slug: 'expense-report-categorization',
    title: 'Expense report categorization',
    domain: 'finance',
    description: 'A receipt needs to be filed under the right expense category.',
    situation:
      'I just got a $42 receipt emailed to me from a ride-share trip to the airport for a work conference. How would you categorize it for my expense report?',
  },
  {
    slug: 'recurring-task-auto-handling',
    title: 'Recurring task auto-handling',
    domain: 'task_management',
    description: 'A routine task you do every week comes around again.',
    situation:
      "Every Friday I send the team a short status update summarizing the week. It's Friday afternoon again. What would you do?",
  },
]);

/**
 * Look a recipe up by slug. Returns a typed result so callers handle the
 * "no such recipe" case explicitly rather than dereferencing `undefined`.
 */
export function findDemoRecipe(
  slug: string,
):
  | { found: true; recipe: DemoRecipe }
  | { found: false } {
  const recipe = DEMO_RECIPES.find((r) => r.slug === slug);
  return recipe ? { found: true, recipe } : { found: false };
}
