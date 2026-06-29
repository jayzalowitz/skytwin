import { describe, it, expect } from 'vitest';
import {
  classifyEmailAuthoringTier,
  extractBareAddress,
  isAutomatedSender,
  splitAddressList,
} from '../authoring-tier.js';

describe('extractBareAddress', () => {
  it('strips display name + angle brackets', () => {
    expect(extractBareAddress('Acme <noreply@acme.com>')).toBe('noreply@acme.com');
  });

  it('lowercases the result', () => {
    expect(extractBareAddress('JANE@EXAMPLE.COM')).toBe('jane@example.com');
  });

  it('returns the raw input when no angle brackets are present', () => {
    expect(extractBareAddress('jane@example.com')).toBe('jane@example.com');
  });

  it('returns empty string for empty input', () => {
    expect(extractBareAddress('')).toBe('');
  });
});

describe('splitAddressList', () => {
  it('splits a comma-separated list and extracts bare addresses', () => {
    const out = splitAddressList('"Jane" <jane@example.com>, joe@example.com');
    expect(out).toEqual(['jane@example.com', 'joe@example.com']);
  });

  it('returns empty array for empty input', () => {
    expect(splitAddressList('')).toEqual([]);
  });

  it('drops empty fragments produced by trailing commas', () => {
    expect(splitAddressList('a@x.com, ,b@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('isAutomatedSender', () => {
  it('flags noreply / no-reply local parts', () => {
    expect(isAutomatedSender('noreply@acme.com')).toBe(true);
    expect(isAutomatedSender('no-reply@acme.com')).toBe(true);
    expect(isAutomatedSender('do-not-reply@acme.com')).toBe(true);
  });

  it('flags subaddressed automated senders', () => {
    expect(isAutomatedSender('noreply+thread-42@acme.com')).toBe(true);
    expect(isAutomatedSender('notifications.thread-42@github.com')).toBe(true);
  });

  it('flags a token as the last segment after a hyphen (google-noreply@)', () => {
    // The regression: a real Google notification was mis-tiered as personal.
    expect(isAutomatedSender('google-noreply@google.com')).toBe(true);
    expect(isAutomatedSender('email-noreply@company.com')).toBe(true);
    expect(isAutomatedSender('account-no-reply@bank.com')).toBe(true);
    expect(isAutomatedSender('noreply-team@vendor.com')).toBe(true);
  });

  it('does NOT match an embedded substring or a dot-suffixed human/role alias', () => {
    // "noreply" is a substring of "noreplyfan" but not a delimited component.
    expect(isAutomatedSender('noreplyfan@acme.com')).toBe(false);
    expect(isAutomatedSender('alerting@acme.com')).toBe(false);
    // `firstname.role@` reads as a person; the original only matched the FIRST
    // segment, and the compound fix keeps that (only hyphen-suffix is added).
    expect(isAutomatedSender('alex.alert@company.com')).toBe(false);
    expect(isAutomatedSender('pat.notifications@example.edu')).toBe(false);
  });

  it('flags known transactional sender domains', () => {
    expect(isAutomatedSender('hello@sub.mailchimp.com')).toBe(true);
    expect(isAutomatedSender('list@amazonses.com')).toBe(true);
    expect(isAutomatedSender('updates@noreply.vendor.com')).toBe(true);
  });

  it('does NOT flag human-looking senders', () => {
    expect(isAutomatedSender('jane@acme.com')).toBe(false);
    expect(isAutomatedSender('support@acme.com')).toBe(false);
    expect(isAutomatedSender('hello@acme.com')).toBe(false);
  });

  it('handles display names', () => {
    expect(isAutomatedSender('"Acme Alerts" <alerts@acme.com>')).toBe(true);
  });

  it('handles malformed addresses without throwing', () => {
    expect(isAutomatedSender('')).toBe(false);
    expect(isAutomatedSender('not-an-email')).toBe(false);
  });
});

describe('classifyEmailAuthoringTier', () => {
  const base = {
    labels: [] as string[],
    fromAddress: 'someone@example.com',
    toAddresses: ['user@example.com'],
    ccAddresses: [] as string[],
    hasInReplyTo: false,
    hasListUnsubscribe: false,
    listId: '',
  };

  it('classifies SENT + no In-Reply-To as user_sent_originated', () => {
    expect(classifyEmailAuthoringTier({ ...base, labels: ['SENT'] })).toBe(
      'user_sent_originated',
    );
  });

  it('classifies SENT + In-Reply-To as user_sent_reply', () => {
    expect(
      classifyEmailAuthoringTier({ ...base, labels: ['SENT'], hasInReplyTo: true }),
    ).toBe('user_sent_reply');
  });

  it('treats SENT as dominant even when other tier signals fire', () => {
    // List-Unsubscribe on a SENT message is rare (e.g. mailing-list moderator
    // sending a list-relayed message). It should still count as user_sent_*.
    expect(
      classifyEmailAuthoringTier({
        ...base,
        labels: ['SENT'],
        hasListUnsubscribe: true,
        listId: 'something.list',
      }),
    ).toBe('user_sent_originated');
  });

  it('classifies List-Unsubscribe inbox mail as inbox_newsletter', () => {
    expect(
      classifyEmailAuthoringTier({ ...base, hasListUnsubscribe: true }),
    ).toBe('inbox_newsletter');
  });

  it('classifies List-Id inbox mail as inbox_newsletter', () => {
    expect(classifyEmailAuthoringTier({ ...base, listId: 'rangers.list' })).toBe(
      'inbox_newsletter',
    );
  });

  it('classifies CATEGORY_PROMOTIONS as inbox_newsletter', () => {
    expect(
      classifyEmailAuthoringTier({ ...base, labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
    ).toBe('inbox_newsletter');
  });

  it('classifies noreply senders as inbox_automated', () => {
    expect(
      classifyEmailAuthoringTier({ ...base, fromAddress: 'noreply@stripe.com' }),
    ).toBe('inbox_automated');
  });

  it('classifies a compound no-reply sender as inbox_automated, not personal', () => {
    // Regression: google-noreply@google.com fell through to inbox_personal, so
    // the memory loop offered to "draft a reply" to an automated notification.
    expect(
      classifyEmailAuthoringTier({ ...base, fromAddress: 'Google <google-noreply@google.com>' }),
    ).toBe('inbox_automated');
  });

  it('prefers newsletter over automated when both fire', () => {
    // A mailchimp-relayed newsletter has both a List-Unsubscribe header AND
    // a sending domain that matches the automated regex. Newsletter wins.
    expect(
      classifyEmailAuthoringTier({
        ...base,
        fromAddress: 'news@sub.mailchimp.com',
        hasListUnsubscribe: true,
      }),
    ).toBe('inbox_newsletter');
  });

  it('classifies multi-recipient inbox mail as inbox_broadcast', () => {
    expect(
      classifyEmailAuthoringTier({
        ...base,
        toAddresses: ['user@example.com', 'other@example.com'],
      }),
    ).toBe('inbox_broadcast');
  });

  it('counts To + Cc together for the broadcast threshold', () => {
    expect(
      classifyEmailAuthoringTier({
        ...base,
        toAddresses: ['user@example.com'],
        ccAddresses: ['observer@example.com'],
      }),
    ).toBe('inbox_broadcast');
  });

  it('defaults single-recipient human mail to inbox_personal', () => {
    expect(classifyEmailAuthoringTier(base)).toBe('inbox_personal');
  });

  it('returns inbox_personal for zero-recipient edge case', () => {
    // Defensive: malformed headers occasionally drop To. Don't claim
    // broadcast for a message with no parseable recipients.
    expect(
      classifyEmailAuthoringTier({ ...base, toAddresses: [], ccAddresses: [] }),
    ).toBe('inbox_personal');
  });
});
