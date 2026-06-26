import { query } from '@skytwin/db';
import {
  buildDailyMemorySuggestions,
  type DailyMemorySuggestion,
  type DailyMemorySuggestionPage,
} from '@skytwin/shared-types';

export interface MemorySuggestionRow {
  bucket: 'recent' | 'older';
  id: string;
  title: string | null;
  content: string | null;
  source: string;
  source_ref: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
}

export interface DailyMemorySuggestionBundle {
  suggestions: DailyMemorySuggestion[];
  pagesById: Map<string, DailyMemorySuggestionPage>;
}

export async function getUsersWithRecentMemory(limit = 500): Promise<string[]> {
  const capped = Math.min(Math.max(1, limit), 5000);
  const result = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id
       FROM brain_pages
      WHERE created_at >= now() - INTERVAL '36 hours'
      ORDER BY user_id
      LIMIT $1`,
    [capped],
  );
  return result.rows.map((row) => row.user_id);
}

export async function fetchDailyMemorySuggestionBundle(
  userId: string,
  maxSuggestions = 5,
): Promise<DailyMemorySuggestionBundle> {
  let rows: { rows: MemorySuggestionRow[] } | undefined;
  try {
    rows = await query<MemorySuggestionRow>(
      `WITH recent AS (
         SELECT id, title, COALESCE(content, '') AS content, source, source_ref, metadata, created_at
           FROM brain_pages
          WHERE user_id = $1
            AND created_at >= now() - INTERVAL '36 hours'
            AND COALESCE(metadata->>'userOverride', '') <> 'hidden'
          ORDER BY created_at DESC
          LIMIT 48
       ),
       older AS (
         SELECT id, title, COALESCE(content, '') AS content, source, source_ref, metadata, created_at
           FROM brain_pages
          WHERE user_id = $1
            AND created_at < now() - INTERVAL '36 hours'
            AND created_at >= now() - INTERVAL '120 days'
            AND COALESCE(metadata->>'userOverride', '') <> 'hidden'
          ORDER BY created_at DESC
          LIMIT 220
       )
       SELECT 'recent' AS bucket, * FROM recent
       UNION ALL
       SELECT 'older' AS bucket, * FROM older`,
      [userId],
    );
  } catch {
    return { suggestions: [], pagesById: new Map() };
  }

  const resultRows = Array.isArray(rows?.rows) ? rows.rows : [];
  const toPage = (row: MemorySuggestionRow): DailyMemorySuggestionPage => ({
    id: row.id,
    title: row.title,
    content: row.content ?? '',
    source: row.source,
    sourceRef: row.source_ref,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  });

  const recent = resultRows.filter((r) => r.bucket === 'recent').map(toPage);
  const older = resultRows.filter((r) => r.bucket === 'older').map(toPage);
  const pagesById = new Map<string, DailyMemorySuggestionPage>();
  for (const page of [...recent, ...older]) pagesById.set(page.id, page);

  return {
    suggestions: buildDailyMemorySuggestions({
      recent,
      older,
      maxSuggestions,
    }),
    pagesById,
  };
}

export async function fetchDailyMemorySuggestions(
  userId: string,
  maxSuggestions = 5,
): Promise<DailyMemorySuggestion[]> {
  return (await fetchDailyMemorySuggestionBundle(userId, maxSuggestions)).suggestions;
}
