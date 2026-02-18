/**
 * Registry logic — agent registration, directory, approval, revocation.
 *
 * POST /registry/agents          — Register (requires prior email verification)
 * GET  /registry/agents          — List all agents (public directory)
 * GET  /registry/agents/:name    — Get single agent details
 * POST /registry/agents/:name/approve — Admin: approve pending agent
 * POST /registry/agents/:name/revoke  — Admin: revoke agent
 */

import { verify as cryptoVerify, createPublicKey, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Well-known disposable email domains.
 * Not exhaustive — this is defense-in-depth; email verification + admin approval
 * is the primary gate. Consider using an external blocklist service (e.g.,
 * disposable-email-domains npm package) for more comprehensive coverage.
 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'temp-mail.org', 'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com',
  'grr.la', 'dispostable.com', 'trashmail.com', 'maildrop.cc',
  '10minutemail.com', 'fakeinbox.com', 'mailnesia.com',
]);

/** Valid agent name pattern. */
const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface RegistrationResult {
  ok: boolean;
  status?: number;
  error?: string;
  agent?: { name: string; status: string };
}

/**
 * Register a new agent. Requires prior email verification.
 */
export function registerAgent(
  db: Database.Database,
  name: string,
  publicKey: string,
  ownerEmail: string,
  endpoint: string,
): RegistrationResult {
  // Validate name
  if (!name || !AGENT_NAME_RE.test(name)) {
    return { ok: false, status: 400, error: 'Invalid agent name (alphanumeric, dash, underscore, max 64 chars)' };
  }

  if (!publicKey) {
    return { ok: false, status: 400, error: 'publicKey is required' };
  }

  if (!ownerEmail) {
    return { ok: false, status: 400, error: 'ownerEmail is required' };
  }

  // Check email is verified
  const verification = db.prepare(
    'SELECT verified FROM email_verifications WHERE agent_name = ? AND email = ?'
  ).get(name, ownerEmail) as { verified: number } | undefined;

  if (!verification || !verification.verified) {
    return { ok: false, status: 400, error: 'Email not verified — complete /verify/send and /verify/confirm first' };
  }

  // Check for disposable email
  const domain = ownerEmail.split('@')[1]?.toLowerCase();
  if (domain && DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, status: 400, error: 'Disposable email domains not allowed' };
  }

  // Check for existing agent with same name
  const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name);
  if (existing) {
    return { ok: false, status: 409, error: 'Agent already exists' };
  }

  // Check for existing agent with same email
  const emailExists = db.prepare('SELECT name FROM agents WHERE owner_email = ?').get(ownerEmail);
  if (emailExists) {
    return { ok: false, status: 409, error: 'An agent with this email already exists' };
  }

  // Check for existing agent with same public key
  const pubkeyExists = db.prepare('SELECT name FROM agents WHERE public_key = ?').get(publicKey);
  if (pubkeyExists) {
    return { ok: false, status: 409, error: 'An agent with this public key already exists' };
  }

  // Insert agent as active (auto-approved after email verification)
  db.prepare(
    'INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(name, publicKey, ownerEmail, endpoint || null, 'active');

  return { ok: true, agent: { name, status: 'active' } };
}

/**
 * Approve a pending agent — REMOVED in v3.
 * Registration is now auto-approved after email verification.
 * Returns 410 Gone.
 */
export function approveAgent(
  _db: Database.Database,
  _targetName: string,
  _adminAgent: string,
): RegistrationResult {
  return { ok: false, status: 410, error: 'Gone — admin approval removed in v3, registration is auto-approved' };
}

/**
 * Revoke an agent. Stores a revocation broadcast.
 */
