/**
 * Admin logic — pending registrations, admin keys, broadcasts.
 *
 * GET  /admin/pending     — List pending registrations (admin only)
 * GET  /admin/keys        — List registered admin public keys (public)
 * POST /admin/broadcast   — Create signed broadcast (admin only)
 * GET  /admin/broadcasts  — List broadcasts (authenticated)
 */

import { randomUUID, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Valid broadcast types. */
const VALID_BROADCAST_TYPES = new Set([
  'security-alert', 'maintenance', 'update', 'announcement', 'revocation',
]);

export interface BroadcastResult {
  ok: boolean;
  status?: number;
  error?: string;
  broadcastId?: string;
}

/**
 * Create a signed admin broadcast.
 *
 * The admin signs the canonical payload string. The signature is stored and
 * can be verified by any agent using the admin's public key from /admin/keys.
 *
 * @param adminAgent - The agent claiming admin privileges (must be in admins table)
 * @param type - Broadcast type (security-alert, maintenance, update, announcement, revocation)
 * @param payload - JSON string of the broadcast payload
 * @param signature - Base64-encoded Ed25519 signature of the payload string
 */
export function createBroadcast(
  db: Database.Database,
  adminAgent: string,
  type: string,
  payload: string,
  signature: string,
): BroadcastResult {
  // Validate type
  if (!VALID_BROADCAST_TYPES.has(type)) {
    return { ok: false, status: 400, error: `Invalid broadcast type. Must be one of: ${[...VALID_BROADCAST_TYPES].join(', ')}` };
  }

  // Verify the caller is an admin
  const admin = db.prepare(
    'SELECT agent, admin_public_key FROM admins WHERE agent = ?'
  ).get(adminAgent) as { agent: string; admin_public_key: string } | undefined;

  if (!admin) {
    return { ok: false, status: 403, error: 'Not an admin' };
  }

  // Verify the signature against the admin's public key
  if (!verifyBroadcastSignature(payload, signature, admin.admin_public_key)) {
    return { ok: false, status: 400, error: 'Invalid broadcast signature' };
  }

  // Store broadcast
  const id = randomUUID();
  db.prepare(
    'INSERT INTO broadcasts (id, type, payload, sender, signature) VALUES (?, ?, ?, ?, ?)'
  ).run(id, type, payload, adminAgent, signature);

  return { ok: true, broadcastId: id };
}

/**
 * Verify a broadcast signature against a public key.
 */
export function verifyBroadcastSignature(
  payload: string,
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
      Buffer.from(payload),
      keyObj,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * List pending agent registrations — REMOVED in v3.
 * Registration is now auto-approved; there are no pending registrations.
 * Returns 410 Gone.
 */
export function listPendingRegistrations(_db: Database.Database): { ok: false; status: 410; error: string } {
  return { ok: false, status: 410, error: 'Gone — admin approval removed in v3, registration is auto-approved' };
}

/**
 * List registered admin public keys (public endpoint).
 */
export function listAdminKeys(db: Database.Database): Array<{
  agent: string;
  adminPublicKey: string;
  addedAt: string;
}> {
  const rows = db.prepare(
    'SELECT agent, admin_public_key, added_at FROM admins ORDER BY agent'
  ).all() as Array<{ agent: string; admin_public_key: string; added_at: string }>;

  return rows.map((r) => ({
    agent: r.agent,
    adminPublicKey: r.admin_public_key,
    addedAt: r.added_at,
  }));
}

/**
 * List broadcasts (optionally filtered by type).
 */
export function listBroadcasts(
  db: Database.Database,
  type?: string,
  limit: number = 50,
): Array<{
  id: string;
  type: string;
  payload: string;
  sender: string;
  signature: string;
  createdAt: string;
}> {
  let query = 'SELECT id, type, payload, sender, signature, created_at FROM broadcasts';
  const params: unknown[] = [];

  if (type) {
    query += ' WHERE type = ?';
    params.push(type);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as Array<{
    id: string; type: string; payload: string; sender: string; signature: string; created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    payload: r.payload,
    sender: r.sender,
    signature: r.signature,
    createdAt: r.created_at,
  }));
}
