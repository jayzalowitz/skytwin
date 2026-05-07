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
import { credentialVaultMetaRepository, oauthRepository, withTransaction } from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import {
  deriveKey,
  generateSalt,
  hashDerivedKey,
  verifyPassphrase,
  MIN_PASSPHRASE_LENGTH,
  KeyCache,
  encrypt,
  decrypt,
  IV_LENGTH,
  TAG_LENGTH,
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

// ── Rotate rate limit (per user, 5/minute — same parameters as unlock) ────────

const rotateBuckets = new Map<string, { count: number; resetAt: number }>();

function evictExpiredRotateBuckets(now: number): void {
  for (const [key, bucket] of rotateBuckets) {
    if (bucket.resetAt <= now) rotateBuckets.delete(key);
  }
}

export function checkRotateRateLimit(
  userId: string,
  now: number = Date.now(),
): { allowed: boolean; resetAt: number } {
  let bucket = rotateBuckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    if (rotateBuckets.size >= UNLOCK_RATE_LIMIT_MAX_BUCKETS) {
      evictExpiredRotateBuckets(now);
      while (rotateBuckets.size >= UNLOCK_RATE_LIMIT_MAX_BUCKETS) {
        const oldest = rotateBuckets.keys().next().value;
        if (oldest === undefined) break;
        rotateBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, resetAt: now + UNLOCK_RATE_LIMIT_WINDOW_MS };
    rotateBuckets.set(userId, bucket);
  }
  if (bucket.count >= UNLOCK_RATE_LIMIT_MAX) {
    return { allowed: false, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return { allowed: true, resetAt: bucket.resetAt };
}

/** Test helper — reset rotate rate limit state between test cases. */
export function _resetRotateRateLimitForTests(): void {
  rotateBuckets.clear();
}

// ── Pack/unpack helpers (same format as DbTokenStore) ────────────────────────

function packEncrypted(result: { ciphertext: Buffer; iv: Buffer; tag: Buffer }): Buffer {
  return Buffer.concat([result.iv, result.tag, result.ciphertext]);
}

function unpackEncrypted(packed: Buffer): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  return { iv, tag, ciphertext };
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

  // ── POST /rotate ────────────────────────────────────────────────────────────
  // Body: { currentPassphrase: string; newPassphrase: string }
  //
  // Flow:
  //   1. Validate newPassphrase length.
  //   2. Verify currentPassphrase against stored hash (rate-limited 5/min).
  //   3. Derive old key and new key.
  //   4. Serialisable transaction:
  //      a. SELECT all oauth_tokens rows with encrypted_access_token IS NOT NULL.
  //      b. For each row: decrypt with oldKey, re-encrypt with newKey, UPDATE.
  //      c. UPDATE user_credential_vault_meta (salt, hash, key_version + 1).
  //   5. Replace old key in KeyCache; zero-fill old key buffer.
  //   6. Return { status: 'rotated', tokensReencrypted: N, keyVersion: N }.
  //
  // On any failure inside the transaction: ROLLBACK, return 500.
  // The user's original passphrase continues to work.
  router.post('/rotate', async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId) {
        res.status(400).json({ error: 'userId is required' });
        return;
      }

      const body = req.body as { currentPassphrase?: unknown; newPassphrase?: unknown };

      if (typeof body.newPassphrase !== 'string') {
        res.status(422).json({ error: 'newPassphrase must be a string' });
        return;
      }

      if (body.newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
        res.status(422).json({
          error: `newPassphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
        });
        return;
      }

      if (typeof body.currentPassphrase !== 'string') {
        res.status(422).json({ error: 'currentPassphrase must be a string' });
        return;
      }

      // Rate-limit the current-passphrase verify path (same 5/min as unlock)
      const { allowed, resetAt } = checkRotateRateLimit(userId);
      if (!allowed) {
        res.setHeader('Retry-After', String(Math.ceil((resetAt - Date.now()) / 1000)));
        res.status(429).json({
          error: 'Too many rotation attempts. Please wait before retrying.',
          retryAfterMs: resetAt - Date.now(),
        });
        return;
      }

      // Check vault is initialised
      const meta = await credentialVaultMetaRepository.getForUser(userId);
      if (!meta) {
        res.status(400).json({ error: 'Credential vault has not been initialised for this user' });
        return;
      }

      // Verify current passphrase
      const valid = await verifyPassphrase(
        body.currentPassphrase,
        meta.passphrase_salt,
        meta.passphrase_hash,
      );
      if (!valid) {
        log.warn('Credential vault rotation failed: wrong current passphrase', { userId });
        res.status(401).json({ error: 'Wrong passphrase' });
        return;
      }

      // Derive keys outside the transaction (scrypt is expensive; avoid holding a
      // DB connection during the derivation).
      const oldKey = await deriveKey(body.currentPassphrase, meta.passphrase_salt);
      const newSalt = generateSalt();
      const newKey = await deriveKey(body.newPassphrase, newSalt);
      const newHash = hashDerivedKey(newKey);

      let tokensReencrypted = 0;
      let newKeyVersion: number;

      try {
        newKeyVersion = await withTransaction(async (client) => {
          // SELECT all encrypted rows for this user — inside the transaction
          // so a concurrent token write between SELECT and UPDATE cannot be
          // silently overwritten.
          const rows = await oauthRepository.listEncryptedForUser(userId, client);

          // Re-encrypt each row
          for (const row of rows) {
            if (!row.encrypted_access_token || !row.encrypted_refresh_token) continue;

            const {
              iv: atIv,
              tag: atTag,
              ciphertext: atCipher,
            } = unpackEncrypted(row.encrypted_access_token);
            const {
              iv: rtIv,
              tag: rtTag,
              ciphertext: rtCipher,
            } = unpackEncrypted(row.encrypted_refresh_token);

            const accessToken = decrypt({ ciphertext: atCipher, iv: atIv, tag: atTag }, oldKey);
            const refreshToken = decrypt(
              { ciphertext: rtCipher, iv: rtIv, tag: rtTag },
              oldKey,
            );

            const newAtPacked = packEncrypted(encrypt(accessToken, newKey));
            const newRtPacked = packEncrypted(encrypt(refreshToken, newKey));

            await oauthRepository.rotateEncrypted(
              row.id,
              {
                encryptedAccessToken: newAtPacked,
                encryptedRefreshToken: newRtPacked,
                keyVersion: meta.current_key_version + 1,
              },
              client,
            );
            tokensReencrypted += 1;
          }

          // Update meta row — new salt, new hash, bump key_version
          const kv = await credentialVaultMetaRepository.rotatePassphrase(
            userId,
            { newSalt, newPassphraseHash: newHash },
            client,
          );
          if (kv === null) {
            throw new Error('rotatePassphrase: meta row not found during transaction');
          }
          return kv;
        });
      } catch (txErr) {
        // Transaction rolled back. Old passphrase still valid.
        // Zero out keys regardless of which failed.
        oldKey.fill(0);
        newKey.fill(0);
        log.error('Credential vault rotation transaction failed; rolled back', {
          userId,
          tokensAttempted: tokensReencrypted,
        });
        next(txErr);
        return;
      }

      // Commit succeeded — update in-memory KeyCache
      sharedKeyCache.set(userId, newKey);

      // Defense-in-depth: zero the old key buffer now it's no longer needed
      oldKey.fill(0);

      log.info('Credential vault passphrase rotated', {
        userId,
        tokensReencrypted,
        newKeyVersion,
      });

      res.status(200).json({
        status: 'rotated',
        tokensReencrypted,
        keyVersion: newKeyVersion,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