export function revokeAgent(
  db: Database.Database,
  targetName: string,
  adminAgent: string,
): RegistrationResult {
  // Verify the caller is an admin
  const admin = db.prepare('SELECT agent FROM admins WHERE agent = ?').get(adminAgent) as
    | { agent: string } | undefined;

  if (!admin) {
    return { ok: false, status: 403, error: 'Not an admin' };
  }

  // Look up target agent
  const agent = db.prepare('SELECT name, status FROM agents WHERE name = ?').get(targetName) as
    | { name: string; status: string } | undefined;

  if (!agent) {
    return { ok: false, status: 404, error: 'Agent not found' };
  }

  // Revoke
  db.prepare("UPDATE agents SET status = 'revoked' WHERE name = ?").run(targetName);

  // Store revocation broadcast
  const broadcastId = randomUUID();
  db.prepare(
    'INSERT INTO broadcasts (id, type, payload, sender, signature) VALUES (?, ?, ?, ?, ?)'
  ).run(
    broadcastId,
    'revocation',
    JSON.stringify({ revokedAgent: targetName, reason: 'admin_revocation' }),
    adminAgent,
    '', // Signature will be added by the admin's signing at the HTTP layer
  );

  return { ok: true, agent: { name: targetName, status: 'revoked' } };
}

/**
 * List all registered agents — REMOVED in v3.
 * Public directory listing is no longer available.
 * Returns 410 Gone.
 */
export function listAgents(_db: Database.Database): { ok: false; status: 410; error: string } {
  return { ok: false, status: 410, error: 'Gone — public directory listing removed in v3' };
}

/**
 * Get a single agent's details.
 */
export function getAgent(db: Database.Database, name: string): {
  name: string;
  publicKey: string;
  status: string;
  endpoint: string | null;
  ownerEmail: string | null;
  emailVerified: boolean;
  createdAt: string;
  approvedBy: string | null;
} | null {
  const row = db.prepare(
    'SELECT name, public_key, status, endpoint, owner_email, email_verified, created_at, approved_by FROM agents WHERE name = ?'
  ).get(name) as any | undefined;

  if (!row) return null;

  return {
    name: row.name,
    publicKey: row.public_key,
    status: row.status,
    endpoint: row.endpoint,
    ownerEmail: row.owner_email,
    emailVerified: !!row.email_verified,
    createdAt: row.created_at,
    approvedBy: row.approved_by,
  };
}

/**
 * Lookup an agent's public info (v3). Returns only name, publicKey, status.
 * No endpoint, ownerEmail, or other private fields.
 */
export function lookupAgent(db: Database.Database, name: string): {
  name: string;
  publicKey: string;
  status: string;
} | null {
  const row = db.prepare(
    'SELECT name, public_key, status FROM agents WHERE name = ?'
  ).get(name) as { name: string; public_key: string; status: string } | undefined;

  if (!row) return null;

  return {
    name: row.name,
    publicKey: row.public_key,
    status: row.status,
  };
}

/** Recovery cooling-off period: 1 hour. */
const RECOVERY_COOLOFF_MS = 60 * 60 * 1000;

export interface RotateKeyResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Rotate an agent's public key.
 *
 * Two modes:
 * 1. Normal rotation: callerAgent matches targetName (authenticated with current key).
 *    Updates key immediately.
 * 2. Recovery activation: No auth needed, but pending recovery must exist and
 *    cooling-off period must have elapsed. The newPublicKey must match pending_public_key.
 *
 * @param callerAgent - Authenticated agent name (null if unauthenticated/recovery mode)
 * @param now - Current time in ms (injectable for testing)
 */
