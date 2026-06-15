import { describe, it, expect } from 'vitest';
import { DEMO_RECIPES, findDemoRecipe } from '../demo-recipes.js';

describe('DEMO_RECIPES', () => {
  it('ships at least 6 recipes (#405 acceptance criterion)', () => {
    expect(DEMO_RECIPES.length).toBeGreaterThanOrEqual(6);
  });

  it('covers each of the six named launch workflows', () => {
    const slugs = DEMO_RECIPES.map((r) => r.slug);
    for (const required of [
      'newsletter-triage',
      'calendar-conflict-resolution',
      'subscription-renewal-review',
      'meeting-prep',
      'expense-report-categorization',
      'recurring-task-auto-handling',
    ]) {
      expect(slugs).toContain(required);
    }
  });

  it('has unique slugs', () => {
    const slugs = DEMO_RECIPES.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every recipe has the fields the demo surface needs', () => {
    for (const r of DEMO_RECIPES) {
      // slug is URL-safe (lowercase, digits, hyphens) so it can ride in a
      // data-attribute / query param without escaping.
      expect(r.slug).toMatch(/^[a-z0-9-]+$/);
      expect(r.title.trim().length).toBeGreaterThan(0);
      expect(r.description.trim().length).toBeGreaterThan(0);
      // situation is what "Try this on your real data" submits to the
      // prediction path; the demo/preview route caps input at 600 chars.
      expect(r.situation.trim().length).toBeGreaterThan(0);
      expect(r.situation.length).toBeLessThanOrEqual(600);
      expect(['email', 'calendar', 'subscriptions', 'finance', 'task_management']).toContain(r.domain);
    }
  });

  it('is immutable — push throws on the frozen array', () => {
    expect(() => {
      // @ts-expect-error — intentionally violating readonly to prove the freeze.
      DEMO_RECIPES.push({
        slug: 'x',
        title: 'x',
        domain: 'email',
        description: 'x',
        situation: 'x',
      });
    }).toThrow();
  });
});

describe('findDemoRecipe', () => {
  it('returns { found: true, recipe } for a known slug', () => {
    const result = findDemoRecipe('newsletter-triage');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.recipe.slug).toBe('newsletter-triage');
      expect(result.recipe.domain).toBe('email');
    }
  });

  it('returns { found: false } for an unknown slug (no undefined deref)', () => {
    const result = findDemoRecipe('does-not-exist');
    expect(result).toEqual({ found: false });
  });

  it('does not match on a partial / empty slug', () => {
    expect(findDemoRecipe('').found).toBe(false);
    expect(findDemoRecipe('newsletter').found).toBe(false);
  });
});
