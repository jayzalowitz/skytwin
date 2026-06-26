import { buildExecutableActionPlan, type ExecutableActionPlan } from './action-capabilities.js';

export interface DailyMemorySuggestionPage {
  id: string;
  title?: string | null;
  content: string;
  source: string;
  sourceRef?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date | string;
}

export interface DailyMemorySuggestion {
  id: string;
  title: string;
  reason: string;
  suggestedAction: string;
  sourceRefs: string[];
  memoryRefs: string[];
  sourceTypes: string[];
  novelty: 'connection' | 'resurface';
  confidence: number;
  actionPlan: ExecutableActionPlan;
}

export interface BuildDailyMemorySuggestionsInput {
  recent: DailyMemorySuggestionPage[];
  older: DailyMemorySuggestionPage[];
  maxSuggestions?: number;
  now?: Date;
}

const DEFAULT_MAX_SUGGESTIONS = 3;
const MIN_CONNECTION_SCORE = 4;

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'before',
  'being',
  'between',
  'could',
  'email',
  'event',
  'from',
  'have',
  'here',
  'into',
  'meeting',
  'message',
  'more',
  'need',
  'notes',
  'over',
  'should',
  'signal',
  'that',
  'their',
  'there',
  'these',
  'this',
  'today',
  'with',
  'would',
  'your',
]);

export function buildDailyMemorySuggestions(
  input: BuildDailyMemorySuggestionsInput,
): DailyMemorySuggestion[] {
  const maxSuggestions = Math.max(0, input.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS);
  if (maxSuggestions === 0) return [];

  const recent = sortPagesByCreatedAtDesc(input.recent.filter(isUsablePage));
  const older = sortPagesByCreatedAtDesc(input.older.filter(isUsablePage));
  if (recent.length === 0) return [];

  const suggestions: DailyMemorySuggestion[] = [];
  const usedRecent = new Set<string>();
  const usedOlder = new Set<string>();

  const connectionCandidates = recent
    .flatMap((r) => {
      const best = bestOlderMatch(r, older, usedOlder, input.now);
      return best ? [{ recent: r, older: best.page, score: best.score }] : [];
    })
    .filter((c) => c.score >= MIN_CONNECTION_SCORE)
    .sort((a, b) => b.score - a.score);

  for (const c of connectionCandidates) {
    if (suggestions.length >= maxSuggestions) break;
    if (usedRecent.has(c.recent.id) || usedOlder.has(c.older.id)) continue;
    usedRecent.add(c.recent.id);
    usedOlder.add(c.older.id);
    suggestions.push(connectionSuggestion(c.recent, c.older, c.score, input.now));
  }

  for (const page of recent) {
    if (suggestions.length >= maxSuggestions) break;
    if (usedRecent.has(page.id)) continue;
    usedRecent.add(page.id);
    suggestions.push(resurfaceSuggestion(page));
  }

  return suggestions;
}

function isUsablePage(page: DailyMemorySuggestionPage): boolean {
  const content = page.content.trim();
  if (content.length < 20) return false;
  const metadata = page.metadata ?? {};
  if (metadata['userOverride'] === 'hidden' || metadata['hidden_at'] != null) {
    return false;
  }
  return true;
}

function sortPagesByCreatedAtDesc(pages: DailyMemorySuggestionPage[]): DailyMemorySuggestionPage[] {
  return [...pages].sort((a, b) => {
    const bTime = timeValue(b.createdAt);
    const aTime = timeValue(a.createdAt);
    if (bTime !== aTime) return bTime - aTime;
    return a.id.localeCompare(b.id);
  });
}

function bestOlderMatch(
  recent: DailyMemorySuggestionPage,
  older: DailyMemorySuggestionPage[],
  usedOlder: Set<string>,
  now?: Date,
): { page: DailyMemorySuggestionPage; score: number } | null {
  let best: { page: DailyMemorySuggestionPage; score: number } | null = null;
  for (const page of older) {
    if (page.id === recent.id || usedOlder.has(page.id)) continue;
    if (page.sourceRef && page.sourceRef === recent.sourceRef) continue;
    const score = connectionScore(recent, page, now);
    if (!best || score > best.score) best = { page, score };
  }
  return best;
}

