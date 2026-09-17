import type { PoolClient } from "pg";
import { DEMO_USER_ID } from "./demo-guard.js";

type Db = Pick<PoolClient, "query">;

/**
 * Upsert the source-development sample identity with its authorization marker.
 * Keeping this small contract separate makes `pnpm db:seed` and demo-session
 * discovery testable together without executing the full showcase seed.
 */
export async function upsertSourceDemoUser(
  client: Db,
  autonomySettings: Record<string, unknown>,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users (id, email, name, trust_tier, autonomy_settings, is_demo)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = EXCLUDED.name,
       trust_tier = EXCLUDED.trust_tier,
       autonomy_settings = EXCLUDED.autonomy_settings,
       is_demo = true,
       updated_at = now()
     WHERE users.is_demo = true
        OR (users.email = 'alex@example.com' AND users.name = 'Alex Thompson')
     RETURNING id`,
    [
      DEMO_USER_ID,
      "alex@example.com",
      "Alex Thompson",
      "low_autonomy",
      JSON.stringify(autonomySettings),
    ],
  );

  const userId = result.rows[0]?.id;
  if (userId !== DEMO_USER_ID) {
    throw new Error(
      "reserved sample identity is occupied by a non-sample account",
    );
  }
  return userId;
}
