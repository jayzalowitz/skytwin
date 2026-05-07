import { describe, it, expect } from 'vitest';
import { aggregateMentions } from '../evidence-aggregator.js';
import type { SignalMention } from '../types.js';

function makeMention(
  registryId: string,
  signalId: string,
  kind: SignalMention['signalKind'],
  occurredAt: Date,
  excerpt = 'test excerpt',
): SignalMention {
  return { registryId, signalId, signalKind: kind, excerpt, occurredAt };
}

const userId = 'user-1';
const displayNames = new Map([
  ['notion', 'Notion'],
  ['slack', 'Slack'],
]);

describe('aggregateMentions', () => {
  it('groups mentions by registryId', () => {
    const mentions = [
      makeMention('notion', 's1', 'email', new Date('2024-01-01')),
      makeMention('notion', 's2', 'calendar', new Date('2024-01-02')),
      makeMention('slack', 's3', 'email', new Date('2024-01-01')),
    ];
    const result = aggregateMentions(userId, mentions, displayNames);
    expect(result.size).toBe(2);
    expect(result.get('notion')!.evidenceCount).toBe(2);
    expect(result.get('slack')!.evidenceCount).toBe(1);
  });

  it('caps evidence_sources at 5 per suggestion', () => {
    const mentions = Array.from({ length: 8 }, (_, i) =>
      makeMention('notion', `s${i}`, 'email', new Date(`2024-01-0${(i % 9) + 1}`)),
    );
    const result = aggregateMentions(userId, mentions, displayNames);
    expect(result.get('notion')!.evidenceSources.length).toBe(5);
  });

  it('tracks firstEvidenceAt correctly', () => {
    const mentions = [
      makeMention('notion', 's2', 'email', new Date('2024-01-05')),
      makeMention('notion', 's1', 'email', new Date('2024-01-01')),
      makeMention('notion', 's3', 'fs', new Date('2024-01-10')),
    ];
    const result = aggregateMentions(userId, mentions, displayNames);
    expect(result.get('notion')!.firstEvidenceAt.toISOString()).toBe(
      new Date('2024-01-01').toISOString(),
    );
  });

  it('tracks lastEvidenceAt correctly', () => {
    const mentions = [
      makeMention('notion', 's1', 'email', new Date('2024-01-01')),
      makeMention('notion', 's3', 'fs', new Date('2024-01-10')),
    ];
    const result = aggregateMentions(userId, mentions, displayNames);
    expect(result.get('notion')!.lastEvidenceAt.toISOString()).toBe(
      new Date('2024-01-10').toISOString(),
    );
  });

  it('counts distinct kinds correctly', () => {
    const mentions = [
      makeMention('notion', 's1', 'email', new Date('2024-01-01')),
      makeMention('notion', 's2', 'email', new Date('2024-01-02')),
      makeMention('notion', 's3', 'calendar', new Date('2024-01-03')),
      makeMention('notion', 's4', 'fs', new Date('2024-01-04')),
    ];
    const result = aggregateMentions(userId, mentions, displayNames);
    expect(result.get('notion')!.evidenceKindsDistinct).toBe(3);
  });

  it('returns an empty map for no mentions', () => {
    const result = aggregateMentions(userId, [], displayNames);
    expect(result.size).toBe(0);
  });

  it('sets userId on each suggestion', () => {
    const mentions = [makeMention('notion', 's1', 'email', new Date('2024-01-01'))];
    const result = aggregateMentions('u-42', mentions, displayNames);
    expect(result.get('notion')!.userId).toBe('u-42');
  });

  it('uses displayName from map when available', () => {
    const mentions = [makeMention('notion', 's1', 'email', new Date('2024-01-01'))];
    const result = aggregateMentions(userId, mentions, displayNames);
    expect(result.get('notion')!.displayName).toBe('Notion');
  });

  it('falls back to registryId as displayName when not in map', () => {
    const mentions = [makeMention('unknown-app', 's1', 'email', new Date('2024-01-01'))];
    const result = aggregateMentions(userId, mentions, new Map());
    expect(result.get('unknown-app')!.displayName).toBe('unknown-app');
  });
});
