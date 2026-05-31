import { describe, it, expect } from 'vitest';
import {
  approvalDeepLink,
  deepLinkFromNotificationData,
  parseSkytwinUrl,
} from '../services/deep-link';

describe('parseSkytwinUrl', () => {
  it('parses an approval-detail link', () => {
    expect(parseSkytwinUrl('skytwin://approvals/abc-123')).toEqual({
      route: 'approval-detail',
      id: 'abc-123',
    });
  });

  it('parses the approvals-root link', () => {
    expect(parseSkytwinUrl('skytwin://approvals')).toEqual({ route: 'approvals' });
    expect(parseSkytwinUrl('skytwin://approvals/')).toEqual({ route: 'approvals' });
  });

  it('URL-decodes the approval id', () => {
    expect(parseSkytwinUrl('skytwin://approvals/req%20with%20spaces')).toEqual({
      route: 'approval-detail',
      id: 'req with spaces',
    });
  });

  it('strips a query string / fragment', () => {
    expect(parseSkytwinUrl('skytwin://approvals/abc-123?from=push#x')).toEqual({
      route: 'approval-detail',
      id: 'abc-123',
    });
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseSkytwinUrl('SKYTWIN://approvals/abc')).toEqual({
      route: 'approval-detail',
      id: 'abc',
    });
  });

  it('returns null for a wrong scheme', () => {
    expect(parseSkytwinUrl('https://example.com/approvals/abc')).toBeNull();
    expect(parseSkytwinUrl('otherapp://approvals/abc')).toBeNull();
  });

  it('returns null for an unknown host/route', () => {
    expect(parseSkytwinUrl('skytwin://settings/abc')).toBeNull();
    expect(parseSkytwinUrl('skytwin://')).toBeNull();
  });

  it('returns null for a whitespace-only id', () => {
    expect(parseSkytwinUrl('skytwin://approvals/%20')).toBeNull();
  });

  it('returns null on malformed percent-encoding', () => {
    expect(parseSkytwinUrl('skytwin://approvals/%E0%A4%A')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseSkytwinUrl(null)).toBeNull();
    expect(parseSkytwinUrl(undefined)).toBeNull();
    expect(parseSkytwinUrl(42)).toBeNull();
    expect(parseSkytwinUrl({})).toBeNull();
  });

  it('round-trips through approvalDeepLink', () => {
    const id = 'weird/id with spaces & symbols';
    const url = approvalDeepLink(id);
    expect(parseSkytwinUrl(url)).toEqual({ route: 'approval-detail', id });
  });
});

describe('approvalDeepLink', () => {
  it('builds a parseable encoded link', () => {
    expect(approvalDeepLink('abc-123')).toBe('skytwin://approvals/abc-123');
  });
});

describe('deepLinkFromNotificationData', () => {
  it('reads the url field first', () => {
    expect(deepLinkFromNotificationData({ url: 'skytwin://approvals/xyz' })).toEqual({
      route: 'approval-detail',
      id: 'xyz',
    });
  });

  it('falls back to a bare approvalId', () => {
    expect(deepLinkFromNotificationData({ approvalId: 'req-7' })).toEqual({
      route: 'approval-detail',
      id: 'req-7',
    });
  });

  it('prefers a valid url over approvalId when both present', () => {
    expect(
      deepLinkFromNotificationData({ url: 'skytwin://approvals/from-url', approvalId: 'from-id' }),
    ).toEqual({ route: 'approval-detail', id: 'from-url' });
  });

  it('falls back to approvalId when the url is not a valid skytwin link', () => {
    expect(
      deepLinkFromNotificationData({ url: 'https://example.com', approvalId: 'from-id' }),
    ).toEqual({ route: 'approval-detail', id: 'from-id' });
  });

  it('returns null for an empty / irrelevant payload', () => {
    expect(deepLinkFromNotificationData({})).toBeNull();
    expect(deepLinkFromNotificationData({ approvalId: '   ' })).toBeNull();
    expect(deepLinkFromNotificationData(null)).toBeNull();
    expect(deepLinkFromNotificationData('nope')).toBeNull();
  });
});
