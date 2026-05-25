import { Router } from 'express';
import {
  federationPairingCodeRepository,
  federationPeerRepository,
} from '@skytwin/db';
import { createLogger } from '@skytwin/core';
import {
  generateKeyPair,
  generatePairingCode,
  isValidBase64Key,
  isValidPairingCode,
} from '../federation/crypto.js';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import { bindUserIdParamValidator } from '../middleware/validate-uuid.js';

const log = createLogger('api:federation');

const PAIRING_CODE_TTL_SECONDS = 600; // 10 minutes — same window the user sees in UI

/**
 * Federation routes (#194 Child 1).
 *
 *   POST   /api/federation/pair/start                — generate code + ephemeral keypair (initiator)
 *   POST   /api/federation/pair/complete             — claim a code, exchange public keys (joiner)
 *   GET    /api/federation/peers/:userId             — list active peers
 *   POST   /api/federation/peers/:userId/:peerId/unpair  — soft-unpair
 *
 * The pair/start and pair/complete flow:
 *   - User on instance A clicks "Pair with another device", calls /pair/start.
 *     We generate a NaCl keypair, persist (secret_key, public_key, code)
 *     to federation_pairing_codes, and return `{ code, publicKey }` to
 *     the renderer — the renderer shows `code` to the user.
 *   - User on instance B enters that code. Instance B calls /pair/complete
 *     with `{ code, label, peerPublicKey, endpointUrl? }`.
 *   - We validate the code, copy the originating instance's keypair into
 *     a federation_peers row (label, peer_public_key, our local keys),
 *     consume the code, and return the row.
 *   - Instance B persists its side of the keypair locally and now has a
 *     paired federation_peers row.
 *
 * NOTE: this MVP performs the key exchange via the central API — both
 * instances are the same user, talking to the same backend. Cross-instance
 * direct exchange (peer-to-peer over LAN) is the natural follow-up but
 * adds discovery + NAT-traversal complexity that v1 doesn't need.
 */
export function createFederationRouter(): Router {
  const router = Router();
  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);

  /**
   * Initiator-side: generate pairing code + ephemeral keypair.
   * Body: `{ userId }`.
   * Returns `{ code, publicKey, expiresAt }`. The renderer displays
   * `code` to the user.
   */
  router.post('/pair/start', async (req, res, next) => {
    try {
      const userId = (req.body as { userId?: unknown })?.userId;
      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      const kp = generateKeyPair();
      const code = generatePairingCode();
      const row = await federationPairingCodeRepository.create({
        userId,
        code,
        localSecretKey: kp.secretKeyB64,
        localPublicKey: kp.publicKeyB64,
        ttlSeconds: PAIRING_CODE_TTL_SECONDS,
      });
      log.info('Pairing code generated', { userId, expiresAt: row.expires_at });
      res.json({
        code,
        publicKey: kp.publicKeyB64,
        expiresAt: row.expires_at.toISOString(),
        ttlSeconds: PAIRING_CODE_TTL_SECONDS,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Joiner-side: redeem a pairing code with our own public key + label.
   * Body: `{ userId, code, label, peerPublicKey, endpointUrl? }`.
   * Returns the persisted federation_peers row.
   *
   * Validation:
   * - `code` must be exactly 6 numeric digits
   * - `peerPublicKey` must base64-decode to 32 bytes
   * - `label` must be 1-80 chars
   * - active code must exist and not be expired
   * - the code's user_id must match the request userId
   */
  router.post('/pair/complete', async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const userId = body['userId'];
      const code = body['code'];
      const label = body['label'];
      const peerPublicKey = body['peerPublicKey'];
      const endpointUrl = body['endpointUrl'];

      if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      if (!isValidPairingCode(code)) {
        res.status(400).json({ error: 'code must be a 6-digit numeric string' });
        return;
      }
      if (typeof label !== 'string' || label.length === 0 || label.length > 80) {
        res.status(400).json({ error: 'label required (1-80 chars)' });
        return;
      }
      if (!isValidBase64Key(peerPublicKey)) {
        res.status(400).json({ error: 'peerPublicKey must be a 32-byte base64 NaCl public key' });
        return;
      }
      if (
        endpointUrl !== undefined &&
        endpointUrl !== null &&
        endpointUrl !== '' &&
        (typeof endpointUrl !== 'string' || !/^https?:\/\//.test(endpointUrl))
      ) {
        res.status(400).json({ error: 'endpointUrl must be an http(s) URL' });
        return;
      }

      const codeRow = await federationPairingCodeRepository.findActiveByCode(code);
      if (!codeRow) {
        res.status(404).json({ error: 'pairing code not found or expired' });
        return;
      }
      if (codeRow.user_id !== userId) {
        // Pairing codes are scoped to the originating user. A different
        // userId trying to redeem is either a bug or an attempted hijack.
        log.warn('Pairing code redeemed by wrong user', {
          userId,
          codeUserId: codeRow.user_id,
        });
        res.status(403).json({ error: 'pairing code not for this user' });
        return;
      }

      const peer = await federationPeerRepository.create({
        userId,
        label,
        peerPublicKey,
        // Our keys for this peer come from the pairing code row — the
        // initiator's freshly-generated pair.
        localSecretKey: codeRow.local_secret_key,
        localPublicKey: codeRow.local_public_key,
        ...(typeof endpointUrl === 'string' && endpointUrl.length > 0
          ? { endpointUrl }
          : {}),
      });
      await federationPairingCodeRepository.consume(codeRow.id);

      log.info('Federation peer paired', { userId, peerId: peer.id, label });
      res.json({ peer: rowToJson(peer) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/peers/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;
      if (!userId) {
        res.status(400).json({ error: 'userId required' });
        return;
      }
      const peers = await federationPeerRepository.listActive(userId);
      res.json({ peers: peers.map(rowToJson) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/peers/:userId/:peerId/unpair', async (req, res, next) => {
    try {
      const { userId, peerId } = req.params;
      if (!userId || !peerId) {
        res.status(400).json({ error: 'userId and peerId required' });
        return;
      }
      const updated = await federationPeerRepository.unpair(userId, peerId);
      res.json({ updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

interface PeerJson {
  id: string;
  label: string;
  publicKey: string;
  endpointUrl: string | null;
  pairedAt: string;
  lastSyncAt: string | null;
  lastSyncStatus: 'ok' | 'failed' | 'never' | 'paused' | null;
}

function rowToJson(r: import('@skytwin/db').FederationPeerRow): PeerJson {
  return {
    id: r.id,
    label: r.label,
    publicKey: r.peer_public_key,
    endpointUrl: r.endpoint_url,
    pairedAt: r.paired_at.toISOString(),
    lastSyncAt: r.last_sync_at?.toISOString() ?? null,
    lastSyncStatus: r.last_sync_status,
  };
}
