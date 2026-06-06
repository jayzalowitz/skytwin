/**
 * Entity extraction + cross-signal resolution (#spec 05, #478).
 *
 * Pulls people / orgs from signal text and resolves mentions to a stable
 * `entityId` so the same entity recurring across signals is linked (and the
 * digest can collapse "one matter, many citations"). The resolution is the
 * bug-prone part: a FALSE MERGE corrupts the graph, so this is deliberately
 * conservative — strong keys (email) for people, a token-overlap floor for
 * orgs, and mint-a-new-entity-on-doubt.
 *
 * Pure + testable. Persistence reuses the existing `MemoryPort.recordEntity`
 * (KnowledgeEntity already exists, port.ts); the read-by-entity port method
 * (`getSignalsForEntity`) is the remaining integration seam (spec 05 §5).
 */

import type { SignalText } from './signal-text.js';

export type EntityKind = 'person' | 'org';

export interface ExtractedEntity {
  kind: EntityKind;
  surface: string;
  normalized: string;
  signalRef: string;
  confidence: number;
}

export interface ResolvedEntity {
  entityId: string;
  kind: EntityKind;
  surfaces: string[];
  signalRefs: string[];
  confidence: number;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const ORG_SUFFIX_RE =
  /\b([A-Z][\w&]*(?:\s+[A-Z][\w&]*)*)\s+(Inc|LLC|Corp|Corporation|Co|Ltd|GmbH)\b/g;

/** Default token-overlap floor for fuzzy org merge — conservative (#260-style gate). */
export const ORG_MERGE_FLOOR = 0.6;

function firstEmail(s: string): string | null {
  const m = s.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

function normalizeOrg(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|corp|corporation|co|ltd|gmbh)\b\.?/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Extract person (emails) + org (suffix-tagged) entities from a signal. */
export function extractEntities(signal: SignalText): ExtractedEntity[] {
  const ref = `${signal.source}:${signal.title}`; // caller may override via signalRef
  const text = `${signal.title}\n${signal.body}`;
  const out: ExtractedEntity[] = [];

  const emails = new Set<string>();
  for (const p of signal.participants) {
    const e = firstEmail(p);
    if (e) emails.add(e);
  }
  for (const m of text.match(EMAIL_RE) ?? []) emails.add(m.toLowerCase());
  for (const email of emails) {
    out.push({ kind: 'person', surface: email, normalized: email, signalRef: ref, confidence: 0.95 });
  }

  for (const m of text.matchAll(ORG_SUFFIX_RE)) {
    const surface = m[0];
    out.push({ kind: 'org', surface, normalized: normalizeOrg(surface), signalRef: ref, confidence: 0.8 });
  }

  return out;
}

function slug(s: string): string {
  return s.replace(/\s+/g, '-').slice(0, 40) || 'x';
}

/**
 * Resolve extracted mentions to stable entities. People merge on exact
 * (normalized) email; orgs merge on exact normalized string OR token-overlap
 * >= floor; otherwise a NEW entity is minted. Conservative: when uncertain it
 * splits (mints) rather than risking a false merge.
 */
export function resolveEntities(
  extracted: ExtractedEntity[],
  floor: number = ORG_MERGE_FLOOR,
): ResolvedEntity[] {
  const resolved: ResolvedEntity[] = [];
  let mintCounter = 0;

  const add = (target: ResolvedEntity, e: ExtractedEntity) => {
    if (!target.surfaces.includes(e.surface)) target.surfaces.push(e.surface);
    if (!target.signalRefs.includes(e.signalRef)) target.signalRefs.push(e.signalRef);
  };

  for (const e of extracted) {
    if (e.kind === 'person') {
      // Strong key: email. Exact match only — never fuzzy-merge people.
      const id = `person:${e.normalized}`;
      const existing = resolved.find((r) => r.entityId === id);
      if (existing) add(existing, e);
      else resolved.push({ entityId: id, kind: 'person', surfaces: [e.surface], signalRefs: [e.signalRef], confidence: e.confidence });
      continue;
    }

    // org: exact normalized, else fuzzy >= floor against same-kind, else mint.
    const exact = resolved.find((r) => r.kind === 'org' && r.entityId === `org:${slug(e.normalized)}`);
    if (exact) {
      add(exact, e);
      continue;
    }
    const fuzzy = resolved.find(
      (r) => r.kind === 'org' && jaccard(tokens(r.entityId.replace(/^org:/, '').replace(/-/g, ' ')), tokens(e.normalized)) >= floor,
    );
    if (fuzzy) {
      add(fuzzy, e);
      continue;
    }
    mintCounter++;
    resolved.push({
      entityId: `org:${slug(e.normalized)}`,
      kind: 'org',
      surfaces: [e.surface],
      signalRefs: [e.signalRef],
      confidence: e.confidence,
    });
  }

  return resolved;
}

/** Convenience: signals → extracted → resolved, with per-signal refs. */
export function linkEntitiesAcrossSignals(
  signals: Array<{ ref: string; signal: SignalText }>,
): ResolvedEntity[] {
  const all: ExtractedEntity[] = [];
  for (const { ref, signal } of signals) {
    for (const e of extractEntities(signal)) all.push({ ...e, signalRef: ref });
  }
  return resolveEntities(all);
}
