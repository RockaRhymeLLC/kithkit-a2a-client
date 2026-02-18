/**
 * Contacts routes — request, accept, deny, remove, list.
 *
 * POST   /contacts/request        — Send contact request (v3: no greeting, batch support)
 * GET    /contacts/pending         — List pending requests (incoming, 30-day expiry filter)
 * POST   /contacts/:agent/accept   — Accept a contact request
 * POST   /contacts/:agent/deny     — Deny a contact request (tracks denial count, auto-blocks at 3)
 * DELETE /contacts/:agent           — Remove an established contact
 * GET    /contacts                  — List active contacts
 *
 * Contact pairs are stored with agent_a < agent_b alphabetically.
 * The `requested_by` column tracks who initiated the request.
 */

import type Database from 'better-sqlite3';

/** Rate limit: max contact requests per hour per sender. */
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Pending request expiry: 30 days. */
const PENDING_EXPIRY_DAYS = 30;

/** Auto-block threshold: deny 3 times → auto-block. */
const AUTO_BLOCK_THRESHOLD = 3;

export interface ContactResult {
  ok: boolean;
  status?: number;
  error?: string;
  contact?: {
    agent: string;
    endpoint: string | null;
    publicKey: string;
  };
}

export interface BatchContactResult {
  ok: boolean;
  status: number;
  results: Array<{ to: string } & ContactResult>;
}

export interface ContactInfo {
  agent: string;
  publicKey: string;
  endpoint: string | null;
  since: string;
  online: boolean;
  lastSeen: string | null;
  keyUpdatedAt: string | null;
  recoveryInProgress: boolean;
}

export interface PendingRequest {
  from: string;
  requesterEmail: string | null;
  createdAt: string;
}

/**
 * Order two agent names alphabetically for the composite PK.
 */
function orderPair(a: string, b: string): { agent_a: string; agent_b: string } {
  return a < b ? { agent_a: a, agent_b: b } : { agent_a: b, agent_b: a };
}

/**
 * Check if an agent exists and is active.
 */
function isActiveAgent(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT status FROM agents WHERE name = ? AND status = 'active'"
  ).get(name) as { status: string } | undefined;
  return !!row;
}

/**
 * Check if `blocker` has blocked `blocked`.
 */
function isBlocked(db: Database.Database, blocker: string, blocked: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?'
  ).get(blocker, blocked);
  return !!row;
}

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;   // seconds until window resets
  limit?: number;
  remaining?: number;
  resetAt?: string;      // ISO timestamp
}

/**
 * Check rate limit for contact requests. Returns rate limit state.
 */
function checkRateLimit(db: Database.Database, agent: string): RateLimitResult {
  const key = `contacts:request:${agent}`;
  const now = Date.now();
  const windowStart = new Date(now - RATE_LIMIT_WINDOW_MS).toISOString();

  const row = db.prepare(
    'SELECT count, window_start FROM rate_limits WHERE key = ?'
  ).get(key) as { count: number; window_start: string } | undefined;

  if (!row) {
    // No record — create one
    db.prepare(
      'INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)'
    ).run(key, new Date(now).toISOString());
    return { allowed: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX - 1 };
  }

  // Check if window has expired
  if (row.window_start < windowStart) {
    // Reset window
    db.prepare(
      'UPDATE rate_limits SET count = 1, window_start = ? WHERE key = ?'
    ).run(new Date(now).toISOString(), key);
    return { allowed: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX - 1 };
  }

  // Within window — check count
  const windowStartMs = new Date(row.window_start).getTime();
  const resetMs = windowStartMs + RATE_LIMIT_WINDOW_MS;
  const resetAt = new Date(resetMs).toISOString();
  const retryAfter = Math.ceil((resetMs - now) / 1000);

  if (row.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter, limit: RATE_LIMIT_MAX, remaining: 0, resetAt };
  }

  // Increment
  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').run(key);
  return { allowed: true, limit: RATE_LIMIT_MAX, remaining: RATE_LIMIT_MAX - 1 - row.count };
}

/**
 * Check if a pending request has expired (older than 30 days).
 */
function isPendingExpired(createdAt: string): boolean {
  const created = new Date(createdAt).getTime();
  const expiry = PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - created > expiry;
}

/**
 * Send a contact request from `fromAgent` to `toAgent`.
 * V3: No greeting allowed (canned notifications only).
 */
