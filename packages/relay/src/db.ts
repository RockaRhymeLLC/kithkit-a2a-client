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
 * V2 schema version. Increment when schema changes.
 */
const SCHEMA_VERSION = 2;

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

  -- v1 compat: messages table (for 30-day migration period)
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

  -- v1 compat: nonces table (for replay protection during migration)
  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    seen_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_contacts_agent_b ON contacts(agent_b);
  CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
  CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_nonces_seen_at ON nonces(seen_at);
  CREATE INDEX IF NOT EXISTS idx_broadcasts_created_at ON broadcasts(created_at);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
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

  // Apply schema
  db.exec(V2_SCHEMA);

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
