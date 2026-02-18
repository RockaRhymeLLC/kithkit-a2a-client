/**
 * Tests for schema migration (t-111).
 *
 * t-111: Migration preserves existing agents and contacts.
 * Verifies that running initializeDatabase on a pre-v3 database
 * preserves all existing data and applies new schema changes.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initializeDatabase, getSchemaVersion } from '../db.js';

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return { publicKeyBase64: Buffer.from(pubDer).toString('base64') };
}

/**
 * Create a database with the old v2 schema (pre-v3 contacts redesign).
 * Includes messages and nonces tables (v1 compat), no blocks table,
 * no denial_count column, no key rotation columns.
 */
function createOldSchemaDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      owner_email TEXT,
      endpoint TEXT,
      email_verified INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'revoked')),
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      approved_by TEXT,
      approved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS contacts (
      agent_a TEXT NOT NULL,
      agent_b TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'denied', 'removed')),
      requested_by TEXT NOT NULL,
      greeting TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (agent_a, agent_b),
      FOREIGN KEY (agent_a) REFERENCES agents(name),
      FOREIGN KEY (agent_b) REFERENCES agents(name),
      FOREIGN KEY (requested_by) REFERENCES agents(name)
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      agent_name TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at TEXT NOT NULL,
      verified INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS admins (
      agent TEXT PRIMARY KEY,
      admin_public_key TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent) REFERENCES agents(name)
    );

    CREATE TABLE IF NOT EXISTS broadcasts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      sender TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (sender) REFERENCES agents(name)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER DEFAULT 0,
      window_start TEXT NOT NULL
    );

    -- v1 compat tables (should be dropped by migration)
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      payload TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (to_agent) REFERENCES agents(name)
    );

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      seen_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)').run('schema_version', '2');

  return db;
}

// ================================================================
// t-111: Migration preserves existing agents and contacts
// ================================================================

