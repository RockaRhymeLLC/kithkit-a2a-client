/**
 * Tests for key rotation + recovery (t-106, t-107).
 *
 * t-106: Key rotation updates public key
 * t-107: Key recovery with cooling-off period
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import { hashCode } from '../email.js';
import { buildSigningString, hashBody } from '../auth.js';
import {
  registerAgent,
  lookupAgent,
  rotateKey,
  recoverKey,
} from '../routes/registry.js';
import {
  requestContact,
  acceptContact,
  listContacts,
} from '../routes/contacts.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-keyrot-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

/** Generate an Ed25519 keypair and return base64 SPKI public key. */
function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
  };
}

/** Set up email verification for an agent (simulate /verify flow). */
function verifyEmail(db: ReturnType<typeof initializeDatabase>, agentName: string, email: string) {
  const code = '123456';
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO email_verifications (agent_name, email, code_hash, attempts, expires_at, verified)
    VALUES (?, ?, ?, 0, ?, 1)
    ON CONFLICT(agent_name) DO UPDATE SET email = excluded.email, verified = 1
  `).run(agentName, email, codeHash, expiresAt);
}

/** Register an agent with verified email. Returns the keypair. */
function registerWithEmail(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  email: string,
  endpoint?: string,
) {
  const kp = genKeypair();
  verifyEmail(db, name, email);
  registerAgent(db, name, kp.publicKeyBase64, email, endpoint || '');
  return kp;
}

// ================================================================
// t-106: Key rotation updates public key
// ================================================================

describe('t-106: Key rotation updates public key', () => {
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

  // Step 1: POST /registry/agents/:name/rotate-key with new public key → 200
  it('step 1: rotate-key with new public key succeeds', () => {
    const db = withDb();
    const oldKp = registerWithEmail(db, 'atlas', 'atlas@example.com', 'https://atlas.example.com/inbox');
    const newKp = genKeypair();

    const result = rotateKey(db, 'atlas', newKp.publicKeyBase64, 'atlas');
    assert.equal(result.ok, true);

    db.close();
  });

  // Step 2: GET /registry/agents/:name → publicKey is the new key
  it('step 2: lookupAgent returns updated publicKey after rotation', () => {
    const db = withDb();
    const oldKp = registerWithEmail(db, 'atlas', 'atlas@example.com', 'https://atlas.example.com/inbox');
    const newKp = genKeypair();

    rotateKey(db, 'atlas', newKp.publicKeyBase64, 'atlas');

    const agent = lookupAgent(db, 'atlas');
    assert.ok(agent);
    assert.equal(agent.publicKey, newKp.publicKeyBase64);
    assert.notEqual(agent.publicKey, oldKp.publicKeyBase64);

    db.close();
  });

  // Step 3: GET /contacts — contact shows updated publicKey and key_updated_at
  it('step 3: contacts show updated publicKey and key_updated_at', () => {
    const db = withDb();
    const atlas = registerWithEmail(db, 'atlas', 'atlas@example.com', 'https://atlas.example.com/inbox');
    const bmo = registerWithEmail(db, 'bmo', 'bmo@example.com', 'https://bmo.example.com/inbox');
    const newKp = genKeypair();

    // Establish contact
    requestContact(db, 'bmo', 'atlas');
    acceptContact(db, 'atlas', 'bmo');

    // Rotate atlas's key
    rotateKey(db, 'atlas', newKp.publicKeyBase64, 'atlas');

    // BMO checks contacts
    const contacts = listContacts(db, 'bmo');
    const atlasContact = contacts.find(c => c.agent === 'atlas');
    assert.ok(atlasContact, 'atlas should be in contacts');
    assert.equal(atlasContact.publicKey, newKp.publicKeyBase64);
    assert.ok(atlasContact.keyUpdatedAt, 'key_updated_at should be set');
    assert.equal(atlasContact.recoveryInProgress, false);

    db.close();
  });

  // Additional: cannot rotate to a key already used by another agent
  it('rejects rotation to duplicate public key', () => {
    const db = withDb();
    const atlas = registerWithEmail(db, 'atlas', 'atlas@example.com');
    const bmo = registerWithEmail(db, 'bmo', 'bmo@example.com');

    const result = rotateKey(db, 'atlas', bmo.publicKeyBase64, 'atlas');
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);

    db.close();
  });

  // Additional: cannot rotate another agent's key
  it('rejects rotating another agent\'s key', () => {
    const db = withDb();
    registerWithEmail(db, 'atlas', 'atlas@example.com');
    registerWithEmail(db, 'bmo', 'bmo@example.com');
    const newKp = genKeypair();

    const result = rotateKey(db, 'atlas', newKp.publicKeyBase64, 'bmo');
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);

    db.close();
  });
});

// ================================================================
// t-107: Key recovery with cooling-off period
// ================================================================

describe('t-107: Key recovery with cooling-off period', () => {
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

  // Step 1: POST /recover with verified email and new public key → 202
  it('step 1: initiate recovery with verified email → 202', () => {
    const db = withDb();
    registerWithEmail(db, 'atlas', 'atlas@example.com');
    const newKp = genKeypair();

    const result = recoverKey(db, 'atlas', 'atlas@example.com', newKp.publicKeyBase64);
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);

    // Verify recovery_initiated_at is set
    const row = db.prepare(
      'SELECT recovery_initiated_at, pending_public_key FROM agents WHERE name = ?'
    ).get('atlas') as any;
    assert.ok(row.recovery_initiated_at, 'recovery_initiated_at should be set');
    assert.equal(row.pending_public_key, newKp.publicKeyBase64);

    db.close();
  });

  // Step 2: Immediately POST rotate-key with the recovery key → 403
  it('step 2: rotate-key during cooling-off rejected with 403', () => {
    const db = withDb();
    registerWithEmail(db, 'atlas', 'atlas@example.com');
    const newKp = genKeypair();

    recoverKey(db, 'atlas', 'atlas@example.com', newKp.publicKeyBase64);

    // Try to activate immediately — should fail
    const result = rotateKey(db, 'atlas', newKp.publicKeyBase64, null);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error!, /cooling.off/i);

    db.close();
  });

  // Step 3: Advance clock by 1 hour, then rotate-key → 200
  it('step 3: rotate-key succeeds after cooling-off period', () => {
    const db = withDb();
    registerWithEmail(db, 'atlas', 'atlas@example.com');
    const newKp = genKeypair();

    // Initiate recovery with a timestamp 1 hour + 1 second ago
    const pastTime = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE agents SET pending_public_key = ?, recovery_initiated_at = ? WHERE name = ?`
    ).run(newKp.publicKeyBase64, pastTime, 'atlas');

    // Now rotate-key should succeed (cooling-off elapsed)
    const result = rotateKey(db, 'atlas', newKp.publicKeyBase64, null);
    assert.equal(result.ok, true);

    // Verify key is updated
    const agent = lookupAgent(db, 'atlas');
    assert.ok(agent);
    assert.equal(agent.publicKey, newKp.publicKeyBase64);

    // Verify recovery fields cleared
    const row = db.prepare(
      'SELECT recovery_initiated_at, pending_public_key FROM agents WHERE name = ?'
    ).get('atlas') as any;
    assert.equal(row.recovery_initiated_at, null);
    assert.equal(row.pending_public_key, null);

    db.close();
  });

  // Step 4: GET /contacts during cooling-off shows recovery_in_progress
  it('step 4: contacts show recovery_in_progress during cooling-off', () => {
    const db = withDb();
    const atlas = registerWithEmail(db, 'atlas', 'atlas@example.com');
    const bmo = registerWithEmail(db, 'bmo', 'bmo@example.com');
    const newKp = genKeypair();

    // Establish contact
    requestContact(db, 'bmo', 'atlas');
    acceptContact(db, 'atlas', 'bmo');

    // Initiate recovery (just now — cooling-off active)
    recoverKey(db, 'atlas', 'atlas@example.com', newKp.publicKeyBase64);

    // BMO checks contacts
    const contacts = listContacts(db, 'bmo');
    const atlasContact = contacts.find(c => c.agent === 'atlas');
    assert.ok(atlasContact, 'atlas should be in contacts');
    assert.equal(atlasContact.recoveryInProgress, true);

    db.close();
  });

  // Additional: recovery with wrong email fails
  it('rejects recovery with wrong email', () => {
    const db = withDb();
    registerWithEmail(db, 'atlas', 'atlas@example.com');
    const newKp = genKeypair();

    const result = recoverKey(db, 'atlas', 'wrong@example.com', newKp.publicKeyBase64);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);

    db.close();
  });

  // Additional: recovery with unverified email fails
  it('rejects recovery with unverified email', () => {
    const db = withDb();
    const kp = genKeypair();

    // Manually insert agent without email verification
    db.prepare(
      "INSERT INTO agents (name, public_key, owner_email, status) VALUES (?, ?, ?, 'active')"
    ).run('manual', kp.publicKeyBase64, 'manual@example.com');
    const newKp = genKeypair();

    const result = recoverKey(db, 'manual', 'manual@example.com', newKp.publicKeyBase64);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);

    db.close();
  });

  // Additional: recovery_in_progress clears after cooling-off
  it('recovery_in_progress is false after cooling-off elapsed', () => {
    const db = withDb();
    const atlas = registerWithEmail(db, 'atlas', 'atlas@example.com');
    const bmo = registerWithEmail(db, 'bmo', 'bmo@example.com');
    const newKp = genKeypair();

    // Establish contact
    requestContact(db, 'bmo', 'atlas');
    acceptContact(db, 'atlas', 'bmo');

    // Set recovery_initiated_at to > 1 hour ago (cooling-off expired)
    const pastTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE agents SET pending_public_key = ?, recovery_initiated_at = ? WHERE name = ?`
    ).run(newKp.publicKeyBase64, pastTime, 'atlas');

    const contacts = listContacts(db, 'bmo');
    const atlasContact = contacts.find(c => c.agent === 'atlas');
    assert.ok(atlasContact);
    assert.equal(atlasContact.recoveryInProgress, false);

    db.close();
  });

  // Additional: rotate-key with wrong pending key fails after cooling-off
  it('rejects rotate-key with mismatched pending key', () => {
    const db = withDb();
    registerWithEmail(db, 'atlas', 'atlas@example.com');
    const newKp = genKeypair();
    const wrongKp = genKeypair();

    // Set up expired recovery
    const pastTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE agents SET pending_public_key = ?, recovery_initiated_at = ? WHERE name = ?`
    ).run(newKp.publicKeyBase64, pastTime, 'atlas');

    // Try with wrong key
    const result = rotateKey(db, 'atlas', wrongKp.publicKeyBase64, null);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);

    db.close();
  });
});
