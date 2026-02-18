/**
 * lib/crypto/encrypt.ts
 *
 * AES-256-GCM symmetric encryption utility for short secrets (tokens, keys).
 *
 * Security properties:
 *   - AES-256-GCM: authenticated encryption — detects tampering via auth tag.
 *   - Random 12-byte IV per encrypt call — prevents IV reuse across payloads.
 *   - Auth tag verified before any plaintext is returned from decrypt().
 *   - Encryption key is validated at module load and never logged or exported.
 *   - All decryption failures throw an opaque DecryptionError — no internal
 *     detail (ciphertext, key material, or original error) leaks out.
 *
 * Wire format (returned by encrypt, consumed by decrypt):
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 *   12 bytes : 16 bytes   : variable
 *
 * Required env var:
 *   TOKEN_ENCRYPTION_KEY — 64-character lowercase hex string (32 bytes).
 *   Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// ─── Algorithm constants ──────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES  = 12   // 96-bit IV — NIST recommended for GCM
const TAG_BYTES = 16   // 128-bit auth tag — full GCM default

// ─── Key bootstrap ────────────────────────────────────────────────────────────
//
// The key is loaded once when the module is first imported.  Any configuration
// error surfaces immediately at startup rather than silently at call time.
//
// The resolved key Buffer lives in a module-scoped closure.  It is:
//   - Never logged (no console.log / console.error referencing it)
//   - Never exported (only encrypt() and decrypt() are exported)
//   - Never interpolated into error messages

const _key: Buffer = (() => {
  const raw = process.env.TOKEN_ENCRYPTION_KEY

  if (!raw) {
    throw new Error(
      '[crypto] TOKEN_ENCRYPTION_KEY is required but not set. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
  }

  // Must be exactly 64 hex chars (32 bytes = 256-bit key).
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      '[crypto] TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes / 256 bits).',
    )
  }

  return Buffer.from(raw, 'hex')
})()

// ─── Safe error class ─────────────────────────────────────────────────────────

/**
 * Thrown by decrypt() on any failure — malformed payload, auth tag mismatch
 * (tampered or corrupt data), wrong key, or invalid encoding.
 *
 * The message intentionally contains no ciphertext, plaintext, or key material.
 */
export class DecryptionError extends Error {
  constructor() {
    super(
      '[crypto] Decryption failed — payload is malformed, tampered, corrupt, ' +
      'or was encrypted with a different key.',
    )
    this.name = 'DecryptionError'
  }
}

// ─── encrypt ──────────────────────────────────────────────────────────────────

/**
 * Encrypts a UTF-8 plaintext string with AES-256-GCM.
 *
 * A fresh cryptographically random IV is generated for every call, so two
 * encryptions of the same plaintext will produce different ciphertexts.
 *
 * @returns A colon-delimited hex string: `<iv>:<authTag>:<ciphertext>`
 *          Safe to store in a database column or environment variable.
 */
export function encrypt(text: string): string {
  const iv     = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, _key, iv)

  const ciphertext = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ])

  const authTag = cipher.getAuthTag()

  // Encode all three components as lowercase hex and join with ':'
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

// ─── decrypt ──────────────────────────────────────────────────────────────────

/**
 * Decrypts a payload produced by encrypt().
 *
 * GCM authentication is verified before any plaintext bytes are released.
 * If the auth tag does not match — indicating tampering or a wrong key —
 * Node's crypto module throws during `decipher.final()`, which is caught and
 * rethrown as a DecryptionError with no internal detail.
 *
 * @throws {DecryptionError} on any failure.  Never throws a raw crypto error
 *         or any error that might contain ciphertext or key hints.
 */
export function decrypt(cipherText: string): string {
  try {
    // ── Parse wire format ──────────────────────────────────────────────────
    const parts = cipherText.split(':')

    if (parts.length !== 3) {
      // Malformed — throw immediately before any Buffer allocation.
      throw new Error('invalid segment count')
    }

    const [ivHex, tagHex, dataHex] = parts

    const iv        = Buffer.from(ivHex,   'hex')
    const authTag   = Buffer.from(tagHex,  'hex')
    const encrypted = Buffer.from(dataHex, 'hex')

    // ── Structural validation before constructing decipher ────────────────
    // Avoids leaking timing information by validating lengths before keying.
    if (iv.length      !== IV_BYTES)  throw new Error('invalid iv length')
    if (authTag.length !== TAG_BYTES) throw new Error('invalid tag length')
    if (encrypted.length === 0)       throw new Error('empty ciphertext')

    // ── Decrypt and authenticate ───────────────────────────────────────────
    const decipher = createDecipheriv(ALGORITHM, _key, iv)
    decipher.setAuthTag(authTag)

    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),   // ← throws if auth tag is invalid (tampered/wrong key)
    ])

    return plaintext.toString('utf8')

  } catch (_err) {
    // Swallow all internal errors — auth failures, bad hex, wrong lengths,
    // empty segments — and surface only the safe opaque DecryptionError.
    //
    // DO NOT log _err here: it may contain ciphertext slices from Node internals.
    throw new DecryptionError()
  }
}

// ─── isEncryptedPayload ───────────────────────────────────────────────────────

/**
 * Returns true if the string looks like a payload produced by encrypt().
 * Useful for migration guards: distinguishes already-encrypted values from
 * plaintext values that need encrypting.
 *
 * This is a format check only — it does NOT attempt decryption.
 */
export function isEncryptedPayload(value: string): boolean {
  const parts = value.split(':')
  if (parts.length !== 3) return false

  const [ivHex, tagHex, dataHex] = parts
  const hexRe = /^[0-9a-f]+$/i

  return (
    hexRe.test(ivHex)   && ivHex.length   === IV_BYTES  * 2 &&
    hexRe.test(tagHex)  && tagHex.length  === TAG_BYTES * 2 &&
    hexRe.test(dataHex) && dataHex.length  >  0
  )
}
