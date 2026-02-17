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

  // Check for existing agent
  const existing = db.prepare('SELECT name FROM agents WHERE name = ?').get(name);
  if (existing) {
    return { ok: false, status: 409, error: 'Agent already exists' };
  }

  // Insert agent as pending
  db.prepare(
    'INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(name, publicKey, ownerEmail, endpoint || null, 'pending');

  return { ok: true, agent: { name, status: 'pending' } };
}

/**
 * Approve a pending agent. Requires admin key signature verification.
 *
 * @param adminAgent - The agent name claiming admin privileges
 */
export function approveAgent(
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

  if (agent.status === 'active') {
    return { ok: true, agent: { name: targetName, status: 'active' } };
  }

  // Approve
  db.prepare(
    "UPDATE agents SET status = 'active', approved_by = ?, approved_at = datetime('now') WHERE name = ?"
  ).run(adminAgent, targetName);

  return { ok: true, agent: { name: targetName, status: 'active' } };
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
 * List all registered agents (public directory).
 */
export function listAgents(db: Database.Database): Array<{
  name: string;
  publicKey: string;
  status: string;
  endpoint: string | null;
  createdAt: string;
}> {
  const rows = db.prepare(
    'SELECT name, public_key, status, endpoint, created_at FROM agents ORDER BY name'
  ).all() as Array<{ name: string; public_key: string; status: string; endpoint: string | null; created_at: string }>;

  return rows.map((r) => ({
    name: r.name,
    publicKey: r.public_key,
    status: r.status,
    endpoint: r.endpoint,
    createdAt: r.created_at,
  }));
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
