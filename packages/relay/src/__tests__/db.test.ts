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

    // Schema version should be 4 (v2 base + v3 groups + v4 contacts)
    assert.equal(getSchemaVersion(db), 6);
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

// ================================================================
// t-080: Schema v3 migration — groups tables
// ================================================================

describe('t-080: Schema v3 migration creates groups tables', () => {
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

  // Step 1: Initialize relay DB — Phase 1 tables present
  it('step 1: DB has Phase 1 tables', () => {
    const db = withDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('agents'));
    assert.ok(names.includes('contacts'));
    assert.ok(names.includes('broadcasts'));
  });

  // Step 2: v3 migration creates groups and group_memberships
  it('step 2: groups and group_memberships tables created', () => {
    const db = withDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);
    assert.ok(names.includes('groups'), 'groups table exists');
    assert.ok(names.includes('group_memberships'), 'group_memberships table exists');
  });

  // Step 3: groups table columns
  it('step 3: groups table has all required columns', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(groups)').all() as
      { name: string; type: string; notnull: number; pk: number }[];
    const colNames = columns.map((c) => c.name);

    for (const col of [
      'id', 'name', 'owner', 'status', 'members_can_invite',
      'members_can_send', 'max_members', 'created_at', 'dissolved_at',
    ]) {
      assert.ok(colNames.includes(col), `Missing column: ${col}`);
    }

    // id is PK
    const pk = columns.find((c) => c.pk > 0);
    assert.equal(pk?.name, 'id');
  });

  // Step 4: group_memberships columns
  it('step 4: group_memberships has all required columns', () => {
    const db = withDb();
    const columns = db.prepare('PRAGMA table_info(group_memberships)').all() as
      { name: string; pk: number }[];
    const colNames = columns.map((c) => c.name);

    for (const col of [
      'group_id', 'agent', 'role', 'status', 'invited_by',
      'greeting', 'joined_at', 'left_at', 'created_at',
    ]) {
      assert.ok(colNames.includes(col), `Missing column: ${col}`);
    }

    // Composite PK: group_id + agent
    const pks = columns.filter((c) => c.pk > 0).map((c) => c.name).sort();
    assert.deepStrictEqual(pks, ['agent', 'group_id']);
  });

  // Step 5: indexes exist
  it('step 5: idx_memberships_agent and idx_memberships_status created', () => {
    const db = withDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memberships%'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);

    assert.ok(names.includes('idx_memberships_agent'), 'idx_memberships_agent exists');
    assert.ok(names.includes('idx_memberships_status'), 'idx_memberships_status exists');
  });

  // Step 6: schema_version = 4
  it('step 6: schema_version is 4', () => {
    const db = withDb();
    assert.equal(getSchemaVersion(db), 6);
  });

  // Step 7: Phase 1 tables intact
  it('step 7: Phase 1 tables unchanged with data preserved', () => {
    const db = withDb();

    // Insert Phase 1 data
    db.prepare('INSERT INTO agents (name, public_key, status) VALUES (?, ?, ?)').run('alice', 'key-a', 'active');
    db.prepare('INSERT INTO agents (name, public_key, status) VALUES (?, ?, ?)').run('bob', 'key-b', 'active');
    db.prepare('INSERT INTO contacts (agent_a, agent_b, requested_by) VALUES (?, ?, ?)').run('alice', 'bob', 'alice');
    db.prepare('INSERT INTO admins (agent, admin_public_key) VALUES (?, ?)').run('alice', 'admin-key');
    db.prepare("INSERT INTO broadcasts (id, type, payload, sender, signature) VALUES (?, ?, ?, ?, ?)").run('b1', 'test', '{}', 'alice', 'sig');

    // Verify all data intact
    const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get('alice') as any;
    assert.equal(agent.name, 'alice');
    assert.equal(agent.status, 'active');

    const contact = db.prepare('SELECT * FROM contacts WHERE agent_a = ?').get('alice') as any;
    assert.equal(contact.agent_b, 'bob');

    const admin = db.prepare('SELECT * FROM admins WHERE agent = ?').get('alice') as any;
    assert.equal(admin.admin_public_key, 'admin-key');

    const broadcast = db.prepare('SELECT * FROM broadcasts WHERE id = ?').get('b1') as any;
    assert.equal(broadcast.sender, 'alice');
  });

  // Additional: CHECK constraints on groups
  it('groups status CHECK constraint rejects invalid status', () => {
    const db = withDb();
    db.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('owner1', 'key');
    assert.throws(() => {
      db.prepare(
        "INSERT INTO groups (id, name, owner, status) VALUES (?, ?, ?, ?)"
      ).run('g1', 'Test', 'owner1', 'invalid');
    }, /CHECK constraint/i);
  });

  // Additional: CHECK constraints on group_memberships role
  it('group_memberships role CHECK rejects invalid role', () => {
    const db = withDb();
    db.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('owner1', 'key');
    db.prepare("INSERT INTO groups (id, name, owner) VALUES (?, ?, ?)").run('g1', 'Test', 'owner1');
    assert.throws(() => {
      db.prepare(
        "INSERT INTO group_memberships (group_id, agent, role) VALUES (?, ?, ?)"
      ).run('g1', 'owner1', 'superadmin');
    }, /CHECK constraint/i);
  });

  // Additional: FK constraint on groups.owner
  it('groups FK constraint rejects non-existent owner', () => {
    const db = withDb();
    assert.throws(() => {
      db.prepare(
        "INSERT INTO groups (id, name, owner) VALUES (?, ?, ?)"
      ).run('g1', 'Test', 'nonexistent');
    }, /FOREIGN KEY constraint/i);
  });

  // Additional: idempotent migration
  it('v3 schema is idempotent (re-initialize preserves data)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
    const dbPath = join(dir, 'relay.db');
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

    const db1 = initializeDatabase(dbPath);
    db1.prepare('INSERT INTO agents (name, public_key) VALUES (?, ?)').run('owner1', 'key');
    db1.prepare("INSERT INTO groups (id, name, owner) VALUES (?, ?, ?)").run('g1', 'Test', 'owner1');
    db1.prepare("INSERT INTO group_memberships (group_id, agent, role, status) VALUES (?, ?, ?, ?)").run('g1', 'owner1', 'owner', 'active');
    db1.close();

    // Re-initialize — data should survive
    const db2 = initializeDatabase(dbPath);
    const group = db2.prepare('SELECT * FROM groups WHERE id = ?').get('g1') as any;
    assert.equal(group.name, 'Test');
    const membership = db2.prepare('SELECT * FROM group_memberships WHERE group_id = ?').get('g1') as any;
    assert.equal(membership.role, 'owner');
    assert.equal(getSchemaVersion(db2), 6);
    db2.close();
  });
});