function connectionScore(
  recent: DailyMemorySuggestionPage,
  older: DailyMemorySuggestionPage,
  now?: Date,
): number {
  let score = 0;
  const recentMeta = recent.metadata ?? {};
  const olderMeta = older.metadata ?? {};

  if (
    typeof recentMeta['fromAddress'] === 'string' &&
    recentMeta['fromAddress'] === olderMeta['fromAddress']
  ) {
    score += 5;
  }

  if (
    typeof recentMeta['signalSource'] === 'string' &&
    recentMeta['signalSource'] === olderMeta['signalSource']
  ) {
    score += 1;
  }

  const overlap = tokenOverlap(tokensFor(recent), tokensFor(older));
  score += Math.min(overlap.length, 5);

  const olderAgeDays = ageDays(older.createdAt, now);
  if (olderAgeDays >= 7) score += 2;
  if (isUserAuthored(recentMeta) || isUserAuthored(olderMeta)) score += 1;

  return score;
}

function connectionSuggestion(
  recent: DailyMemorySuggestionPage,
  older: DailyMemorySuggestionPage,
  score: number,
  now?: Date,
): DailyMemorySuggestion {
  const title = `Memory link: ${shortTitle(recent)}`;
  const age = ageLabel(older.createdAt, now);
  const actionPlan = inferActionPlan(recent, older);
  return {
    id: `memory-link-${recent.id}-${older.id}`,
    title,
    reason: `This connects today's ${sourceLabel(recent)} with ${age} memory: "${excerpt(older.content, 120)}"`,
    suggestedAction: suggestedActionFor(actionPlan),
    sourceRefs: compactRefs(recent, older),
    memoryRefs: [recent.id, older.id],
    sourceTypes: compactSourceTypes(recent, older),
    novelty: 'connection',
    confidence: Math.min(0.95, 0.55 + score / 20),
    actionPlan,
  };
}

function resurfaceSuggestion(page: DailyMemorySuggestionPage): DailyMemorySuggestion {
  const actionPlan = inferActionPlan(page);
  return {
    id: `memory-resurface-${page.id}`,
    title: `Memory nudge: ${shortTitle(page)}`,
    reason: `New memory worth carrying forward: "${excerpt(page.content, 140)}"`,
    suggestedAction: suggestedActionFor(actionPlan),
    sourceRefs: compactRefs(page),
    memoryRefs: [page.id],
    sourceTypes: compactSourceTypes(page),
    novelty: 'resurface',
    confidence: isUserAuthored(page.metadata ?? {}) ? 0.72 : 0.62,
    actionPlan,
  };
}

