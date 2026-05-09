import nacl from 'tweetnacl';
import { randomInt } from 'node:crypto';

/**
 * Pairing crypto helpers for federation (#194 Child 1).
 *
 * NaCl box (Curve25519 + XSalsa20 + Poly1305) — same primitive used by
 * libsodium and signal protocol. tweetnacl-js is the audited pure-JS port,
 * ~50KB unzipped, no native deps.
 *
 * Why NaCl box and not just HMAC: the worker's federation-sync needs
 * confidentiality (the deltas include trust-tier and risk-profile data
 * the user wouldn't want trivially observable on a shared LAN). Box gives
 * us asymmetric encryption-and-authentication in a single primitive, no
 * key-agreement ceremony beyond the pair-time exchange.
 *
 * All keys are stored as standard base64 (not URL-safe) — they live only
 * in DB rows and never appear in URLs.
 */

export interface KeyPair {
  publicKeyB64: string;
  secretKeyB64: string;
}

const PAIRING_CODE_DIGITS = 6;

/** Generate a fresh NaCl box keypair. Returns base64 strings. */
export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return {
    publicKeyB64: Buffer.from(kp.publicKey).toString('base64'),
    secretKeyB64: Buffer.from(kp.secretKey).toString('base64'),
  };
}

/**
 * 6-digit pairing code shown to the user at the originating instance.
 * Uses `randomInt` (CSPRNG-backed) rather than `Math.random` — the code
 * is what an attacker would need to guess to inject themselves into a
 * pairing window. 6 digits × 10-minute TTL × max 1 active code per user
 * keeps the brute-force surface tractable.
 */
export function generatePairingCode(): string {
  const max = Math.pow(10, PAIRING_CODE_DIGITS);
  return String(randomInt(0, max)).padStart(PAIRING_CODE_DIGITS, '0');
}

export function isValidPairingCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    code.length === PAIRING_CODE_DIGITS &&
    /^\d+$/.test(code)
  );
}

export function isValidBase64Key(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  // Standard base64 over 32 bytes → 44 chars (32×4/3 = 42.67, rounded up
  // with one '=' pad). Be liberal but not too liberal.
  if (s.length < 40 || s.length > 60) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    const buf = Buffer.from(s, 'base64');
    return buf.length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
}

/**
 * Encrypt a JSON-serializable payload from sender → recipient. Returns
 * `{ nonceB64, ciphertextB64 }`. Used by the worker's federation-sync
 * to wrap delta payloads.
 */
export function sealMessage(
  payload: unknown,
  recipientPublicKeyB64: string,
  senderSecretKeyB64: string,
): { nonceB64: string; ciphertextB64: string } {
  const message = Buffer.from(JSON.stringify(payload), 'utf8');
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const recipientPub = Buffer.from(recipientPublicKeyB64, 'base64');
  const senderSec = Buffer.from(senderSecretKeyB64, 'base64');
  const ciphertext = nacl.box(
    new Uint8Array(message),
    nonce,
    new Uint8Array(recipientPub),
    new Uint8Array(senderSec),
  );
  return {
    nonceB64: Buffer.from(nonce).toString('base64'),
    ciphertextB64: Buffer.from(ciphertext).toString('base64'),
  };
}

/**
 * Open an inbound sealed message. Returns null on auth failure (wrong
 * key, tampered ciphertext) — callers should treat null as "drop this
 * delta and log a warning."
 */
export function openMessage(
  nonceB64: string,
  ciphertextB64: string,
  senderPublicKeyB64: string,
  recipientSecretKeyB64: string,
): unknown | null {
  try {
    const nonce = new Uint8Array(Buffer.from(nonceB64, 'base64'));
    const ciphertext = new Uint8Array(Buffer.from(ciphertextB64, 'base64'));
    const senderPub = new Uint8Array(Buffer.from(senderPublicKeyB64, 'base64'));
    const recipientSec = new Uint8Array(Buffer.from(recipientSecretKeyB64, 'base64'));
    const opened = nacl.box.open(ciphertext, nonce, senderPub, recipientSec);
    if (opened === null) return null;
    return JSON.parse(Buffer.from(opened).toString('utf8'));
  } catch {
    return null;
  }
}
