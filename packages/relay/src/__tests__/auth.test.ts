/**
 * Tests for relay auth middleware (t-055).
 *
 * t-055: Ed25519 signature verification — valid/invalid/expired signatures,
 *        revoked agent, missing/malformed Authorization header.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import {
  authenticateRequest,
  buildSigningString,
  hashBody,
  parseAuthHeader,
} from '../auth.js';

/** Create a temp DB and return it + cleanup. */
function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-auth-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

/** Generate an Ed25519 keypair and return the base64-encoded SPKI public key. */
function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
  };
}

/** Create a properly signed Authorization header for a request. */
function signRequest(
  privateKey: ReturnType<typeof genKeypair>['privateKey'],
  agentName: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  const bodyHash = hashBody(body);
  const signingString = buildSigningString(method, path, timestamp, bodyHash);
  const sig = cryptoSign(null, Buffer.from(signingString), privateKey);
  return `Signature ${agentName}:${sig.toString('base64')}`;
}

describe('t-055: Relay auth middleware (valid/invalid/expired signatures)', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  function withSetup() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    const kp = genKeypair();
    return { db, kp, dir };
  }

  // Step 1: Register agent in database with public key
  it('step 1: registers agent with public key', () => {
    const { db, kp } = withSetup();

    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
    ).run('test-agent', kp.publicKeyBase64);

    const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get('test-agent') as any;
    assert.equal(agent.name, 'test-agent');
    assert.equal(agent.public_key, kp.publicKeyBase64);
    assert.equal(agent.status, 'active');
  });

  // Steps 2-3: Create properly signed request, auth passes
  it('steps 2-3: valid signed request passes authentication', () => {
    const { db, kp } = withSetup();

    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
    ).run('alice', kp.publicKeyBase64);

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const body = JSON.stringify({ text: 'hello' });
    const authHeader = signRequest(kp.privateKey, 'alice', 'POST', '/relay/send', timestamp, body);

    const result = authenticateRequest(db, 'POST', '/relay/send', timestamp, body, authHeader, now);
    assert.equal(result.ok, true);
    assert.equal(result.agent, 'alice');
  });

  // Step 4: Invalid signature (wrong key) → 401
  it('step 4: request with wrong key returns 401', () => {
    const { db, kp } = withSetup();
    const wrongKp = genKeypair(); // different keypair

    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
    ).run('alice', kp.publicKeyBase64); // registered with kp

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const body = '';
    // Sign with wrong key
    const authHeader = signRequest(wrongKp.privateKey, 'alice', 'GET', '/health', timestamp, body);

    const result = authenticateRequest(db, 'GET', '/health', timestamp, body, authHeader, now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error!, /Invalid signature/i);
  });

  // Step 5: Expired timestamp (>5 min old) → 401
  it('step 5: expired timestamp returns 401', () => {
    const { db, kp } = withSetup();

    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'active')"
    ).run('alice', kp.publicKeyBase64);

    const now = Date.now();
    // Timestamp is 10 minutes ago
    const oldTimestamp = new Date(now - 10 * 60 * 1000).toISOString();
    const body = '';
    const authHeader = signRequest(kp.privateKey, 'alice', 'GET', '/health', oldTimestamp, body);

    const result = authenticateRequest(db, 'GET', '/health', oldTimestamp, body, authHeader, now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error!, /Timestamp expired/i);
  });

  // Step 6: Revoked agent → 403
  it('step 6: revoked agent returns 403', () => {
    const { db, kp } = withSetup();

    db.prepare(
      "INSERT INTO agents (name, public_key, status) VALUES (?, ?, 'revoked')"
    ).run('alice', kp.publicKeyBase64);

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const body = '';
    const authHeader = signRequest(kp.privateKey, 'alice', 'GET', '/health', timestamp, body);

    const result = authenticateRequest(db, 'GET', '/health', timestamp, body, authHeader, now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error!, /revoked/i);
  });

  // Step 7: Missing Authorization header → 401
  it('step 7: missing Authorization header returns 401', () => {
    const { db } = withSetup();

    const result = authenticateRequest(db, 'GET', '/health', new Date().toISOString(), '', undefined);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error!, /Missing/i);
  });

  // Step 8: Malformed Authorization header → 401
  it('step 8: malformed Authorization header returns 401', () => {
    const { db } = withSetup();

    // Various malformed headers
    const malformed = [
      'Bearer abc123',            // wrong scheme
      'Signature ',               // no agent:sig
      'Signature alice',          // no colon
      'Signature :sig',           // no agent name
    ];

    for (const header of malformed) {
      const result = authenticateRequest(
        db, 'GET', '/health', new Date().toISOString(), '', header,
      );
      assert.equal(result.ok, false, `Should reject: "${header}"`);
      assert.equal(result.status, 401);
    }
  });
});

// ================================================================
// Additional auth coverage
// ================================================================

describe('Auth: parseAuthHeader edge cases', () => {
  it('parses valid header', () => {
    const result = parseAuthHeader('Signature my-agent:abc123==');
    assert.deepStrictEqual(result, { agent: 'my-agent', signature: 'abc123==' });
  });

  it('handles agent names with hyphens and underscores', () => {
    const result = parseAuthHeader('Signature my_agent-2:sig');
    assert.equal(result?.agent, 'my_agent-2');
  });

  it('handles signatures with base64 padding', () => {
    const result = parseAuthHeader('Signature agent:abc+def/ghi==');
    assert.equal(result?.signature, 'abc+def/ghi==');
  });

  it('handles colons in base64 signature', () => {
    // Base64 doesn't have colons, but test that we split on first colon only
    const result = parseAuthHeader('Signature agent:part1:part2');
    assert.equal(result?.agent, 'agent');
    assert.equal(result?.signature, 'part1:part2');
  });
});

describe('Auth: pending agent', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  it('pending agent returns 403', () => {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    const kp = genKeypair();

    // Status defaults to 'pending'
    db.prepare(
      'INSERT INTO agents (name, public_key) VALUES (?, ?)'
    ).run('newbie', kp.publicKeyBase64);

    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const authHeader = signRequest(kp.privateKey, 'newbie', 'GET', '/test', timestamp, '');

    const result = authenticateRequest(db, 'GET', '/test', timestamp, '', authHeader, now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.match(result.error!, /pending/i);

    db.close();
  });
});
