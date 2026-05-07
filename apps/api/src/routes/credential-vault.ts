/**
 * credential-vault.ts — API routes for the per-user credential vault.
 *
 * Routes (all require sessionAuth + requireOwnership):
 *   POST /api/credential-vault/init    — initialise vault with a passphrase
 *   POST /api/credential-vault/unlock  — derive key + populate KeyCache
 *   POST /api/credential-vault/lock    — evict key from KeyCache
 *   GET  /api/credential-vault/status  — { initialized, unlocked }
 *
 * Rate limit: 5 unlock attempts per minute per user (per-process in-memory).
 */

import { Router } from 'express';
import type { Request } from 'express';
import { credentialVaultMetaRepository } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import {
  deriveKey,
  generateSalt,
  hashDerivedKey,
  verifyPassphrase,
  MIN_PASSPHRASE_LENGTH,
  KeyCache,
} from '@skytwin/credential-vault';

const log = createLogger('api:credential-vault');

// ── Shared KeyCache singleton ─────────────────────────────────────────────────
// Exported so other modules (DbTokenStore, tests) can inject it.
export const sharedKeyCache = new KeyCache({ ttlMs: 60 * 60 * 1000 }); // 1 hour

// ── Unlock rate limit (per user, 5/minute) ────────────────────────────────────
export const UNLOCK_RATE_LIMIT_MAX = 5;
export const UNLOCK_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const UNLOCK_RATE_LIMIT_MAX_BUCKETS = 10_000;

const unlockBuckets = new Map<string, { count: number; resetAt: number }>();

function evictExpiredUnlockBuckets(now: number): void {
  for (const [key, bucket] of unlockBuckets) {
    if (bucket.resetAt <= now) unlockBuckets.delete(key);
  }
}

export function checkUnlockRateLimit(
  userId: string,
  now: number = Date.now(),
): { allowed: boolean; resetAt: number } {
  let bucket = unlockBuckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    if (unlockBuckets.size >= UNLOCK_RATE_LIMIT_MAX_BUCKETS) {
      evictExpiredUnlockBuckets(now);
      while (unlockBuckets.size >= UNLOCK_RATE_LIMIT_MAX_BUCKETS) {
        const oldest = unlockBuckets.keys().next().value;
        if (oldest === undefined) break;
        unlockBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + UNLOCK_RATE_LIMIT_WINDOW_MS };
    unlockBuckets.set(userId, bucket);
  }
  if (bucket.count >= UNLOCK_RATE_LIMIT_MAX) {
    return { allowed: false, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return { allowed: true, resetAt: bucket.resetAt };
}

/** Test helper — reset unlock rate limit state between test cases. */
export function _resetUnlockRateLimitForTests(): void {
  unlockBuckets.clear();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserId(req: Request): string | undefined {
  const asAny = req as unknown as { user?: { id?: string } };
  return asAny.user?.id;
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createCredentialVaultRouter(): Router {
  const router = Router();

  // ── POST /init ─────────────────────────────────────────────────────────────
  // Body: { passphrase: string }
  // Generates salt, derives key, stores passphrase_salt + passphrase_hash.
  // Returns 200 on success.
  // Returns 400 if vault already initialised.
  // Returns 422 if passphrase too weak (< MIN_PASSPHRASE_LENGTH chars).
  router.post('/init', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { passphrase?: unknown };
      if (typeof body.passphrase !== 'string') {
        res.status(422).json({ error: 'passphrase must be a string' });
        return;
      }

      if (body.passphrase.length < MIN_PASSPHRASE_LENGTH) {
        res.status(422).json({
          error: `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
        });
        return;
      }

      // Check for existing vault
      const existing = await credentialVaultMetaRepository.getForUser(userId);
      if (existing) {
        res.status(400).json({ error: 'Credential vault is already initialised for this user' });
        return;
      }

      const salt = generateSalt();
      const derivedKey = await deriveKey(body.passphrase, salt);
      const passphraseHash = hashDerivedKey(derivedKey);

      await credentialVaultMetaRepository.create(userId, salt, passphraseHash);

      // Cache the key immediately — user is implicitly "unlocked" after init
      sharedKeyCache.set(userId, derivedKey);

      log.info('Credential vault initialised', { userId });

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /unlock ────────────────────────────────────────────────────────────
  // Body: { passphrase: string }
  // Verifies passphrase, populates KeyCache on success.
  // Returns 200 on success.
  // Returns 401 on wrong passphrase.
  // Returns 429 when rate limit is exceeded.
  // Returns 404 if vault has not been initialised.
  router.post('/unlock', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      // Rate limit: 5 attempts per minute per user
      const { allowed, resetAt } = checkUnlockRateLimit(userId);
      if (!allowed) {
        res.setHeader('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
        res.status(429).json({
          error: 'Too many unlock attempts. Please wait before retrying.',
          retryAfterMs: resetAt - Date.now(),
        });
        return;
      }

      const body = req.body as { passphrase?: unknown };
      if (typeof body.passphrase !== 'string') {
        res.status(422).json({ error: 'passphrase must be a string' });
        return;
      }

      const meta = await credentialVaultMetaRepository.getForUser(userId);
      if (!meta) {
        res.status(404).json({ error: 'Credential vault has not been initialised for this user' });
        return;
      }

      const valid = await verifyPassphrase(body.passphrase, meta.passphrase_salt, meta.passphrase_hash);
      if (!valid) {
        // Do NOT log the passphrase — not even redacted
        log.warn('Credential vault unlock failed: wrong passphrase', { userId });
        res.status(401).json({ error: 'Wrong passphrase' });
        return;
      }

      // Derive the key and cache it
      const derivedKey = await deriveKey(body.passphrase, meta.passphrase_salt);
      sharedKeyCache.set(userId, derivedKey);

      log.info('Credential vault unlocked', { userId });

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /lock ─────────────────────────────────────────────────────────────
  // Evicts the derived key for this user from KeyCache.
  // Returns 200 always (idempotent — locking an already-locked vault is fine).
  router.post('/lock', (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      sharedKeyCache.evict(userId);
      log.info('Credential vault locked', { userId });

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /status ─────────────────────────────────────────────────────────────
  // Returns { initialized: boolean; unlocked: boolean }.
  router.get('/status', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const meta = await credentialVaultMetaRepository.getForUser(userId);
      const initialized = meta !== null;
      const unlocked = sharedKeyCache.has(userId);

      res.status(200).json({ initialized, unlocked });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
