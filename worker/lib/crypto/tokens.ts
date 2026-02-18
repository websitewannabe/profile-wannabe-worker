/**
 * worker/lib/crypto/tokens.ts
 *
 * AES-256-GCM token encryption/decryption for the worker runtime.
 *
 * Wire format (must stay in sync with SaaS):
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 *   12 bytes : 16 bytes   : variable
 *
 * Tokens encrypted by SaaS using the same TOKEN_ENCRYPTION_KEY are
 * transparently decryptable here because this module delegates to the
 * canonical implementation in lib/crypto/encrypt.ts — no duplication,
 * no format drift.
 *
 * Required env var:
 *   TOKEN_ENCRYPTION_KEY — 64-character lowercase hex string (32 bytes).
 *   Must be the same value set in the SaaS environment.
 */

export {
  encrypt,
  decrypt,
  isEncryptedPayload,
  DecryptionError,
} from '../../../lib/crypto/encrypt'
