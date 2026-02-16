/**
 * Cryptographic primitives — Ed25519 signing, X25519 key exchange, AES-256-GCM encryption.
 *
 * Zero external dependencies — uses Node.js built-in `crypto` module only.
 */

import {
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
} from 'node:crypto';

// Field prime for Curve25519: 2^255 - 19
const P = (1n << 255n) - 19n;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function modInverse(a: bigint, mod: bigint): bigint {
  return modPow(a, mod - 2n, mod);
}

/**
 * Generate a new Ed25519 keypair.
 */
export function generateEd25519Keypair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

/**
 * Convert Ed25519 public key to X25519 public key.
 * Uses the birational map: u = (1 + y) / (1 - y) mod p
 */
export function ed25519PubToX25519(edPubKey: Buffer): Buffer {
  // Ed25519 public key is 32 bytes (the compressed y-coordinate with sign bit)
  const yBytes = Buffer.from(edPubKey);
  // Clear the sign bit to get y
  const lastByte = yBytes[31]!;
  yBytes[31] = lastByte & 0x7f;

  // Convert to BigInt (little-endian)
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(yBytes[i]!) << BigInt(8 * i);
  }

  // u = (1 + y) / (1 - y) mod p
  const numerator = (1n + y) % P;
  const denominator = ((1n - y) % P + P) % P;
  const u = (numerator * modInverse(denominator, P)) % P;

  // Convert back to 32-byte little-endian Buffer
  const result = Buffer.alloc(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    result[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return result;
}

/**
 * Derive X25519 private key from Ed25519 private key seed.
 * SHA-512(seed)[0:32] with clamping per RFC 7748.
 */
export function ed25519PrivToX25519(ed25519Seed: Buffer): Buffer {
  const hash = createHash('sha512').update(ed25519Seed).digest();
  const scalar = hash.subarray(0, 32);
  // Clamp per RFC 7748
  scalar[0]! &= 248;
  scalar[31]! &= 127;
  scalar[31]! |= 64;
  return Buffer.from(scalar);
}

/**
 * Derive shared AES-256 key from X25519 ECDH.
 */
export function deriveSharedKey(
  myX25519Priv: Buffer,
  theirX25519Pub: Buffer,
  senderId: string,
  recipientId: string,
): Buffer {
  const myKey = createPrivateKey({
    key: Buffer.concat([
      // X25519 PKCS8 prefix
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      myX25519Priv,
    ]),
    format: 'der',
    type: 'pkcs8',
  });

  const theirKey = createPublicKey({
    key: Buffer.concat([
      // X25519 SPKI prefix
      Buffer.from('302a300506032b656e032100', 'hex'),
      theirX25519Pub,
    ]),
    format: 'der',
    type: 'spki',
  });

  const shared = diffieHellman({ privateKey: myKey, publicKey: theirKey });

  // Sort sender:recipient alphabetically for consistent key derivation
  const info = [senderId, recipientId].sort().join(':');
  return Buffer.from(
    hkdfSync('sha256', shared, 'cc4me-e2e-v1', info, 32),
  );
}

/**
 * Encrypt plaintext with AES-256-GCM.
 */
export function encrypt(
  plaintext: Buffer,
  key: Buffer,
  messageId: string,
): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(messageId));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]),
    nonce,
  };
}

/**
 * Decrypt ciphertext with AES-256-GCM.
 */
export function decrypt(
  ciphertext: Buffer,
  nonce: Buffer,
  key: Buffer,
  messageId: string,
): Buffer {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(messageId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * Extract raw Ed25519 key bytes from a KeyObject.
 * Returns the 32-byte seed (private) and 32-byte public key.
 */
export function getEd25519RawKeys(privateKey: KeyObject): { seed: Buffer; publicKeyRaw: Buffer } {
  // PKCS8 DER for Ed25519: 48 bytes total, seed starts at offset 16
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = Buffer.from(pkcs8.subarray(16, 48));

  // Derive public key and get raw bytes
  const pubKeyObj = createPublicKey(privateKey);
  const spki = pubKeyObj.export({ type: 'spki', format: 'der' });
  // SPKI DER for Ed25519: 44 bytes total, raw key starts at offset 12
  const publicKeyRaw = Buffer.from(spki.subarray(12, 44));

  return { seed, publicKeyRaw };
}

/**
 * Sign data with Ed25519.
 * Ed25519 uses its own built-in hash (SHA-512), so algorithm is null.
 */
export function sign(data: Buffer, privateKey: KeyObject): Buffer {
  return Buffer.from(cryptoSign(null, data, privateKey));
}

/**
 * Verify Ed25519 signature.
 */
export function verify(data: Buffer, signature: Buffer, publicKey: KeyObject): boolean {
  return cryptoVerify(null, data, publicKey, signature);
}
