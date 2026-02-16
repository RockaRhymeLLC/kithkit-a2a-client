/**
 * Tests for relay database schema (t-054).
 *
 * t-054: Relay schema migration — verify all v2 tables, columns, and constraints.
 *
 * Uses temporary in-memory/file databases per test for isolation.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase, getSchemaVersion } from '../db.js';

/** Create a temp DB for each test. */
function createTempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir, dbPath };
}

describe('t-054: Relay schema migration (v1 → v2 tables)', () => {
  let cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  function withDb() {
    const { db, dir } = createTempDb();
    cleanup.push(() => {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });
    return db;
  }

  // Step 1: Create fresh database with v2 schema
  it('step 1: creates database with all tables', () => {
    const db = withDb();

    // List all tables
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];

    const tableNames = tables.map((t) => t.name).sort();
    assert.ok(tableNames.includes('agents'), 'agents table exists');
    assert.ok(tableNames.includes('contacts'), 'contacts table exists');
    assert.ok(tableNames.includes('email_verifications'), 'email_verifications table exists');
    assert.ok(tableNames.includes('admins'), 'admins table exists');
    assert.ok(tableNames.includes('broadcasts'), 'broadcasts table exists');
    assert.ok(tableNames.includes('rate_limits'), 'rate_limits table exists');

    // Schema version should be 2
    assert.equal(getSchemaVersion(db), 2);
  });

  // Step 2: Verify agents table columns
  it('step 2: agents table has all v2 columns', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(agents)').all() as
      { name: string; type: string; notnull: number }[];

    const colNames = columns.map((c) => c.name);
    const expected = [
      'name', 'public_key', 'owner_email', 'endpoint',
      'email_verified', 'status', 'last_seen',
      'created_at', 'approved_by', 'approved_at',
    ];

    for (const col of expected) {
      assert.ok(colNames.includes(col), `Missing column: ${col}`);
    }

    // Check types
    const colMap = Object.fromEntries(columns.map((c) => [c.name, c]));
    assert.equal(colMap.name!.type, 'TEXT');
    assert.equal(colMap.public_key!.type, 'TEXT');
    assert.equal(colMap.email_verified!.type, 'INTEGER');
  });

  // Step 3: Verify contacts table
  it('step 3: contacts table has composite PK and expected columns', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(contacts)').all() as
      { name: string; pk: number }[];

    const colNames = columns.map((c) => c.name);
    assert.ok(colNames.includes('agent_a'));
    assert.ok(colNames.includes('agent_b'));
    assert.ok(colNames.includes('status'));
    assert.ok(colNames.includes('requested_by'));
    assert.ok(colNames.includes('greeting'));
    assert.ok(colNames.includes('created_at'));
    assert.ok(colNames.includes('updated_at'));

    // Composite PK: agent_a (pk=1) and agent_b (pk=2)
    const pks = columns.filter((c) => c.pk > 0).map((c) => c.name).sort();
    assert.deepStrictEqual(pks, ['agent_a', 'agent_b']);
  });

  // Step 4: Verify email_verifications table
  it('step 4: email_verifications table has correct structure', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(email_verifications)').all() as
      { name: string }[];

    const colNames = columns.map((c) => c.name);
    for (const col of ['agent_name', 'email', 'code_hash', 'attempts', 'expires_at', 'verified']) {
      assert.ok(colNames.includes(col), `Missing column: ${col}`);
    }
  });

  // Step 5: Verify admins table
  it('step 5: admins table has agent PK and admin_public_key', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(admins)').all() as
      { name: string; pk: number }[];

    const colNames = columns.map((c) => c.name);
    assert.ok(colNames.includes('agent'));
    assert.ok(colNames.includes('admin_public_key'));
    assert.ok(colNames.includes('added_at'));

    // agent is PK
    const pk = columns.find((c) => c.pk > 0);
    assert.equal(pk?.name, 'agent');
  });

  // Step 6: Verify broadcasts table
  it('step 6: broadcasts table has correct structure', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(broadcasts)').all() as
      { name: string }[];

    const colNames = columns.map((c) => c.name);
    for (const col of ['id', 'type', 'payload', 'sender', 'signature', 'created_at']) {
      assert.ok(colNames.includes(col), `Missing column: ${col}`);
    }
  });

  // Step 7: Verify rate_limits table
  it('step 7: rate_limits table has key PK, count, window_start', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(rate_limits)').all() as
      { name: string; pk: number }[];

    const colNames = columns.map((c) => c.name);
    assert.ok(colNames.includes('key'));
    assert.ok(colNames.includes('count'));
    assert.ok(colNames.includes('window_start'));

    const pk = columns.find((c) => c.pk > 0);
    assert.equal(pk?.name, 'key');
  });

  // Step 8: Insert and query an agent
  it('step 8: insert and query agent roundtrip', () => {
    const db = withDb();

    db.prepare(
      'INSERT INTO agents (name, public_key, owner_email, endpoint, status) VALUES (?, ?, ?, ?, ?)'
    ).run('test-agent', 'pubkey123', 'test@example.com', 'https://example.com/inbox', 'active');

    const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get('test-agent') as any;

    assert.equal(agent.name, 'test-agent');
    assert.equal(agent.public_key, 'pubkey123');
    assert.equal(agent.owner_email, 'test@example.com');
    assert.equal(agent.endpoint, 'https://example.com/inbox');
    assert.equal(agent.status, 'active');
    assert.equal(agent.email_verified, 0); // default
    assert.ok(agent.created_at); // auto-set
  });

  // Step 9: Foreign key constraints enforced
  it('step 9: FK constraint rejects contact referencing non-existent agent', () => {
    const db = withDb();

    assert.throws(() => {
      db.prepare(
        'INSERT INTO contacts (agent_a, agent_b, requested_by) VALUES (?, ?, ?)'
      ).run('nonexistent-a', 'nonexistent-b', 'nonexistent-a');
    }, /FOREIGN KEY constraint failed/i, 'FK constraint should prevent inserting contact for missing agents');
  });
});

