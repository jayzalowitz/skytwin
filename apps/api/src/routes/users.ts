import { Router, type Request, type Response, type NextFunction } from 'express';
import { userRepository, userPurgeRepository } from '@skytwin/db';
import { TwinService } from '@skytwin/twin-model';
import { TwinRepositoryAdapter, PatternRepositoryAdapter } from '@skytwin/db';
import { ConfidenceLevel } from '@skytwin/shared-types';
import { sessionAuth } from '../middleware/session-auth.js';
import { isValidUserId } from '../middleware/validate-uuid.js';

const VALID_TIERS = ['observer', 'suggest', 'low_autonomy', 'moderate_autonomy', 'high_autonomy'];

const VALID_DOMAINS = [
  'email', 'calendar', 'finance', 'shopping', 'travel',
  'tasks', 'smart_home', 'social', 'documents', 'health',
];

/**
 * Create the users management router.
 */
/**
 * Conservative autonomy defaults for a brand-new user (spec 10 Part A).
 *
 * Deliberately NO spend caps: the built-in `NO_SPEND_WITHOUT_LIMIT` policy
 * blocks all spend until the user configures a budget, so omitting caps is the
 * safe default (escalate, never silently auto-spend). The dashboard surfaces
 * "set a budget to enable spend". Domain allow/block lists start empty.
 */
const DEFAULT_AUTONOMY_SETTINGS: Record<string, unknown> = {
  allowedDomains: [],
  blockedDomains: [],
};

