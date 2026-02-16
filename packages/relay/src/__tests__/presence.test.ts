/**
 * Tests for presence system (t-061).
 *
 * t-061: Presence heartbeat, offline detection, batch query
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import {
  updatePresence,
  getPresence,
  batchPresence,
} from '../routes/presence.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-presence-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return { publicKeyBase64: Buffer.from(pubDer).toString('base64') };
}

/** Register and approve an agent (admin-fast-path for tests). */
function createActiveAgent(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  publicKeyBase64: string,
  endpoint?: string,
) {
  db.prepare(
    "INSERT INTO agents (name, public_key, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'test-admin', datetime('now'))"
  ).run(name, publicKeyBase64, endpoint || null);
}

/** 20 minutes in ms — the offline threshold (2x 10-minute heartbeat). */
const OFFLINE_THRESHOLD_MS = 20 * 60 * 1000;

// ================================================================
// t-061: Presence heartbeat, offline detection, batch query
// ================================================================

describe('t-061: Presence heartbeat, offline detection, batch query', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  // Step 1: Register and approve agent 'alpha'
  it('step 1: register and approve alpha', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const row = db.prepare("SELECT status FROM agents WHERE name = 'alpha'").get() as any;
    assert.equal(row.status, 'active');

    db.close();
  });

  // Step 2: PUT /presence as alpha with endpoint
  it('step 2: heartbeat updates last_seen and endpoint', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const now = Date.now();
    const result = updatePresence(db, 'alpha', 'https://alpha.example.com/network/inbox', now);
    assert.equal(result.ok, true);

    // Verify last_seen is set
    const row = db.prepare("SELECT last_seen, endpoint FROM agents WHERE name = 'alpha'").get() as any;
    assert.ok(row.last_seen);
    assert.equal(row.endpoint, 'https://alpha.example.com/network/inbox');

    db.close();
  });

  // Step 3: GET /presence/alpha → online with endpoint
  it('step 3: get presence shows online with endpoint', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'alpha', 'https://alpha.example.com/network/inbox', now);

    const presence = getPresence(db, 'alpha', now);
    assert.ok(presence);
    assert.equal(presence.online, true);
    assert.equal(presence.endpoint, 'https://alpha.example.com/network/inbox');
    assert.ok(presence.lastSeen);

    db.close();
  });

  // Step 4-5: Simulate staleness → offline
  it('steps 4-5: stale last_seen → offline', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'alpha', 'https://alpha.example.com/network/inbox', now);

    // 21 minutes later (past 2x 10-min threshold)
    const future = now + OFFLINE_THRESHOLD_MS + 60_000;
    const presence = getPresence(db, 'alpha', future);
    assert.ok(presence);
    assert.equal(presence.online, false);

    db.close();
  });

  // Step 6: PUT /presence again → back online
  it('step 6: fresh heartbeat brings agent back online', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'alpha', 'https://alpha.example.com/network/inbox', now);

    // Go stale
    const staleTime = now + OFFLINE_THRESHOLD_MS + 60_000;
    assert.equal(getPresence(db, 'alpha', staleTime)!.online, false);

    // Fresh heartbeat
    updatePresence(db, 'alpha', 'https://alpha.example.com/network/inbox', staleTime);
    assert.equal(getPresence(db, 'alpha', staleTime)!.online, true);

    db.close();
  });

  // Step 7: Register beta, send heartbeat → online
  it('step 7: second agent beta heartbeat → online', () => {
    const db = withDb();
    const alpha = genKeypair();
    const beta = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);
    createActiveAgent(db, 'beta', beta.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'alpha', 'https://alpha.example.com/inbox', now);
    updatePresence(db, 'beta', 'https://beta.example.com/inbox', now);

    const betaPresence = getPresence(db, 'beta', now);
    assert.ok(betaPresence);
    assert.equal(betaPresence.online, true);

    db.close();
  });

  // Step 8: GET /presence/batch?agents=alpha,beta
  it('step 8: batch presence for alpha and beta', () => {
    const db = withDb();
    const alpha = genKeypair();
    const beta = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);
    createActiveAgent(db, 'beta', beta.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'alpha', 'https://alpha.example.com/inbox', now);
    updatePresence(db, 'beta', 'https://beta.example.com/inbox', now);

    const batch = batchPresence(db, ['alpha', 'beta'], now);
    assert.equal(batch.length, 2);

    const alphaInfo = batch.find((p) => p.agent === 'alpha');
    const betaInfo = batch.find((p) => p.agent === 'beta');
    assert.ok(alphaInfo);
    assert.ok(betaInfo);
    assert.equal(alphaInfo.online, true);
    assert.equal(betaInfo.online, true);

    db.close();
  });

  // Step 9: GET /presence/nonexistent → null
  it('step 9: nonexistent agent returns null', () => {
    const db = withDb();

    const presence = getPresence(db, 'nonexistent');
    assert.equal(presence, null);

    db.close();
  });
});

// ================================================================
// Additional presence coverage
// ================================================================

describe('Presence: edge cases', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withDb() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    return db;
  }

  it('heartbeat without endpoint only updates last_seen', () => {
    const db = withDb();
    const agent = genKeypair();
    createActiveAgent(db, 'agent', agent.publicKeyBase64, 'https://original.example.com/inbox');

    const now = Date.now();
    updatePresence(db, 'agent', undefined, now);

    const row = db.prepare("SELECT endpoint FROM agents WHERE name = 'agent'").get() as any;
    assert.equal(row.endpoint, 'https://original.example.com/inbox');

    db.close();
  });

  it('heartbeat for non-existent agent returns 404', () => {
    const db = withDb();
    const result = updatePresence(db, 'ghost');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    db.close();
  });

  it('revoked agent presence returns null', () => {
    const db = withDb();
    const agent = genKeypair();
    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'revoked')"
    ).run('revoked', agent.publicKeyBase64);

    const presence = getPresence(db, 'revoked');
    assert.equal(presence, null);
    db.close();
  });

  it('agent with no heartbeat shows offline', () => {
    const db = withDb();
    const agent = genKeypair();
    createActiveAgent(db, 'fresh', agent.publicKeyBase64);

    const presence = getPresence(db, 'fresh');
    assert.ok(presence);
    assert.equal(presence.online, false);
    assert.equal(presence.lastSeen, null);

    db.close();
  });

  it('batch with nonexistent agents returns offline entries', () => {
    const db = withDb();
    const batch = batchPresence(db, ['ghost1', 'ghost2']);
    assert.equal(batch.length, 2);
    assert.equal(batch[0]!.online, false);
    assert.equal(batch[1]!.online, false);
    db.close();
  });

  it('batch with empty list returns empty array', () => {
    const db = withDb();
    const batch = batchPresence(db, []);
    assert.equal(batch.length, 0);
    db.close();
  });

  it('exactly at threshold boundary is still online', () => {
    const db = withDb();
    const agent = genKeypair();
    createActiveAgent(db, 'edge', agent.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'edge', undefined, now);

    // Exactly at 20 min = still online (<=)
    const atThreshold = now + OFFLINE_THRESHOLD_MS;
    assert.equal(getPresence(db, 'edge', atThreshold)!.online, true);

    // 1ms past = offline
    assert.equal(getPresence(db, 'edge', atThreshold + 1)!.online, false);

    db.close();
  });
});