// ================================================================
// Additional schema coverage
// ================================================================

describe('Schema: constraint checks', () => {
  let cleanup: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  function withDb() {
    const { db, dir } = createTempDb();
    cleanup.push(() => {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    });
    return db;
  }

  it('agents status CHECK constraint rejects invalid status', () => {
    const db = withDb();
    assert.throws(() => {
      db.prepare(
        'INSERT INTO agents (name, public_key, status) VALUES (?, ?, ?)'
      ).run('bad-agent', 'key', 'invalid-status');
    }, /CHECK constraint/i);
  });

  it('contacts status CHECK constraint rejects invalid status', () => {
    const db = withDb();
    // First insert agents
    db.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('a', 'key-a');
    db.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('b', 'key-b');

    assert.throws(() => {
      db.prepare(
        'INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES (?, ?, ?, ?)'
      ).run('a', 'b', 'invalid-status', 'a');
    }, /CHECK constraint/i);
  });

  it('valid contact insert succeeds with FK', () => {
    const db = withDb();
    db.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('alice', 'key-a');
    db.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('bob', 'key-b');

    db.prepare(
      'INSERT INTO contacts (agent_a, agent_b, requested_by, greeting) VALUES (?, ?, ?, ?)'
    ).run('alice', 'bob', 'alice', 'Hi Bob!');

    const contact = db.prepare('SELECT * FROM contacts WHERE agent_a = ?').get('alice') as any;
    assert.equal(contact.agent_b, 'bob');
    assert.equal(contact.greeting, 'Hi Bob!');
    assert.equal(contact.status, 'pending'); // default
  });

  it('schema is idempotent (re-initialize same DB)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
    const dbPath = join(dir, 'relay.db');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const db1 = initializeDatabase(dbPath);
    db1.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('persistent', 'key');
    db1.close();

    // Re-initialize same path — should not lose data
    const db2 = initializeDatabase(dbPath);
    const agent = db2.prepare('SELECT name FROM agents WHERE name = ?').get('persistent') as any;
    assert.equal(agent?.name, 'persistent', 'Data should survive re-initialization');
    db2.close();
  });
});
