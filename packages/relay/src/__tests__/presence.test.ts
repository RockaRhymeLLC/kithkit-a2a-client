/**
 * Tests for presence system (t-061).
 *
 * t-061: Presence heartbeat (v3: getPresence/batchPresence removed, 410 at route level)
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import { updatePresence } from '../routes/presence.js';

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

/** Register an active agent. */
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

  // Step 1: Register agent
  it('step 1: register and approve alpha', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const row = db.prepare("SELECT status FROM agents WHERE name = 'alpha'").get() as any;
    assert.equal(row.status, 'active');

    db.close();
  });

  // Step 2: Heartbeat updates last_seen and endpoint
  it('step 2: heartbeat updates last_seen and endpoint', () => {
    const db = withDb();
    const alpha = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);

    const now = Date.now();
    const result = updatePresence(db, 'alpha', 'https://alpha.example.com/network/inbox', now);
    assert.equal(result.ok, true);

    const row = db.prepare("SELECT last_seen, endpoint FROM agents WHERE name = 'alpha'").get() as any;
    assert.ok(row.last_seen);
    assert.equal(row.endpoint, 'https://alpha.example.com/network/inbox');

    db.close();
  });

  // Step 3: Heartbeat verifies last_seen directly in DB
  it('step 5: multiple heartbeats update last_seen correctly', () => {
    const db = withDb();
    const alpha = genKeypair();
    const beta = genKeypair();
    createActiveAgent(db, 'alpha', alpha.publicKeyBase64);
    createActiveAgent(db, 'beta', beta.publicKeyBase64);

    const now = Date.now();
    updatePresence(db, 'alpha', 'https://alpha.example.com/inbox', now);
    updatePresence(db, 'beta', 'https://beta.example.com/inbox', now);

    const alphaRow = db.prepare("SELECT last_seen FROM agents WHERE name = 'alpha'").get() as any;
    const betaRow = db.prepare("SELECT last_seen FROM agents WHERE name = 'beta'").get() as any;
    assert.ok(alphaRow.last_seen);
    assert.ok(betaRow.last_seen);

    db.close();
  });
});

// ================================================================
// Presence: edge cases
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

});