export function rotateKey(
  db: Database.Database,
  targetName: string,
  newPublicKey: string,
  callerAgent: string | null,
  now: number = Date.now(),
): RotateKeyResult {
  if (!newPublicKey) {
    return { ok: false, status: 400, error: 'newPublicKey is required' };
  }

  const agent = db.prepare(
    'SELECT name, public_key, status, recovery_initiated_at, pending_public_key FROM agents WHERE name = ?'
  ).get(targetName) as {
    name: string; public_key: string; status: string;
    recovery_initiated_at: string | null; pending_public_key: string | null;
  } | undefined;

  if (!agent) {
    return { ok: false, status: 404, error: 'Agent not found' };
  }

  if (agent.status !== 'active') {
    return { ok: false, status: 403, error: 'Agent is not active' };
  }

  // Check if recovery is in progress
  if (agent.recovery_initiated_at) {
    const elapsed = now - new Date(agent.recovery_initiated_at).getTime();

    if (elapsed < RECOVERY_COOLOFF_MS) {
      return { ok: false, status: 403, error: 'Recovery cooling-off period not elapsed' };
    }

    // Cooling-off elapsed — activate the pending key
    if (newPublicKey !== agent.pending_public_key) {
      return { ok: false, status: 400, error: 'newPublicKey must match the pending recovery key' };
    }

    // Check uniqueness
    const pubkeyExists = db.prepare(
      'SELECT name FROM agents WHERE public_key = ? AND name != ?'
    ).get(newPublicKey, targetName);
    if (pubkeyExists) {
      return { ok: false, status: 409, error: 'An agent with this public key already exists' };
    }

    db.prepare(
      `UPDATE agents SET public_key = ?, key_updated_at = datetime('now'),
       recovery_initiated_at = NULL, pending_public_key = NULL WHERE name = ?`
    ).run(newPublicKey, targetName);

    return { ok: true };
  }

  // Normal rotation — caller must be the agent themselves
  if (callerAgent !== targetName) {
    return { ok: false, status: 403, error: 'Can only rotate your own key' };
  }

  // Check uniqueness
  const pubkeyExists = db.prepare(
    'SELECT name FROM agents WHERE public_key = ? AND name != ?'
  ).get(newPublicKey, targetName);
  if (pubkeyExists) {
    return { ok: false, status: 409, error: 'An agent with this public key already exists' };
  }

  db.prepare(
    `UPDATE agents SET public_key = ?, key_updated_at = datetime('now') WHERE name = ?`
  ).run(newPublicKey, targetName);

  return { ok: true };
}

/**
 * Initiate key recovery via email verification.
 * Sets a pending key with a 1-hour cooling-off period.
 * Unauthenticated — the agent has lost their key.
 */
export function recoverKey(
  db: Database.Database,
  targetName: string,
  ownerEmail: string,
  newPublicKey: string,
): RotateKeyResult {
  if (!ownerEmail) {
    return { ok: false, status: 400, error: 'ownerEmail is required' };
  }
  if (!newPublicKey) {
    return { ok: false, status: 400, error: 'newPublicKey is required' };
  }

  const agent = db.prepare(
    'SELECT name, owner_email, status FROM agents WHERE name = ?'
  ).get(targetName) as { name: string; owner_email: string; status: string } | undefined;

  if (!agent) {
    return { ok: false, status: 404, error: 'Agent not found' };
  }

  if (agent.status !== 'active') {
    return { ok: false, status: 403, error: 'Agent is not active' };
  }

  // Verify email matches
  if (agent.owner_email !== ownerEmail) {
    return { ok: false, status: 403, error: 'Email does not match registered email' };
  }

  // Verify email is verified
  const verification = db.prepare(
    'SELECT verified FROM email_verifications WHERE agent_name = ? AND email = ?'
  ).get(targetName, ownerEmail) as { verified: number } | undefined;

  if (!verification || !verification.verified) {
    return { ok: false, status: 400, error: 'Email not verified — complete /verify/send and /verify/confirm first' };
  }

  // Check uniqueness of new key
  const pubkeyExists = db.prepare(
    'SELECT name FROM agents WHERE public_key = ? AND name != ?'
  ).get(newPublicKey, targetName);
  if (pubkeyExists) {
    return { ok: false, status: 409, error: 'An agent with this public key already exists' };
  }

  // Set pending recovery
  db.prepare(
    `UPDATE agents SET pending_public_key = ?, recovery_initiated_at = datetime('now') WHERE name = ?`
  ).run(newPublicKey, targetName);

  return { ok: true, status: 202 };
}
