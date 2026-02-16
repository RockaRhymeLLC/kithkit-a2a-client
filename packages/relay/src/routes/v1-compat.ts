/**
 * v1 compatibility routes — deprecated, removed after sunset date.
 *
 * POST /relay/send               — DEPRECATED: v1 store-and-forward send
 * GET  /relay/inbox/:agent       — DEPRECATED: v1 inbox poll
 * POST /relay/inbox/:agent/ack   — DEPRECATED: v1 message acknowledge
 *
 * Returns Deprecation: true header. After sunset: 410 Gone.
 *
 * These route functions are pure — they take a db and return results.
 * The HTTP layer adds the Deprecation header and handles 410 logic.
 */

import type Database from 'better-sqlite3';

/** Default sunset: 30 days from v2 deployment. */
const DEFAULT_SUNSET_DAYS = 30;

export interface V1Result {
  ok: boolean;
  status?: number;
  error?: string;
  deprecated: boolean;
  data?: unknown;
}

export interface V1SendParams {
  from: string;
  to: string;
  type: string;
  text?: string;
  messageId: string;
  nonce: string;
  timestamp: string;
  signature: string;
}

/** Deprecation warnings logged during tests (injectable). */
export type DeprecationLogger = (route: string, agent: string) => void;

/** Default logger: console.warn. */
const defaultLogger: DeprecationLogger = (route, agent) => {
  console.warn(`[DEPRECATED] ${route} called by ${agent} — upgrade to v2`);
};

/**
 * Check if the v1 routes have sunset (passed the configurable end date).
 */
export function isSunset(sunsetDate: Date, now: number = Date.now()): boolean {
  return now >= sunsetDate.getTime();
}

/**
 * Create a sunset response.
 */
function sunsetResponse(): V1Result {
  return {
    ok: false,
    status: 410,
    error: 'v1 API has been sunset. Please upgrade to v2. See docs/migration-v1.md',
    deprecated: true,
  };
}

/**
 * v1 POST /relay/send — store a message for another agent.
 */
export function v1Send(
  db: Database.Database,
  params: V1SendParams,
  authAgent: string,
  sunsetDate: Date,
  now: number = Date.now(),
  log: DeprecationLogger = defaultLogger,
): V1Result {
  if (isSunset(sunsetDate, now)) return sunsetResponse();

  log('POST /relay/send', authAgent);

  // Validate from matches auth
  if (params.from !== authAgent) {
    return { ok: false, status: 400, error: 'from field must match authenticated agent', deprecated: true };
  }

  if (!params.to || !params.type || !params.messageId || !params.nonce || !params.timestamp) {
    return { ok: false, status: 400, error: 'Missing required fields: to, type, messageId, nonce, timestamp', deprecated: true };
  }

  // Check timestamp within 5 minutes
  const msgTime = new Date(params.timestamp).getTime();
  if (isNaN(msgTime) || Math.abs(now - msgTime) > 5 * 60 * 1000) {
    return { ok: false, status: 400, error: 'Timestamp too old or invalid (5-minute window)', deprecated: true };
  }

  // Check recipient exists
  const recipient = db.prepare('SELECT name, status FROM agents WHERE name = ?').get(params.to) as
    | { name: string; status: string } | undefined;
  if (!recipient) {
    return { ok: false, status: 404, error: 'Recipient agent not found', deprecated: true };
  }

  // Replay protection
  const existingNonce = db.prepare('SELECT nonce FROM nonces WHERE nonce = ?').get(params.nonce);
  if (existingNonce) {
    return { ok: false, status: 409, error: 'Duplicate nonce (replay detected)', deprecated: true };
  }

  // Store nonce
  db.prepare('INSERT INTO nonces (nonce) VALUES (?)').run(params.nonce);

  // Enforce inbox limit (100 messages per agent)
  const inboxCount = db.prepare(
    'SELECT COUNT(*) as count FROM messages WHERE to_agent = ?'
  ).get(params.to) as { count: number };

  if (inboxCount.count >= 100) {
    const excess = inboxCount.count - 99;
    db.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages WHERE to_agent = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(params.to, excess);
  }

  // Store message
  const payload = JSON.stringify({
    from: params.from,
    to: params.to,
    type: params.type,
    text: params.text,
    messageId: params.messageId,
    nonce: params.nonce,
    timestamp: params.timestamp,
  });

  db.prepare(`
    INSERT INTO messages (id, from_agent, to_agent, type, text, payload, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(params.messageId, params.from, params.to, params.type, params.text || null, payload, params.signature);

  return { ok: true, deprecated: true, data: { messageId: params.messageId } };
}

/**
 * v1 GET /relay/inbox/:agent — poll for pending messages.
 */
export function v1Inbox(
  db: Database.Database,
  agent: string,
  sunsetDate: Date,
  now: number = Date.now(),
  log: DeprecationLogger = defaultLogger,
): V1Result {
  if (isSunset(sunsetDate, now)) return sunsetResponse();

  log('GET /relay/inbox', agent);

  const messages = db.prepare(`
    SELECT id, from_agent, to_agent, type, text, payload, signature, created_at
    FROM messages WHERE to_agent = ?
    ORDER BY created_at ASC LIMIT 50
  `).all(agent) as Array<{
    id: string; from_agent: string; to_agent: string; type: string;
    text: string | null; payload: string; signature: string; created_at: string;
  }>;

  return {
    ok: true,
    deprecated: true,
    data: messages.map((m) => ({
      id: m.id,
      from: m.from_agent,
      to: m.to_agent,
      type: m.type,
      text: m.text,
      payload: m.payload,
      signature: m.signature,
      createdAt: m.created_at,
    })),
  };
}

/**
 * v1 POST /relay/inbox/:agent/ack — acknowledge messages.
 */
export function v1Ack(
  db: Database.Database,
  agent: string,
  messageIds: string[],
  sunsetDate: Date,
  now: number = Date.now(),
  log: DeprecationLogger = defaultLogger,
): V1Result {
  if (isSunset(sunsetDate, now)) return sunsetResponse();

  log('POST /relay/inbox/ack', agent);

  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return { ok: false, status: 400, error: 'messageIds array required', deprecated: true };
  }

  const placeholders = messageIds.map(() => '?').join(',');
  const result = db.prepare(
    `DELETE FROM messages WHERE to_agent = ? AND id IN (${placeholders})`
  ).run(agent, ...messageIds);

  return { ok: true, deprecated: true, data: { deleted: result.changes } };
}
