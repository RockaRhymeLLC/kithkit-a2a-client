/**
 * Request authentication middleware.
 *
 * Verifies Ed25519 signatures on incoming requests.
 *
 * Auth header format:
 *   Authorization: Signature <agent_name>:<base64_signature>
 *
 * Signing string:
 *   <METHOD> <PATH>\n<ISO-8601 timestamp>\n<body_sha256_hex>
 *
 * The timestamp header (X-Timestamp) must be within 5 minutes of server time.
 */

import {
  verify as cryptoVerify,
  createPublicKey,
  createHash,
} from 'node:crypto';
import type Database from 'better-sqlite3';

/** Max age of a timestamp before it's considered expired (5 minutes). */
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

/** Result of authentication. */
export interface AuthResult {
  ok: boolean;
  agent?: string;
  status?: number; // HTTP status code on failure
  error?: string;
}

/**
 * Build the signing string from request components.
 */
export function buildSigningString(
  method: string,
  path: string,
  timestamp: string,
  bodyHash: string,
): string {
  return `${method} ${path}\n${timestamp}\n${bodyHash}`;
}

/**
 * Compute SHA-256 hex hash of a body string. Empty body hashes to empty string hash.
 */
export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Parse the Authorization header.
 * Expected format: "Signature agent_name:base64_signature"
 */
export function parseAuthHeader(header: string): { agent: string; signature: string } | null {
  if (!header.startsWith('Signature ')) return null;
  const rest = header.slice('Signature '.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx <= 0) return null;

  const agent = rest.slice(0, colonIdx);
  const signature = rest.slice(colonIdx + 1);
  if (!agent || !signature) return null;

  return { agent, signature };
}

/**
 * Verify an Ed25519 signature against a public key (base64 SPKI DER).
 */
export function verifySignature(
  signingString: string,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean {
  try {
    const keyObj = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(
      null,
      Buffer.from(signingString),
      keyObj,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Authenticate a request against the database.
 *
 * @param db - Database instance
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Request path
 * @param timestamp - ISO-8601 timestamp from X-Timestamp header
 * @param body - Raw request body (empty string for bodyless requests)
 * @param authHeader - Authorization header value
 * @param now - Current time in ms (injectable for testing)
 */
export function authenticateRequest(
  db: Database.Database,
  method: string,
  path: string,
  timestamp: string,
  body: string,
  authHeader: string | undefined,
  now: number = Date.now(),
): AuthResult {
  // 1. Check auth header present and well-formed
  if (!authHeader) {
    return { ok: false, status: 401, error: 'Missing Authorization header' };
  }

  const parsed = parseAuthHeader(authHeader);
  if (!parsed) {
    return { ok: false, status: 401, error: 'Malformed Authorization header' };
  }

  // 2. Look up agent in database
  const agent = db.prepare(
    'SELECT name, public_key, status FROM agents WHERE name = ?'
  ).get(parsed.agent) as { name: string; public_key: string; status: string } | undefined;

  if (!agent) {
    return { ok: false, status: 401, error: 'Unknown agent' };
  }

  // 3. Check agent status
  if (agent.status === 'revoked') {
    return { ok: false, status: 403, error: 'Agent revoked' };
  }

  if (agent.status === 'pending') {
    return { ok: false, status: 403, error: 'Agent pending approval' };
  }

  // 4. Check timestamp freshness (replay protection)
  const tsMs = new Date(timestamp).getTime();
  if (isNaN(tsMs) || Math.abs(now - tsMs) > MAX_TIMESTAMP_AGE_MS) {
    return { ok: false, status: 401, error: 'Timestamp expired or invalid' };
  }

  // 5. Verify signature
  const bodyHashHex = hashBody(body);
  const signingString = buildSigningString(method, path, timestamp, bodyHashHex);

  if (!verifySignature(signingString, parsed.signature, agent.public_key)) {
    return { ok: false, status: 401, error: 'Invalid signature' };
  }

  return { ok: true, agent: agent.name };
}
