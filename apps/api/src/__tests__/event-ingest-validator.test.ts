import { describe, it, expect } from 'vitest';
import { validateEventIngest } from '../validators/event-ingest.js';

describe('validateEventIngest', () => {
  describe('happy path', () => {
    it('accepts a minimal valid event (just userId)', () => {
      const result = validateEventIngest({ userId: 'user_1' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.userId).toBe('user_1');
        expect(result.event['userId']).toBe('user_1');
      }
    });

    it('accepts a fully-populated event', () => {
      const result = validateEventIngest({
        userId: 'user_1',
        source: 'gmail',
        type: 'email_received',
        urgency: 'high',
        data: { from: 'a@b.com', subject: 'Hi' },
      });
      expect(result.ok).toBe(true);
    });

    it('accepts every documented urgency value', () => {
      for (const urgency of ['low', 'medium', 'high', 'critical']) {
        const result = validateEventIngest({ userId: 'u', urgency });
        expect(result.ok).toBe(true);
      }
    });
  });

  describe('body shape', () => {
    it('rejects null body', () => {
      const result = validateEventIngest(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.field).toBe('_body');
      }
    });

    it('rejects array body', () => {
      const result = validateEventIngest([{ userId: 'u' }]);
      expect(result.ok).toBe(false);
    });

    it('rejects primitive body', () => {
      expect(validateEventIngest('hello').ok).toBe(false);
      expect(validateEventIngest(42).ok).toBe(false);
      expect(validateEventIngest(true).ok).toBe(false);
    });

    it('rejects undefined body', () => {
      expect(validateEventIngest(undefined).ok).toBe(false);
    });
  });

  describe('userId', () => {
    it('rejects missing userId', () => {
      const result = validateEventIngest({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.find((e) => e.field === 'userId')).toBeDefined();
      }
    });

    it('rejects empty-string userId', () => {
      const result = validateEventIngest({ userId: '' });
      expect(result.ok).toBe(false);
    });

    it('rejects whitespace-only userId', () => {
      const result = validateEventIngest({ userId: '   ' });
      expect(result.ok).toBe(false);
    });

    it('rejects non-string userId', () => {
      expect(validateEventIngest({ userId: 42 }).ok).toBe(false);
      expect(validateEventIngest({ userId: null }).ok).toBe(false);
      expect(validateEventIngest({ userId: { id: 'u' } }).ok).toBe(false);
    });
  });

  describe('source and type', () => {
    it('accepts missing source and type (interpreter has fallbacks)', () => {
      expect(validateEventIngest({ userId: 'u' }).ok).toBe(true);
    });

    it('rejects non-string source', () => {
      const result = validateEventIngest({ userId: 'u', source: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.find((e) => e.field === 'source')).toBeDefined();
      }
    });

    it('rejects non-string type', () => {
      const result = validateEventIngest({ userId: 'u', type: { name: 'email' } });
      expect(result.ok).toBe(false);
    });

    it('accepts empty-string source and type (interpreter normalizes)', () => {
      expect(validateEventIngest({ userId: 'u', source: '', type: '' }).ok).toBe(true);
    });
  });

  describe('urgency', () => {
    it('rejects unknown urgency value', () => {
      const result = validateEventIngest({ userId: 'u', urgency: 'urgent' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.find((e) => e.field === 'urgency')).toBeDefined();
      }
    });

    it('rejects non-string urgency', () => {
      expect(validateEventIngest({ userId: 'u', urgency: 5 }).ok).toBe(false);
    });
  });

  describe('data', () => {
    it('accepts missing data', () => {
      expect(validateEventIngest({ userId: 'u' }).ok).toBe(true);
    });

    it('accepts empty data object', () => {
      expect(validateEventIngest({ userId: 'u', data: {} }).ok).toBe(true);
    });

    it('rejects array data', () => {
      const result = validateEventIngest({ userId: 'u', data: [1, 2, 3] });
      expect(result.ok).toBe(false);
    });

    it('rejects null data', () => {
      const result = validateEventIngest({ userId: 'u', data: null });
      expect(result.ok).toBe(false);
    });

    it('rejects primitive data', () => {
      expect(validateEventIngest({ userId: 'u', data: 'hello' }).ok).toBe(false);
      expect(validateEventIngest({ userId: 'u', data: 42 }).ok).toBe(false);
    });
  });

  describe('trustTier injection prevention', () => {
    it('rejects caller-supplied trustTier even if value is valid', () => {
      const result = validateEventIngest({
        userId: 'u',
        trustTier: 'high_autonomy',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.find((e) => e.field === 'trustTier')?.message)
          .toContain('cannot be set by the caller');
      }
    });

    it('rejects trustTier even when set to undefined explicitly', () => {
      // The contract is "trustTier is not a caller field" — sneaking it in as
      // undefined should still trigger the explicit rejection.
      const result = validateEventIngest({ userId: 'u', trustTier: undefined });
      expect(result.ok).toBe(false);
    });
  });

  describe('error aggregation', () => {
    it('returns every failing field, not just the first', () => {
      const result = validateEventIngest({
        userId: 42,
        urgency: 'urgent',
        data: 'not an object',
        trustTier: 'high_autonomy',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const fields = result.errors.map((e) => e.field).sort();
        expect(fields).toEqual(['data', 'trustTier', 'urgency', 'userId']);
      }
    });
  });
});