describe('t-111: Migration preserves existing agents and contacts', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  // Step 1: Create DB with old schema, insert agents and contacts
  it('step 1: create old schema DB with agents and contacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migration-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'relay.db');

    const db = createOldSchemaDb(dbPath);
    const bmo = genKeypair();
    const r2d2 = genKeypair();
    const marvbot = genKeypair();

    // Insert agents as active
    db.prepare(
      "INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, ?, 1, 'active', 'bootstrap', datetime('now'))"
    ).run('bmo', bmo.publicKeyBase64, 'bmo@bmobot.ai', 'https://bmo.example.com/inbox');
    db.prepare(
      "INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, ?, 1, 'active', 'bootstrap', datetime('now'))"
    ).run('r2d2', r2d2.publicKeyBase64, 'r2@bmobot.ai', 'https://r2.example.com/inbox');
    db.prepare(
      "INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, ?, 1, 'active', 'bootstrap', datetime('now'))"
    ).run('marvbot', marvbot.publicKeyBase64, 'marv@example.com', 'https://marv.example.com/inbox');

    // Insert contacts (bmo <-> r2d2 active, bmo <-> marvbot active)
    db.prepare(
      "INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES ('bmo', 'r2d2', 'active', 'bmo')"
    ).run();
    db.prepare(
      "INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES ('bmo', 'marvbot', 'active', 'marvbot')"
    ).run();

    // Insert some v1 compat data
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, type, text, payload, signature) VALUES ('msg-1', 'bmo', 'r2d2', 'text', 'hello', '{}', 'sig')"
    ).run();
    db.prepare(
      "INSERT INTO nonces (nonce) VALUES ('nonce-1')"
    ).run();

    // Verify old schema version
    assert.equal(getSchemaVersion(db), 2);

    const agents = db.prepare('SELECT name, status FROM agents ORDER BY name').all() as any[];
    assert.equal(agents.length, 3);

    const contacts = db.prepare('SELECT * FROM contacts').all() as any[];
    assert.equal(contacts.length, 2);

    db.close();
  });

  // Step 2: Run migration (initializeDatabase on same path)
  it('step 2: migration completes without error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migration-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'relay.db');

    // Create old schema with data
    const oldDb = createOldSchemaDb(dbPath);
    const bmo = genKeypair();
    const r2d2 = genKeypair();
    const marvbot = genKeypair();

    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'bootstrap', datetime('now'))"
    ).run('bmo', bmo.publicKeyBase64, 'bmo@bmobot.ai');
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'bootstrap', datetime('now'))"
    ).run('r2d2', r2d2.publicKeyBase64, 'r2@bmobot.ai');
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'bootstrap', datetime('now'))"
    ).run('marvbot', marvbot.publicKeyBase64, 'marv@example.com');

    oldDb.prepare(
      "INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES ('bmo', 'r2d2', 'active', 'bmo')"
    ).run();
    oldDb.prepare(
      "INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES ('bmo', 'marvbot', 'active', 'marvbot')"
    ).run();

    // Add v1 compat data
    oldDb.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, type, text, payload, signature) VALUES ('msg-1', 'bmo', 'r2d2', 'text', 'hello', '{}', 'sig')"
    ).run();
    oldDb.prepare("INSERT INTO nonces (nonce) VALUES ('nonce-1')").run();

    oldDb.close();

    // Run migration
    const db = initializeDatabase(dbPath);
    assert.equal(getSchemaVersion(db), 6);

    db.close();
  });

  // Step 3: Query existing agents — all retain status='active'
  it('step 3: existing agents retain active status and all fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migration-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'relay.db');

    const oldDb = createOldSchemaDb(dbPath);
    const bmo = genKeypair();
    const r2d2 = genKeypair();
    const marvbot = genKeypair();

    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, 'bmo@bmobot.ai', 'https://bmo.example.com/inbox', 1, 'active', 'bootstrap', datetime('now'))"
    ).run('bmo', bmo.publicKeyBase64);
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, 'r2@bmobot.ai', 'https://r2.example.com/inbox', 1, 'active', 'bootstrap', datetime('now'))"
    ).run('r2d2', r2d2.publicKeyBase64);
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, 'marv@example.com', 'https://marv.example.com/inbox', 1, 'active', 'bootstrap', datetime('now'))"
    ).run('marvbot', marvbot.publicKeyBase64);

    oldDb.close();

    // Run migration
    const db = initializeDatabase(dbPath);

    const agents = db.prepare('SELECT name, status, public_key, owner_email, endpoint FROM agents ORDER BY name').all() as any[];
    assert.equal(agents.length, 3);

    // bmo
    assert.equal(agents[0].name, 'bmo');
    assert.equal(agents[0].status, 'active');
    assert.equal(agents[0].public_key, bmo.publicKeyBase64);
    assert.equal(agents[0].owner_email, 'bmo@bmobot.ai');
    assert.equal(agents[0].endpoint, 'https://bmo.example.com/inbox');

    // marvbot
    assert.equal(agents[1].name, 'marvbot');
    assert.equal(agents[1].status, 'active');

    // r2d2
    assert.equal(agents[2].name, 'r2d2');
    assert.equal(agents[2].status, 'active');

    // New columns should exist with defaults
    const bmoRow = db.prepare('SELECT key_updated_at, recovery_initiated_at, pending_public_key FROM agents WHERE name = ?').get('bmo') as any;
    assert.equal(bmoRow.key_updated_at, null);
    assert.equal(bmoRow.recovery_initiated_at, null);
    assert.equal(bmoRow.pending_public_key, null);

    db.close();
  });

  // Step 4: Query existing contacts — preserved with denial_count=0
  it('step 4: existing contacts preserved with denial_count=0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migration-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'relay.db');

    const oldDb = createOldSchemaDb(dbPath);
    const bmo = genKeypair();
    const r2d2 = genKeypair();
    const marvbot = genKeypair();

    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, email_verified, status, approved_by, approved_at) VALUES (?, ?, 'bmo@bmobot.ai', 1, 'active', 'bootstrap', datetime('now'))"
    ).run('bmo', bmo.publicKeyBase64);
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, email_verified, status, approved_by, approved_at) VALUES (?, ?, 'r2@bmobot.ai', 1, 'active', 'bootstrap', datetime('now'))"
    ).run('r2d2', r2d2.publicKeyBase64);
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, owner_email, email_verified, status, approved_by, approved_at) VALUES (?, ?, 'marv@example.com', 1, 'active', 'bootstrap', datetime('now'))"
    ).run('marvbot', marvbot.publicKeyBase64);

    oldDb.prepare(
      "INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES ('bmo', 'r2d2', 'active', 'bmo')"
    ).run();
    oldDb.prepare(
      "INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES ('bmo', 'marvbot', 'active', 'marvbot')"
    ).run();

    oldDb.close();

    // Run migration
    const db = initializeDatabase(dbPath);

    const contacts = db.prepare(
      'SELECT agent_a, agent_b, status, denial_count FROM contacts ORDER BY agent_b'
    ).all() as any[];
    assert.equal(contacts.length, 2);

    // bmo <-> marvbot
    assert.equal(contacts[0].agent_a, 'bmo');
    assert.equal(contacts[0].agent_b, 'marvbot');
    assert.equal(contacts[0].status, 'active');
    assert.equal(contacts[0].denial_count, 0);

    // bmo <-> r2d2
    assert.equal(contacts[1].agent_a, 'bmo');
    assert.equal(contacts[1].agent_b, 'r2d2');
    assert.equal(contacts[1].status, 'active');
    assert.equal(contacts[1].denial_count, 0);

    db.close();
  });

  // Additional: v1 compat tables are dropped
  it('v1 messages and nonces tables are dropped by migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migration-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'relay.db');

    const oldDb = createOldSchemaDb(dbPath);
    const bmo = genKeypair();
    oldDb.prepare(
      "INSERT INTO agents (name, public_key, email_verified, status, approved_by) VALUES (?, ?, 1, 'active', 'bootstrap')"
    ).run('bmo', bmo.publicKeyBase64);

    // Insert v1 data
    oldDb.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, type, text, payload, signature) VALUES ('msg-1', 'bmo', 'bmo', 'text', 'hello', '{}', 'sig')"
    ).run();
    oldDb.prepare("INSERT INTO nonces (nonce) VALUES ('nonce-1')").run();

    // Verify tables exist
    const tablesBefore = oldDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages', 'nonces') ORDER BY name"
    ).all() as any[];
    assert.equal(tablesBefore.length, 2);

    oldDb.close();

    // Run migration
    const db = initializeDatabase(dbPath);

    // Verify tables are gone
    const tablesAfter = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('messages', 'nonces') ORDER BY name"
    ).all() as any[];
    assert.equal(tablesAfter.length, 0);

    db.close();
  });

  // Additional: new tables exist after migration
  it('new tables (blocks, groups) exist after migration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-migration-test-'));
    cleanupDirs.push(dir);
    const dbPath = join(dir, 'relay.db');

    const oldDb = createOldSchemaDb(dbPath);
    oldDb.close();

    const db = initializeDatabase(dbPath);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('blocks', 'groups', 'group_memberships') ORDER BY name"
    ).all() as any[];
    assert.equal(tables.length, 3);
    assert.equal(tables[0].name, 'blocks');
    assert.equal(tables[1].name, 'group_memberships');
    assert.equal(tables[2].name, 'groups');

    db.close();
  });
});
