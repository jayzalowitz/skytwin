import { describe, it, expect } from 'vitest';
import { validateEventIngest } from '../validators/event-ingest.js';

const VALID_UID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

describe('validateEventIngest', () => {
  describe('happy path', () => {
    it('accepts a minimal valid event (just userId)', () => {
      const result = validateEventIngest({ userId: VALID_UID });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.userId).toBe(VALID_UID);
        expect(result.event['userId']).toBe(VALID_UID);
      }
    });

    it('accepts a fully-populated event', () => {
      const result = validateEventIngest({
        userId: VALID_UID,
        source: 'gmail',
        type: 'email_received',
        urgency: 'high',
        data: { from: 'a@b.com', subject: 'Hi' },
      });
      expect(result.ok).toBe(true);
    });

    it('accepts every documented urgency value', () => {
      for (const urgency of ['low', 'medium', 'high', 'critical']) {
        const result = validateEventIngest({ userId: VALID_UID, urgency });
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
      const result = validateEventIngest([{ userId: VALID_UID }]);
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

    it('rejects non-UUID userId strings (catches typos and stale tokens)', () => {
      // The DB stores user_id as uuid; any non-uuid string crashes pg-pool
      // with a 500. Catch it at the boundary so the API returns 400.
      const r = validateEventIngest({ userId: '501' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.find((e) => e.field === 'userId')?.message).toContain('valid UUID');
      }
    });

    it('rejects userId that looks UUID-ish but is malformed', () => {
      expect(validateEventIngest({ userId: 'not-a-uuid' }).ok).toBe(false);
      expect(validateEventIngest({ userId: '12345678-1234-1234-1234-12345678901' }).ok).toBe(false);
      expect(validateEventIngest({ userId: 'gggggggg-gggg-gggg-gggg-gggggggggggg' }).ok).toBe(false);
    });

    it('accepts canonical UUIDs (lowercase and uppercase)', () => {
      expect(validateEventIngest({ userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' }).ok).toBe(true);
      expect(validateEventIngest({ userId: 'B2C3D4E5-F6A7-4B8C-9D0E-1F2A3B4C5D6E' }).ok).toBe(true);
    });
  });

  describe('source and type', () => {
    it('accepts missing source and type (interpreter has fallbacks)', () => {
      expect(validateEventIngest({ userId: VALID_UID }).ok).toBe(true);
    });

    it('rejects non-string source', () => {
      const result = validateEventIngest({ userId: VALID_UID, source: 42 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.find((e) => e.field === 'source')).toBeDefined();
      }
    });

    it('rejects non-string type', () => {
      const result = validateEventIngest({ userId: VALID_UID, type: { name: 'email' } });
      expect(result.ok).toBe(false);
    });

    it('accepts empty-string source and type (interpreter normalizes)', () => {
      expect(validateEventIngest({ userId: VALID_UID, source: '', type: '' }).ok).toBe(true);
    });
  });

  describe('urgency', () => {
    it('rejects unknown urgency value', () => {
      const result = validateEventIngest({ userId: VALID_UID, urgency: 'urgent' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.find((e) => e.field === 'urgency')).toBeDefined();
      }
    });

    it('rejects non-string urgency', () => {
      expect(validateEventIngest({ userId: VALID_UID, urgency: 5 }).ok).toBe(false);
    });
  });

  describe('data', () => {
    it('accepts missing data', () => {
      expect(validateEventIngest({ userId: VALID_UID }).ok).toBe(true);
    });

    it('accepts empty data object', () => {
      expect(validateEventIngest({ userId: VALID_UID, data: {} }).ok).toBe(true);
    });

    it('rejects array data', () => {
      const result = validateEventIngest({ userId: VALID_UID, data: [1, 2, 3] });
      expect(result.ok).toBe(false);
    });

    it('rejects null data', () => {
      const result = validateEventIngest({ userId: VALID_UID, data: null });
      expect(result.ok).toBe(false);
    });

    it('rejects primitive data', () => {
      expect(validateEventIngest({ userId: VALID_UID, data: 'hello' }).ok).toBe(false);
      expect(validateEventIngest({ userId: VALID_UID, data: 42 }).ok).toBe(false);
    });
  });

  describe('trustTier injection prevention', () => {
    it('rejects caller-supplied trustTier even if value is valid', () => {
      const result = validateEventIngest({
        userId: VALID_UID,
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
      const result = validateEventIngest({ userId: VALID_UID, trustTier: undefined });
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
