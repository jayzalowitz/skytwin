import { query } from '../connection.js';

export interface RiskProfileRow {
  user_id: string;
  profile_text: string;
  interpreted_caps: Record<string, unknown>;
  last_interpreted_at: Date | null;
  last_model_version: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertRiskProfileInput {
  userId: string;
  profileText: string;
}

export interface UpdateInterpretedCapsInput {
  userId: string;
  interpretedCaps: Record<string, unknown>;
  modelVersion: string;
}

export const riskProfileRepository = {
  async getForUser(userId: string): Promise<RiskProfileRow | null> {
    const result = await query<RiskProfileRow>(
      `SELECT * FROM user_risk_profiles WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ?? null;
  },

  async upsert(input: UpsertRiskProfileInput): Promise<RiskProfileRow> {
    const result = await query<RiskProfileRow>(
      `INSERT INTO user_risk_profiles (user_id, profile_text, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET
         profile_text = EXCLUDED.profile_text,
         updated_at   = now()
       RETURNING *`,
      [input.userId, input.profileText],
    );
    return result.rows[0]!;
  },

  async updateInterpretedCaps(input: UpdateInterpretedCapsInput): Promise<RiskProfileRow | null> {
    const result = await query<RiskProfileRow>(
      `UPDATE user_risk_profiles
       SET interpreted_caps      = $1,
           last_interpreted_at   = now(),
           last_model_version    = $2,
           updated_at            = now()
       WHERE user_id = $3
       RETURNING *`,
      [JSON.stringify(input.interpretedCaps), input.modelVersion, input.userId],
    );
    return result.rows[0] ?? null;
  },
};
