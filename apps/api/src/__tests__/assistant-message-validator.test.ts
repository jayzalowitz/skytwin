import { describe, it, expect } from 'vitest';
import { validateAssistantMessage } from '../validators/assistant-message.js';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';
const ANOTHER_UUID = '99999999-8888-7777-6666-555555555555';

describe('validateAssistantMessage', () => {
  it('accepts a minimal valid payload (new thread)', () => {
    const result = validateAssistantMessage({
      userId: VALID_UUID,
      content: 'hello',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe(VALID_UUID);
      expect(result.content).toBe('hello');
      expect(result.threadId).toBeNull();
    }
  });

  it('accepts a payload with a valid threadId (continue existing thread)', () => {
    const result = validateAssistantMessage({
      userId: VALID_UUID,
      content: 'follow-up',
      threadId: ANOTHER_UUID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.threadId).toBe(ANOTHER_UUID);
  });

  it('trims surrounding whitespace from content', () => {
    const result = validateAssistantMessage({
      userId: VALID_UUID,
      content: '  hello  \n',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content).toBe('hello');
  });

  it('rejects non-object bodies', () => {
    expect(validateAssistantMessage(null).ok).toBe(false);
    expect(validateAssistantMessage([]).ok).toBe(false);
    expect(validateAssistantMessage('string').ok).toBe(false);
    expect(validateAssistantMessage(42).ok).toBe(false);
  });

  it('requires a UUID userId', () => {
    const noUserId = validateAssistantMessage({ content: 'x' });
    expect(noUserId.ok).toBe(false);
    if (!noUserId.ok) {
      expect(noUserId.errors.some((e) => e.field === 'userId')).toBe(true);
    }

    const badShape = validateAssistantMessage({ userId: 'not-a-uuid', content: 'x' });
    expect(badShape.ok).toBe(false);
  });

  it('rejects empty / whitespace-only content', () => {
    const empty = validateAssistantMessage({ userId: VALID_UUID, content: '' });
    expect(empty.ok).toBe(false);

    const whitespace = validateAssistantMessage({ userId: VALID_UUID, content: '   \n\t  ' });
    expect(whitespace.ok).toBe(false);
  });

  it('rejects oversized content (>16K bytes)', () => {
    const huge = validateAssistantMessage({
      userId: VALID_UUID,
      content: 'a'.repeat(16_001),
    });
    expect(huge.ok).toBe(false);
    if (!huge.ok) {
      expect(huge.errors.some((e) => e.field === 'content')).toBe(true);
    }
  });

  it('rejects non-string content', () => {
    const result = validateAssistantMessage({ userId: VALID_UUID, content: 42 });
    expect(result.ok).toBe(false);
  });

  it('rejects empty-string threadId (would silently start a new thread otherwise)', () => {
    // The user expected to continue an existing thread but the client sent
    // garbage. Better to 400 than silently drop their message into a
    // brand-new thread they didn't ask for.
    const result = validateAssistantMessage({
      userId: VALID_UUID,
      content: 'x',
      threadId: '',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects malformed threadId UUID', () => {
    const result = validateAssistantMessage({
      userId: VALID_UUID,
      content: 'x',
      threadId: 'not-a-uuid',
    });
    expect(result.ok).toBe(false);
  });

  it('treats null and undefined threadId as omitted (new thread)', () => {
    const nullId = validateAssistantMessage({ userId: VALID_UUID, content: 'x', threadId: null });
    expect(nullId.ok).toBe(true);
    if (nullId.ok) expect(nullId.threadId).toBeNull();

    const undef = validateAssistantMessage({ userId: VALID_UUID, content: 'x', threadId: undefined });
    expect(undef.ok).toBe(true);
    if (undef.ok) expect(undef.threadId).toBeNull();
  });
});