export function requestContact(
  db: Database.Database,
  fromAgent: string,
  toAgent: string,
  greeting?: string,
): ContactResult {
  // V3: Greeting not allowed
  if (greeting !== undefined) {
    return { ok: false, status: 400, error: 'Greeting not allowed — contact requests are canned notifications in v3' };
  }

  // Can't request yourself
  if (fromAgent === toAgent) {
    return { ok: false, status: 400, error: 'Cannot add yourself as a contact' };
  }

  // Both agents must be active
  if (!isActiveAgent(db, fromAgent)) {
    return { ok: false, status: 403, error: 'Requesting agent is not active' };
  }
  if (!isActiveAgent(db, toAgent)) {
    return { ok: false, status: 404, error: 'Target agent not found or not active' };
  }

  // Check if blocked
  if (isBlocked(db, toAgent, fromAgent)) {
    return { ok: false, status: 403, error: 'Blocked by target agent' };
  }

  // Rate limit check
  const rateCheck = checkRateLimit(db, fromAgent);
  if (!rateCheck.allowed) {
    return {
      ok: false, status: 429,
      error: 'Rate limit exceeded — max 100 contact requests per hour',
      retryAfter: rateCheck.retryAfter,
      rateLimit: rateCheck.limit,
      rateLimitRemaining: 0,
      rateLimitReset: rateCheck.resetAt,
    } as any;
  }

  const { agent_a, agent_b } = orderPair(fromAgent, toAgent);

  // Check for existing contact (any status)
  const existing = db.prepare(
    'SELECT status, created_at FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string; created_at: string } | undefined;

  if (existing) {
    if (existing.status === 'active') {
      return { ok: false, status: 409, error: 'Already contacts' };
    }
    if (existing.status === 'pending') {
      // Check if expired
      if (isPendingExpired(existing.created_at)) {
        // Expired — delete and allow re-request
        db.prepare('DELETE FROM contacts WHERE agent_a = ? AND agent_b = ?').run(agent_a, agent_b);
      } else {
        return { ok: false, status: 409, error: 'Contact request already pending' };
      }
    }
    if (existing.status === 'denied') {
      // Update back to pending (keep denial_count)
      db.prepare(
        "UPDATE contacts SET status = 'pending', requested_by = ?, created_at = datetime('now'), updated_at = datetime('now') WHERE agent_a = ? AND agent_b = ?"
      ).run(fromAgent, agent_a, agent_b);
      return { ok: true, status: 201 };
    }
    if (existing.status === 'removed') {
      // Delete and allow re-request
      db.prepare('DELETE FROM contacts WHERE agent_a = ? AND agent_b = ?').run(agent_a, agent_b);
    }
  }

  // Insert new pending contact
  db.prepare(
    `INSERT INTO contacts (agent_a, agent_b, status, requested_by, denial_count)
     VALUES (?, ?, 'pending', ?, 0)`
  ).run(agent_a, agent_b, fromAgent);

  return { ok: true, status: 201 };
}

/**
 * Send batch contact requests.
 */
export function requestContactBatch(
  db: Database.Database,
  fromAgent: string,
  toAgents: string[],
): BatchContactResult {
  const results = toAgents.map(to => ({
    to,
    ...requestContact(db, fromAgent, to),
  }));
  const allOk = results.every(r => r.ok);
  return { ok: allOk, status: allOk ? 201 : 207, results };
}

/**
 * List incoming pending contact requests for an agent.
 * V3: Includes requesterEmail, filters expired (>30 days), no greeting.
 */
export function listPendingRequests(
  db: Database.Database,
  agent: string,
): PendingRequest[] {
  // Pending requests where this agent is NOT the requester
  const rows = db.prepare(
    `SELECT c.agent_a, c.agent_b, c.requested_by, c.created_at,
            a.owner_email as requester_email
     FROM contacts c
     JOIN agents a ON a.name = c.requested_by
     WHERE c.status = 'pending'
       AND (c.agent_a = ? OR c.agent_b = ?)
       AND c.requested_by != ?
     ORDER BY c.created_at ASC`
  ).all(agent, agent, agent) as Array<{
    agent_a: string; agent_b: string; requested_by: string;
    created_at: string; requester_email: string | null;
  }>;

  // Filter expired requests (>30 days old)
  return rows
    .filter(r => !isPendingExpired(r.created_at))
    .map((r) => ({
      from: r.requested_by,
      requesterEmail: r.requester_email,
      createdAt: r.created_at,
    }));
}

/**
 * Accept a pending contact request.
 * The `agent` is the one accepting; `otherAgent` is who sent the request.
 */
export function acceptContact(
  db: Database.Database,
  agent: string,
  otherAgent: string,
): ContactResult {
  const { agent_a, agent_b } = orderPair(agent, otherAgent);

  const existing = db.prepare(
    'SELECT status, requested_by FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string; requested_by: string } | undefined;

  if (!existing) {
    return { ok: false, status: 404, error: 'No pending contact request found' };
  }

  if (existing.status === 'active') {
    return { ok: true }; // Already active, idempotent
  }

  if (existing.status !== 'pending') {
    return { ok: false, status: 404, error: 'No pending contact request found' };
  }

  // Only the recipient (non-requester) can accept
  if (existing.requested_by === agent) {
    return { ok: false, status: 400, error: 'Cannot accept your own request' };
  }

  db.prepare(
    "UPDATE contacts SET status = 'active', updated_at = datetime('now') WHERE agent_a = ? AND agent_b = ?"
  ).run(agent_a, agent_b);

  // Return the other agent's contact info (endpoint exchange)
  const otherInfo = db.prepare(
    'SELECT name, public_key, endpoint FROM agents WHERE name = ?'
  ).get(otherAgent) as { name: string; public_key: string; endpoint: string | null } | undefined;

  return {
    ok: true,
    contact: otherInfo ? {
      agent: otherInfo.name,
      endpoint: otherInfo.endpoint,
      publicKey: otherInfo.public_key,
    } : undefined,
  };
}

/**
 * Deny a pending contact request.
 * V3: Tracks denial count, auto-blocks after 3 denials.
 */
export function denyContact(
  db: Database.Database,
  agent: string,
  otherAgent: string,
): ContactResult {
  const { agent_a, agent_b } = orderPair(agent, otherAgent);

  const existing = db.prepare(
    'SELECT status, requested_by, denial_count FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string; requested_by: string; denial_count: number } | undefined;

  if (!existing || existing.status !== 'pending') {
    return { ok: false, status: 404, error: 'No pending contact request found' };
  }

  // Only the recipient can deny
  if (existing.requested_by === agent) {
    return { ok: false, status: 400, error: 'Cannot deny your own request' };
  }

  const newDenialCount = (existing.denial_count || 0) + 1;

  // Update to denied status with incremented denial_count
  db.prepare(
    "UPDATE contacts SET status = 'denied', denial_count = ?, updated_at = datetime('now') WHERE agent_a = ? AND agent_b = ?"
  ).run(newDenialCount, agent_a, agent_b);

  // Auto-block after threshold
  if (newDenialCount >= AUTO_BLOCK_THRESHOLD) {
    const requester = existing.requested_by;
    db.prepare(
      'INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)'
    ).run(agent, requester);
  }

  return { ok: true };
}

/**
 * Remove an active contact. Either side can remove.
 */
export function removeContact(
  db: Database.Database,
  agent: string,
  otherAgent: string,
): ContactResult {
  const { agent_a, agent_b } = orderPair(agent, otherAgent);

  const existing = db.prepare(
    'SELECT status FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).get(agent_a, agent_b) as { status: string } | undefined;

  if (!existing || existing.status !== 'active') {
    return { ok: false, status: 404, error: 'Contact not found' };
  }

  // Delete the contact row (allows re-request later)
  db.prepare(
    'DELETE FROM contacts WHERE agent_a = ? AND agent_b = ?'
  ).run(agent_a, agent_b);

  return { ok: true };
}

/** Recovery cooling-off period: 1 hour. */
const RECOVERY_COOLOFF_MS = 60 * 60 * 1000;

/**
 * List active contacts for an agent, with their public keys and endpoints.
 */
export function listContacts(
  db: Database.Database,
  agent: string,
  now: number = Date.now(),
): ContactInfo[] {
  const OFFLINE_THRESHOLD_MS = 2 * 10 * 60 * 1000; // 20 minutes

  const rows = db.prepare(
    `SELECT c.agent_a, c.agent_b, c.updated_at,
            a.public_key, a.endpoint, a.name as agent_name, a.last_seen,
            a.key_updated_at, a.recovery_initiated_at
     FROM contacts c
     JOIN agents a ON (
       (c.agent_a = ? AND a.name = c.agent_b)
       OR (c.agent_b = ? AND a.name = c.agent_a)
     )
     WHERE c.status = 'active'
       AND (c.agent_a = ? OR c.agent_b = ?)
     ORDER BY a.name`
  ).all(agent, agent, agent, agent) as Array<{
    agent_a: string; agent_b: string; updated_at: string;
    public_key: string; endpoint: string | null; agent_name: string;
    last_seen: string | null; key_updated_at: string | null;
    recovery_initiated_at: string | null;
  }>;

  return rows.map((r) => {
    const online = r.last_seen ? (now - new Date(r.last_seen).getTime()) <= OFFLINE_THRESHOLD_MS : false;
    const recoveryInProgress = r.recovery_initiated_at
      ? (now - new Date(r.recovery_initiated_at).getTime()) < RECOVERY_COOLOFF_MS
      : false;
    return {
      agent: r.agent_name,
      publicKey: r.public_key,
      endpoint: r.endpoint,
      since: r.updated_at,
      online,
      lastSeen: r.last_seen,
      keyUpdatedAt: r.key_updated_at,
      recoveryInProgress,
    };
  });
}
