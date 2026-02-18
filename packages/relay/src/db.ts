/**
 * SQLite database — schema and query helpers.
 *
 * Uses better-sqlite3 for synchronous, fast SQLite access.
 * Database stored on local disk (never network filesystem — see MEMORY.md).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

/**
 * Current schema version. Increment when schema changes.
 */
const SCHEMA_VERSION = 6;

/**
 * Full v2 schema DDL.
 */
const V2_SCHEMA = `
  -- Agents — expanded from v1 (added endpoint, email_verified, last_seen, approved_by)
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

  -- Contacts — bidirectional relationships between agents
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

  -- Email verifications — code-based verification for registration
  CREATE TABLE IF NOT EXISTS email_verifications (
    agent_name TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    verified INTEGER DEFAULT 0
  );

  -- Admins — agents with admin privileges (multi-admin support)
  CREATE TABLE IF NOT EXISTS admins (
    agent TEXT PRIMARY KEY,
    admin_public_key TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent) REFERENCES agents(name)
  );

  -- Broadcasts — signed admin announcements
  CREATE TABLE IF NOT EXISTS broadcasts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    sender TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (sender) REFERENCES agents(name)
  );

  -- Rate limits — sliding window counters
  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start TEXT NOT NULL
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_contacts_agent_b ON contacts(agent_b);
  CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
  CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_agents_email ON agents(owner_email);
  CREATE INDEX IF NOT EXISTS idx_agents_pubkey ON agents(public_key);
  CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
`;

/**
 * V3 additive schema — group messaging tables.
 * No changes to existing Phase 1/v2 tables.
 */
const V3_GROUPS_SCHEMA = `
  -- Groups — named collections of agents
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'dissolved')),
    members_can_invite INTEGER DEFAULT 0,
    members_can_send INTEGER DEFAULT 1,
    max_members INTEGER DEFAULT 50,
    created_at TEXT DEFAULT (datetime('now')),
    dissolved_at TEXT,
    FOREIGN KEY (owner) REFERENCES agents(name)
  );

  -- Group memberships — which agents belong to which groups
  CREATE TABLE IF NOT EXISTS group_memberships (
    group_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'removed', 'left')),
    invited_by TEXT,
    greeting TEXT,
    joined_at TEXT,
    left_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, agent),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (agent) REFERENCES agents(name),
    FOREIGN KEY (invited_by) REFERENCES agents(name)
  );

  CREATE INDEX IF NOT EXISTS idx_memberships_agent ON group_memberships(agent);
  CREATE INDEX IF NOT EXISTS idx_memberships_status ON group_memberships(status);
`;

/**
 * V4 additive schema — contact redesign (blocks table, denial tracking).
 */
const V4_CONTACTS_SCHEMA = `
  -- Blocks — directional block records (blocker blocks blocked)
  CREATE TABLE IF NOT EXISTS blocks (
    blocker TEXT NOT NULL,
    blocked TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (blocker, blocked),
    FOREIGN KEY (blocker) REFERENCES agents(name),
    FOREIGN KEY (blocked) REFERENCES agents(name)
  );
`;

/**
 * Initialize a new database at the given path with v2 schema.
 * Returns the database instance.
 */
export function initializeDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Performance/reliability pragmas
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = DELETE'); // Safe on all filesystems
  db.pragma('foreign_keys = ON');

  // Apply schema (additive — v2 base + v3 groups + v4 contacts)
  db.exec(V2_SCHEMA);
  db.exec(V3_GROUPS_SCHEMA);
  db.exec(V4_CONTACTS_SCHEMA);

  // V4: Add denial_count column to contacts (ALTER TABLE, idempotent)
  try {
    db.exec('ALTER TABLE contacts ADD COLUMN denial_count INTEGER DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }

  // V5: Add key rotation columns to agents (ALTER TABLE, idempotent)
  for (const col of [
    'key_updated_at TEXT',
    'recovery_initiated_at TEXT',
    'pending_public_key TEXT',
  ]) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }

  // V6: Drop v1-compat tables (messages, nonces) — v1 sunset passed
  db.exec('DROP TABLE IF EXISTS messages');
  db.exec('DROP TABLE IF EXISTS nonces');

  // Track schema version
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  db.prepare(
    'INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)'
  ).run('schema_version', String(SCHEMA_VERSION));

  _db = db;
  _dbPath = dbPath;

  return db;
}

/**
 * Get the current database instance. Must call initializeDatabase first.
 */
export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('Database not initialized — call initializeDatabase() first');
  }
  return _db;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

/**
 * Get the current schema version.
 */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM _meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}