function inferActionPlan(
  page: DailyMemorySuggestionPage,
  older?: DailyMemorySuggestionPage,
): ExecutableActionPlan {
  const content = `${page.content} ${older?.content ?? ''}`.toLowerCase();
  const meta = page.metadata ?? {};
  const source = sourceLabel(page).toLowerCase();

  // Broadcast / no-reply mail — newsletters, marketing blasts, automated
  // notifications — is something to be AWARE of, not correspondence to answer.
  // "Draft a reply" to breakingnews@nytimes.com is nonsense; capture the topic
  // interest instead. The #251 authoring tiers already mark these inbound.
  if (isBroadcastEmail(meta)) {
    return buildExecutableActionPlan('create_note', 'note your interest in this topic');
  }

  // Genuine inbound correspondence (a real person, in your inbox) → draft a reply.
  if (
    source.includes('mail') ||
    typeof meta['fromAddress'] === 'string' ||
    /\b(reply|respond|asked|thread|inbox|email)\b/i.test(content)
  ) {
    return buildExecutableActionPlan('draft_email', 'draft a reply using this memory');
  }

  if (/\b(meeting|schedule|reschedule|availability|calendar|invite|time slot|find time)\b/i.test(content)) {
    return buildExecutableActionPlan('find_meeting_time', 'find or propose a meeting time');
  }

  if (/\b(remind|reminder|tomorrow|next week|deadline|due)\b/i.test(content)) {
    return buildExecutableActionPlan('set_reminder', 'set a reminder for the next step');
  }

  if (/\b(memo|brief|proposal|doc|document|packet|write up|one-page|one page)\b/i.test(content)) {
    return buildExecutableActionPlan('create_document', 'create the supporting document');
  }

  if (/\b(research|search|look up|compare|investigate|find options)\b/i.test(content)) {
    return buildExecutableActionPlan('web_search', 'research the missing context');
  }

  if (/\b(csv|spreadsheet|metrics|analysis|analyze|report|dataset|numbers)\b/i.test(content)) {
    return buildExecutableActionPlan('data_analysis', 'analyze the related data');
  }

  if (/\b(post|social|tweet|linkedin|mention)\b/i.test(content)) {
    return buildExecutableActionPlan('draft_social_post', 'draft the social update');
  }

  if (/\b(i'?ll|i will|we should|need to|follow up|circle back|send|draft|todo|checklist)\b/i.test(content)) {
    return buildExecutableActionPlan('create_task', 'turn this into a tracked task');
  }

  if (isUserAuthored(meta)) {
    return buildExecutableActionPlan('create_note', 'save this as a reusable working note');
  }

  return buildExecutableActionPlan('create_task', 'turn this memory into a next action');
}

function suggestedActionFor(plan: ExecutableActionPlan): string {
  const adapter = plan.primaryAdapter === 'ironclaw' ? 'IronClaw' : 'OpenClaw';
  if (plan.readiness === 'learn_or_connect') {
    return `Learn or connect a skill for ${plan.actionType}, then retry: ${plan.label}.`;
  }
  const fallback =
    plan.fallbackAdapters.length > 0
      ? ` If it cannot route, log the skill gap and fall back through ${plan.fallbackAdapters.join(', ')}.`
      : '';
  return `Try ${plan.label} through ${adapter} (${plan.actionType}).${fallback}`;
}

function tokensFor(page: DailyMemorySuggestionPage): Set<string> {
  const text = `${page.title ?? ''} ${page.content}`;
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function tokenOverlap(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const token of a) {
    if (b.has(token)) out.push(token);
  }
  return out;
}

function shortTitle(page: DailyMemorySuggestionPage): string {
  const rawTitle = page.title?.trim() ?? '';
  if (rawTitle && !/^[a-z_/-]+\/[a-z_/-]+$/i.test(rawTitle)) {
    return truncate(rawTitle, 72);
  }
  return truncate(excerpt(page.content, 90), 72);
}

function sourceLabel(page: DailyMemorySuggestionPage): string {
  const metaSource = page.metadata?.['signalSource'];
  if (typeof metaSource === 'string' && metaSource.length > 0) return metaSource;
  return page.source || 'memory';
}

function compactRefs(...pages: DailyMemorySuggestionPage[]): string[] {
  return [
    ...new Set(
      pages
        .map((p) => p.sourceRef || p.id)
        .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
    ),
  ];
}

function compactSourceTypes(...pages: DailyMemorySuggestionPage[]): string[] {
  return [...new Set(pages.map(sourceLabel).filter((s) => s.length > 0))];
}

function excerpt(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return truncate(oneLine, max);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function isUserAuthored(metadata: Record<string, unknown>): boolean {
  const tier = metadata['authoringTier'];
  return tier === 'user_sent_originated' || tier === 'user_sent_reply';
}

/**
 * Authoring tiers (#251 Layer 1) for no-reply mail the twin should note as
 * topic interest rather than answer: newsletters / list blasts
 * (`inbox_newsletter`) and automated / transactional notifications
 * (`inbox_automated`).
 *
 * `inbox_broadcast` is deliberately NOT here. Per the connector classifier
 * (`authoring-tier.ts`) that tier is plain inbound mail the user is one of
 * several human recipients on (To+Cc > 1) — a cc'd thread that often wants a
 * reply. Treating it as a newsletter would silently drop the reply draft.
 */
const BROADCAST_AUTHORING_TIERS = new Set<string>([
  'inbox_newsletter',
  'inbox_automated',
]);

/**
 * Conservative no-reply / bulk sender match, used only as a fallback when the
 * connector did not stamp an authoring tier. The trigger must be the whole
 * local-part (optionally `+tag` / `.id` suffixed) right before `@`, anchored to
 * the start of the address or a `<` / whitespace boundary — so `mary.newsletter@…`
 * or `johnnotifications@…` (real people) are NOT mistaken for bulk senders.
 */
const NO_REPLY_SENDER =
  /(?:^|[\s<])(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?|newsletter)(?:[+._-][^@\s]*)?@/i;

function isBroadcastEmail(metadata: Record<string, unknown>): boolean {
  const tier = metadata['authoringTier'];
  if (typeof tier === 'string' && BROADCAST_AUTHORING_TIERS.has(tier)) return true;
  const from = metadata['fromAddress'];
  return typeof from === 'string' && NO_REPLY_SENDER.test(from);
}

function ageDays(value: Date | string, now?: Date): number {
  const anchor = now ?? new Date();
  const diffMs = anchor.getTime() - timeValue(value);
  if (!Number.isFinite(diffMs)) return 0;
  return Math.max(0, Math.floor(diffMs / 86_400_000));
}

function timeValue(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function ageLabel(value: Date | string, now?: Date): string {
  const days = ageDays(value, now);
  if (days <= 0) return 'an earlier';
  if (days === 1) return 'yesterday\'s';
  if (days < 14) return `${days}-day-old`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}-week-old`;
  const months = Math.floor(days / 30);
  return `${Math.max(2, months)}-month-old`;
}
