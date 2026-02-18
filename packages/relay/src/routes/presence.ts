/**
 * Presence routes — heartbeat, single/batch presence queries.
 *
 * PUT /presence              — Heartbeat (update endpoint + last_seen)
 * GET /presence/:agent       — Check single agent's presence
 * GET /presence/batch        — Check multiple agents (?agents=a,b,c)
 *
 * An agent is "online" if last_seen is within 2x the heartbeat interval.
 * Default heartbeat interval: 10 minutes → offline after 20 minutes.
 */

import type Database from 'better-sqlite3';

/** Default heartbeat interval in ms (10 minutes). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/** Offline threshold = 2x heartbeat interval. */
const OFFLINE_THRESHOLD_MS = 2 * DEFAULT_HEARTBEAT_INTERVAL_MS;

export interface PresenceInfo {
  agent: string;
  online: boolean;
  endpoint: string | null;
  lastSeen: string | null;
}

export interface HeartbeatResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Update an agent's presence (heartbeat).
 * Sets endpoint and last_seen to now.
 */
export function updatePresence(
  db: Database.Database,
  agent: string,
  endpoint?: string,
  now: number = Date.now(),
): HeartbeatResult {
  const row = db.prepare(
    "SELECT name, status FROM agents WHERE name = ? AND status = 'active'"
  ).get(agent) as { name: string; status: string } | undefined;

  if (!row) {
    return { ok: false, status: 404, error: 'Agent not found or not active' };
  }

  const timestamp = new Date(now).toISOString();

  if (endpoint !== undefined) {
    db.prepare(
      'UPDATE agents SET last_seen = ?, endpoint = ? WHERE name = ?'
    ).run(timestamp, endpoint, agent);
  } else {
    db.prepare(
      'UPDATE agents SET last_seen = ? WHERE name = ?'
    ).run(timestamp, agent);
  }

  return { ok: true };
}

/**
 * Check if an agent is online based on their last_seen timestamp.
 */
function isOnline(lastSeen: string | null, now: number): boolean {
  if (!lastSeen) return false;
  const lastSeenMs = new Date(lastSeen).getTime();
  return (now - lastSeenMs) <= OFFLINE_THRESHOLD_MS;
}