export function createUsersRouter(): Router {
  const router = Router();
  const twinService = new TwinService(new TwinRepositoryAdapter(), new PatternRepositoryAdapter());

  async function findUserByIdOrEmail(identifier: string) {
    return isValidUserId(identifier)
      ? userRepository.findById(identifier)
      : userRepository.findByEmail(identifier);
  }

  async function requireUserParamOwnership(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authenticatedUserId = req.authenticatedUserId;
    if (!authenticatedUserId) {
      next();
      return;
    }

    const requested = req.params['userId'];
    if (typeof requested !== 'string' || !requested) {
      next();
      return;
    }

    if (isValidUserId(requested)) {
      if (requested !== authenticatedUserId) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'You do not have access to this resource.',
        });
        return;
      }
      next();
      return;
    }

    const authenticatedUser = await userRepository.findById(authenticatedUserId);
    if (!authenticatedUser || requested !== authenticatedUser.email) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have access to this resource.',
      });
      return;
    }

    next();
  }

  /**
   * Provision the zero-content default state every real user starts from:
   * an empty twin profile (eagerly, not lazily) + conservative autonomy
   * settings. Idempotent (getOrCreateProfile no-ops if a profile exists) and
   * only invoked on the genuinely-new-user path, so it never clobbers a
   * configured user. Best-effort: getOrCreateProfile lazily backstops the
   * profile elsewhere, so this is belt-and-suspenders, not a hard dependency.
   */
  async function provisionNewUser(userId: string): Promise<void> {
    await twinService.getOrCreateProfile(userId);
    await userRepository.updateAutonomySettings(userId, DEFAULT_AUTONOMY_SETTINGS);
  }

  // Everything under /:userId is user-scoped and must be authenticated.
  router.use('/:userId', sessionAuth, requireUserParamOwnership);

  /**
   * GET /api/users
   *
   * Returns the list of users *visible to the caller*:
   *   - With dev auth bypass active (localhost, NODE_ENV=development):
   *     the full set, so the dashboard's user-switcher works.
   *   - With a real authenticated session: only the caller's own user row.
   *     We intentionally don't 403 — the user-switcher renders a single-row
   *     dropdown which is correct in production.
   *
   * Without this scoping any authenticated user could enumerate every other
   * user's id+email — a privacy bug found pre-launch.
   */
  router.get('/', sessionAuth, async (req, res, next) => {
    try {
      const requesterId = req.authenticatedUserId;

      // Dev auth bypass: req.authenticatedUserId is undefined and the
      // sessionAuth middleware has already let us through (its only path
      // that doesn't set the field). Return everything.
      if (!requesterId) {
        const users = await userRepository.findAll();
        res.json({
          users: users.map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            trustTier: u.trust_tier,
            createdAt: u.created_at,
          })),
        });
        return;
      }

      // Authenticated path: return only the caller.
      const me = await userRepository.findById(requesterId);
      res.json({
        users: me
          ? [{
              id: me.id,
              email: me.email,
              name: me.name,
              trustTier: me.trust_tier,
              createdAt: me.created_at,
            }]
          : [],
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/users
   *
   * Create a new user during onboarding. If a user with the same email
   * already exists, returns the existing user (idempotent).
   */
  router.post('/', async (req, res, next) => {
    try {
      const body = req.body as { name?: string; email?: string };
      const email = body.email?.trim();
      const name = body.name?.trim() || email || 'Anonymous';

      if (!email) {
        res.status(400).json({ error: 'Email is required to create an account.' });
        return;
      }

      // Check if user already exists
      const existing = await userRepository.findByEmail(email);
      if (existing) {
        res.json({ user: existing, created: false });
        return;
      }

      // Trust tier is always 'observer' for new users — must be earned, not declared
      // (spec 10, LOCKED 2026-06-06). Matches the DB column default and CLAUDE.md;
      // resolves the prior 3-way conflict where this line forced 'suggest'. Users
      // climb observer -> suggest via the transparent, consensual promotion engine
      // (10 consecutive approvals at >=80%, user-accepted). Callers cannot
      // self-escalate via the creation endpoint.
      const trustTier = 'observer';

      const user = await userRepository.create({
        email,
        name,
        trustTier,
      });

      // Provision the zero-content default state every real user starts from:
      // an empty twin profile + conservative autonomy settings. Idempotent and
      // best-effort — getOrCreateProfile lazily backstops if this is skipped,
      // so a provisioning hiccup never blocks user creation. (spec 10 Part A)
      try {
        await provisionNewUser(user.id);
      } catch (provisionErr) {
        // Genuinely best-effort (review): the user row already exists, and
        // getOrCreateProfile lazily backstops the profile later — so a
        // provisioning hiccup must NOT turn into a 500 (which, on client retry,
        // would then hit "email already exists"). Swallow and continue.
        console.warn('[users] provisionNewUser failed (non-blocking):', provisionErr);
      }

      res.status(201).json({ user, created: true });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/users/:userId
   */
  router.get('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'Missing userId' });
        return;
      }

      const user = await findUserByIdOrEmail(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/users/:userId/trust-tier
   */
  router.put('/:userId/trust-tier', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as { trustTier: string };

      if (!body.trustTier) {
        res.status(400).json({ error: 'Missing trustTier' });
        return;
      }

      if (!VALID_TIERS.includes(body.trustTier)) {
        res.status(400).json({
          error: `Invalid trust tier. Must be one of: ${VALID_TIERS.join(', ')}`,
        });
        return;
      }

      const user = await findUserByIdOrEmail(userId);
      const updated = user
        ? await userRepository.updateTrustTier(user.id, body.trustTier)
        : null;

      if (!updated) {
        res.status(404).json({ error: 'User not found. Complete setup first.' });
        return;
      }

      res.json({ user: updated });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/users/:userId/domains
   *
   * Save the user's enabled domains to their autonomy_settings JSON.
   */
  router.put('/:userId/domains', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as { domains?: string[] };

      if (!Array.isArray(body.domains)) {
        res.status(400).json({ error: 'Missing or invalid domains array' });
        return;
      }

      // Filter to valid domain identifiers
      const domains = body.domains.filter((d) => VALID_DOMAINS.includes(d));

      const user = await findUserByIdOrEmail(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      // Merge enabledDomains into existing autonomy_settings
      const existing =
        typeof user.autonomy_settings === 'string'
          ? JSON.parse(user.autonomy_settings)
          : user.autonomy_settings ?? {};

      const updated = { ...existing, enabledDomains: domains };
      const result = await userRepository.updateAutonomySettings(user.id, updated);

      res.json({ user: result });
    } catch (error) {
      next(error);
    }
  });

  /**
   * PUT /api/users/:userId/autonomy-pause (#379)
   *
   * Per-user kill switch. Setting `paused: true` writes
   * `autonomy_settings.paused = true` on the user row; the next decision
   * for this user escalates to manual approval regardless of trust tier.
   * Setting `paused: false` clears it. Independent of the
   * `SKYTWIN_AUTO_EXECUTE_DISABLED` operator env var — either flag
   * triggers escalation in `PolicyEvaluator`.
   */
  router.put('/:userId/autonomy-pause', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as { paused?: boolean; reason?: string };
      if (typeof body.paused !== 'boolean') {
        res.status(400).json({ error: '`paused` must be a boolean.' });
        return;
      }

      const user = await findUserByIdOrEmail(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const existing =
        typeof user.autonomy_settings === 'string'
          ? JSON.parse(user.autonomy_settings)
          : user.autonomy_settings ?? {};

      // Spread merges in so we don't blow away spend caps / domains /
      // perAppOverrides / quietHours / etc. that live in the same JSONB.
      const updated: Record<string, unknown> = {
        ...existing,
        paused: body.paused,
      };
      if (body.paused) {
        updated['pausedAt'] = new Date().toISOString();
        if (typeof body.reason === 'string' && body.reason.trim()) {
          updated['pausedReason'] = body.reason.trim().slice(0, 500);
        } else {
          delete updated['pausedReason'];
        }
      } else {
        delete updated['pausedAt'];
        delete updated['pausedReason'];
      }

      const result = await userRepository.updateAutonomySettings(user.id, updated);
      res.json({ user: result });
    } catch (error) {
      next(error);
    }
  });

  /**
   * GET /api/users/:userId/autonomy-state (#379)
   *
   * Combined pause state for the dashboard's chrome banner. Reports
   * both the operator-set env var (`SKYTWIN_AUTO_EXECUTE_DISABLED`) and
   * the per-user `autonomy_settings.paused` flag so the banner can
   * render the right copy and the right resume affordance.
   */
  router.get('/:userId/autonomy-state', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const user = await findUserByIdOrEmail(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const settings =
        typeof user.autonomy_settings === 'string'
          ? JSON.parse(user.autonomy_settings)
          : user.autonomy_settings ?? {};

      res.json({
        globalPause: process.env['SKYTWIN_AUTO_EXECUTE_DISABLED'] === 'true',
        userPause: Boolean(settings?.paused),
        pausedAt: settings?.pausedAt ?? null,
        pausedReason: settings?.pausedReason ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/users/:userId/seed-preferences
   *
   * Accept an array of {domain, key, value} and create Preference records
   * via the twin service so they feed into the decision engine from day one.
   */
  router.post('/:userId/seed-preferences', async (req, res, next) => {
    try {
      const { userId } = req.params;
      const body = req.body as {
        preferences?: Array<{ domain: string; key: string; value: unknown }>;
      };

      if (!Array.isArray(body.preferences) || body.preferences.length === 0) {
        res.status(400).json({ error: 'Missing or empty preferences array' });
        return;
      }

      const user = await findUserByIdOrEmail(userId);
      if (!user) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const MAX_SEED_PREFERENCES = 100;
      const prefs = body.preferences.slice(0, MAX_SEED_PREFERENCES);

      const validPrefs = prefs.filter((pref) => pref.domain && pref.key);
      for (const pref of validPrefs) {
        await twinService.updatePreference(user.id, {
          id: `pref_seed_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          domain: pref.domain,
          key: pref.key,
          value: pref.value,
          confidence: ConfidenceLevel.HIGH,
          source: 'explicit',
          evidenceIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      res.json({ seeded: validPrefs.length });
    } catch (error) {
      next(error);
    }
  });

  /**
   * DELETE /api/users/:userId (#376)
   *
   * Right-to-erasure / "delete my account" endpoint. Wipes every row
   * belonging to the user in a single CRDB serializable transaction
   * via `userPurgeRepository.purgeUser` — twin profile, decision
   * history, memory pages, knowledge triples, episodic memories,
   * preferences, OAuth tokens, spend records, sessions, every
   * cascade-bearing user_id FK from migration 061 (#413), plus the
   * chained children that FK to those tables via non-user-id columns
   * (`candidate_actions.decision_id`, `execution_plans.decision_id`,
   * `twin_profile_versions.profile_id`, etc.). Failure anywhere
   * rolls the whole thing back — no partial-delete state.
   *
   * The caller's own session middleware (`sessionAuth` plus the user-param
   * ownership check above) gates this to the user themselves — a session token for user A cannot
   * delete user B. After the delete the caller's own session row is
   * also gone (cascades via `sessions.user_id`), so the response is
   * the last useful thing they'll get from this server until they
   * sign up again.
   *
   * Requires `?confirm=delete-my-data` on the query string. The
   * dashboard's Settings page wires this when the user clicks
   * through the confirmation modal. The check is defensive — a
   * forgotten DELETE in a test that hits the wrong env shouldn't
   * blow away the row by accident.
   */
  router.delete('/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (req.query['confirm'] !== 'delete-my-data') {
        res.status(400).json({
          error: 'confirmation_required',
          message:
            'Pass ?confirm=delete-my-data to confirm a permanent purge of every row belonging to this user.',
        });
        return;
      }

      const targetUserId = isValidUserId(userId)
        ? userId
        : (await findUserByIdOrEmail(userId))?.id;
      if (!targetUserId) {
        res.status(404).json({
          error: 'user_not_found',
          message: 'No user with that id existed at delete time.',
          counts: {},
        });
        return;
      }

      const result = await userPurgeRepository.purgeUser(targetUserId);

      if (!result.userExisted) {
        res.status(404).json({
          error: 'user_not_found',
          message: 'No user with that id existed at delete time.',
          counts: result.counts,
        });
        return;
      }

      res.json({
        deleted: true,
        userId: targetUserId,
        counts: result.counts,
        totalRows: result.total,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
