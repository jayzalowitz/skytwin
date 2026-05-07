import { query } from '../connection.js';

export interface OnboardingStateRow {
  user_id: string;
  is_first_run: boolean;
  first_run_choice: 'email' | 'computer' | 'about-me' | null;
  selected_recipe_slug: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const onboardingRepository = {
  /**
   * Returns the onboarding state row for a user, or null if it does not exist.
   */
  async getForUser(userId: string): Promise<OnboardingStateRow | null> {
    const result = await query<OnboardingStateRow>(
      'SELECT * FROM user_onboarding_state WHERE user_id = $1',
      [userId],
    );
    return result.rows[0] ?? null;
  },

  /**
   * Inserts or returns a fresh row with is_first_run=true for a user that has
   * no onboarding state yet. Does nothing if a row already exists.
   */
  async ensureRow(userId: string): Promise<OnboardingStateRow> {
    await query(
      `INSERT INTO user_onboarding_state (user_id, is_first_run)
       VALUES ($1, TRUE)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const result = await query<OnboardingStateRow>(
      'SELECT * FROM user_onboarding_state WHERE user_id = $1',
      [userId],
    );
    return result.rows[0]!;
  },

  /**
   * Marks the first-run wizard as complete, recording the user's choice and
   * optionally the recipe they were shown.
   */
  async markComplete(
    userId: string,
    choice: 'email' | 'computer' | 'about-me',
    recipeSlug?: string,
  ): Promise<OnboardingStateRow> {
    const result = await query<OnboardingStateRow>(
      `INSERT INTO user_onboarding_state
         (user_id, is_first_run, first_run_choice, selected_recipe_slug, completed_at, updated_at)
       VALUES ($1, FALSE, $2, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET
         is_first_run         = FALSE,
         first_run_choice     = EXCLUDED.first_run_choice,
         selected_recipe_slug = EXCLUDED.selected_recipe_slug,
         completed_at         = EXCLUDED.completed_at,
         updated_at           = now()
       RETURNING *`,
      [userId, choice, recipeSlug ?? null],
    );
    return result.rows[0]!;
  },

  /**
   * Explicitly sets is_first_run. Used to reset the flag in testing or admin
   * tooling — regular product code should call markComplete instead.
   */
  async setFirstRun(userId: string, isFirstRun: boolean): Promise<OnboardingStateRow> {
    const result = await query<OnboardingStateRow>(
      `INSERT INTO user_onboarding_state (user_id, is_first_run, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET
         is_first_run = EXCLUDED.is_first_run,
         updated_at   = now()
       RETURNING *`,
      [userId, isFirstRun],
    );
    return result.rows[0]!;
  },
};
