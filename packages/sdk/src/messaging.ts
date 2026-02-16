/**
 * P2P encrypted messaging — build and process wire envelopes.
 *
 * Send flow:  payload → JSON → AES-256-GCM encrypt → Ed25519 sign → WireEnvelope
 * Receive flow: WireEnvelope → Ed25519 verify → AES-256-GCM decrypt → JSON parse → payload
 *
 * Key exchange: Ed25519 keys → X25519 conversion → ECDH → HKDF → AES-256 key
 */

import { randomUUID, createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import {
  getEd25519RawKeys,
  ed25519PubToX25519,
  ed25519PrivToX25519,
  deriveSharedKey,
  encrypt,
  decrypt,
  sign,
  verify,
} from './crypto.js';
import { signablePayload, validateEnvelope, isVersionCompatible } from './wire.js';
import type { WireEnvelope } from './types.js';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Decode a base64 SPKI DER public key to raw 32-byte Ed25519 key.
 */
export function decodePublicKeyRaw(publicKeyBase64: string): Buffer {
  const der = Buffer.from(publicKeyBase64, 'base64');
  // SPKI DER for Ed25519: 44 bytes, raw key at offset 12
  return Buffer.from(der.subarray(12, 44));
}

/**
 * Decode a base64 SPKI DER public key to a KeyObject.
 */
export function decodePublicKeyObject(publicKeyBase64: string): KeyObject {
  const der = Buffer.from(publicKeyBase64, 'base64');
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Convert a PKCS8 DER Buffer to an Ed25519 KeyObject.
 */
export function privateKeyFromDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export interface BuildEnvelopeOptions {
  sender: string;
  recipient: string;
  payload: Record<string, unknown>;
  senderPrivateKey: KeyObject;
  recipientPublicKeyBase64: string;
  messageId?: string; // Optional: reuse for retries
}

/**
 * Build a signed, encrypted wire envelope.
 */
export function buildEnvelope(opts: BuildEnvelopeOptions): WireEnvelope {
  const messageId = opts.messageId || randomUUID();
  const timestamp = new Date().toISOString();

  // Get sender's raw keys for X25519 derivation
  const { seed: senderSeed } = getEd25519RawKeys(opts.senderPrivateKey);
  const recipientPubRaw = decodePublicKeyRaw(opts.recipientPublicKeyBase64);

  // Derive X25519 keys and shared AES key
  const senderX25519Priv = ed25519PrivToX25519(senderSeed);
  const recipientX25519Pub = ed25519PubToX25519(recipientPubRaw);
  const sharedKey = deriveSharedKey(senderX25519Priv, recipientX25519Pub, opts.sender, opts.recipient);

  // Encrypt payload
  const plaintext = Buffer.from(JSON.stringify(opts.payload));
  const { ciphertext, nonce } = encrypt(plaintext, sharedKey, messageId);

  // Build envelope (signature placeholder)
  const envelope: WireEnvelope = {
    version: '2.0',
    type: 'direct',
    messageId,
    sender: opts.sender,
    recipient: opts.recipient,
    timestamp,
    payload: {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
    },
    signature: '',
  };

  // Sign the envelope (everything except `signature` field)
  const signable = signablePayload(envelope);
  const sig = sign(Buffer.from(signable), opts.senderPrivateKey);
  envelope.signature = sig.toString('base64');

  return envelope;
}

export interface ProcessEnvelopeOptions {
  envelope: WireEnvelope;
  recipientPrivateKey: KeyObject;
  senderPublicKeyBase64: string;
  now?: number;
}

export interface ProcessedMessage {
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
}

/**
 * Verify signature and decrypt an incoming wire envelope.
 *
 * Throws on invalid envelope, incompatible version, clock skew, bad signature, or decryption failure.
 */
export function processEnvelope(opts: ProcessEnvelopeOptions): ProcessedMessage {
  const { envelope, recipientPrivateKey, senderPublicKeyBase64 } = opts;
  const now = opts.now ?? Date.now();

  // Validate structure
  if (!validateEnvelope(envelope)) {
    throw new Error('Invalid envelope structure');
  }

  // Check version
  if (!isVersionCompatible(envelope.version)) {
    throw new Error(`Incompatible version: ${envelope.version}`);
  }

  // Check timestamp (5 min clock skew)
  const msgTime = new Date(envelope.timestamp).getTime();
  if (Math.abs(now - msgTime) > MAX_CLOCK_SKEW_MS) {
    throw new Error('Message timestamp too far from local clock');
  }

  // Verify Ed25519 signature
  const senderPubKeyObj = decodePublicKeyObject(senderPublicKeyBase64);
  const signable = signablePayload(envelope);
  const signature = Buffer.from(envelope.signature, 'base64');
  const verified = verify(Buffer.from(signable), signature, senderPubKeyObj);

  if (!verified) {
    throw new Error('Invalid signature');
  }

  // Decrypt
  const { seed: recipientSeed } = getEd25519RawKeys(recipientPrivateKey);
  const senderPubRaw = decodePublicKeyRaw(senderPublicKeyBase64);
  const recipientX25519Priv = ed25519PrivToX25519(recipientSeed);
  const senderX25519Pub = ed25519PubToX25519(senderPubRaw);
  const sharedKey = deriveSharedKey(recipientX25519Priv, senderX25519Pub, envelope.sender, envelope.recipient);

  const ciphertext = Buffer.from(envelope.payload.ciphertext as string, 'base64');
  const nonce = Buffer.from(envelope.payload.nonce as string, 'base64');
  const plaintext = decrypt(ciphertext, nonce, sharedKey, envelope.messageId);

  const payload = JSON.parse(plaintext.toString()) as Record<string, unknown>;

  return {
    sender: envelope.sender,
    messageId: envelope.messageId,
    timestamp: envelope.timestamp,
    payload,
    verified: true,
  };
}

/**
 * Default delivery function — HTTP POST to recipient's endpoint.
 */
export async function httpDeliver(endpoint: string, envelope: WireEnvelope): Promise<boolean> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    return res.ok;
  } catch {
    return false;
  }
}
