/**
 * Tests for v1 compatibility routes (t-066).
 *
 * t-066: v1 compat: v1 send/poll works, deprecation headers present
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import {
  v1Send,
  v1Inbox,
  v1Ack,
  isSunset,
  type V1SendParams,
  type DeprecationLogger,
} from '../routes/v1-compat.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-v1compat-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return { publicKeyBase64: Buffer.from(pubDer).toString('base64') };
}

function createActiveAgent(db: ReturnType<typeof initializeDatabase>, name: string, publicKeyBase64: string) {
  db.prepare(
    "INSERT INTO agents (name, public_key, email_verified, status, approved_by) VALUES (?, ?, 1, 'active', 'test-admin')"
  ).run(name, publicKeyBase64);
}

/** Sunset date 30 days from now (not sunset). */
function futureSunset(now: number): Date {
  return new Date(now + 30 * 24 * 60 * 60 * 1000);
}

/** Sunset date in the past (already sunset). */
function pastSunset(now: number): Date {
  return new Date(now - 1000);
}

/** Collects deprecation log calls. */
function createLogCollector(): { logs: string[]; logger: DeprecationLogger } {
  const logs: string[] = [];
  return {
    logs,
    logger: (route, agent) => logs.push(`${route} by ${agent}`),
  };
}

// ================================================================
// t-066: v1 compat: send/poll works, deprecation present, sunset → 410
// ================================================================

describe('t-066: v1 compat: v1 send/poll works, deprecation headers present', () => {
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

  // Step 1: Start v2 relay with v1-compat routes enabled (implicit — we test functions directly)
  it('step 1: v1 compat functions available', () => {
    assert.equal(typeof v1Send, 'function');
    assert.equal(typeof v1Inbox, 'function');
    assert.equal(typeof v1Ack, 'function');
    assert.equal(typeof isSunset, 'function');
  });

  // Step 2: POST /relay/send with v1-format signed message → 200
  it('step 2: v1Send stores message successfully', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      text: 'Hello from v1!',
      messageId: randomUUID(),
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'mock-v1-signature',
    };

    const result = v1Send(db, params, 'alice', futureSunset(now), now);
    assert.equal(result.ok, true);
    assert.equal(result.deprecated, true);

    db.close();
  });

  // Step 3: Verify deprecated flag is present
  it('step 3: all v1 responses have deprecated: true', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      text: 'test',
      messageId: randomUUID(),
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    const sendResult = v1Send(db, params, 'alice', futureSunset(now), now);
    assert.equal(sendResult.deprecated, true);

    const inboxResult = v1Inbox(db, 'bob', futureSunset(now), now);
    assert.equal(inboxResult.deprecated, true);

    db.close();
  });

  // Step 4: GET /relay/inbox/:agent returns stored message with deprecated flag
  it('step 4: v1Inbox returns stored message with deprecated flag', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const msgId = randomUUID();
    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      text: 'Hello from v1!',
      messageId: msgId,
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    v1Send(db, params, 'alice', futureSunset(now), now);

    const result = v1Inbox(db, 'bob', futureSunset(now), now);
    assert.equal(result.ok, true);
    assert.equal(result.deprecated, true);

    const messages = result.data as Array<{ id: string; from: string; text: string }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.from, 'alice');
    assert.equal(messages[0]!.text, 'Hello from v1!');

    db.close();
  });

  // Step 5: POST /relay/inbox/:agent/ack → message removed, deprecated flag
  it('step 5: v1Ack removes messages with deprecated flag', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const msgId = randomUUID();
    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      text: 'Hello',
      messageId: msgId,
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    v1Send(db, params, 'alice', futureSunset(now), now);

    const ackResult = v1Ack(db, 'bob', [msgId], futureSunset(now), now);
    assert.equal(ackResult.ok, true);
    assert.equal(ackResult.deprecated, true);
    assert.deepEqual(ackResult.data, { deleted: 1 });

    // Verify inbox is empty
    const inbox = v1Inbox(db, 'bob', futureSunset(now), now);
    assert.deepEqual(inbox.data, []);

    db.close();
  });

  // Step 6: Verify deprecation warnings logged
  it('step 6: deprecation warnings logged for each v1 call', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const { logs, logger } = createLogCollector();

    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      text: 'test',
      messageId: randomUUID(),
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    v1Send(db, params, 'alice', futureSunset(now), now, logger);
    v1Inbox(db, 'bob', futureSunset(now), now, logger);
    v1Ack(db, 'bob', [params.messageId], futureSunset(now), now, logger);

    assert.equal(logs.length, 3);
    assert.ok(logs[0]!.includes('POST /relay/send'));
    assert.ok(logs[1]!.includes('GET /relay/inbox'));
    assert.ok(logs[2]!.includes('POST /relay/inbox/ack'));

    db.close();
  });

  // Step 7-8: Simulate post-sunset → 410 Gone
  it('steps 7-8: post-sunset returns 410 Gone', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const sunset = pastSunset(now);

    assert.equal(isSunset(sunset, now), true);

    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      messageId: randomUUID(),
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    const sendResult = v1Send(db, params, 'alice', sunset, now);
    assert.equal(sendResult.ok, false);
    assert.equal(sendResult.status, 410);
    assert.match(sendResult.error!, /sunset/i);

    const inboxResult = v1Inbox(db, 'bob', sunset, now);
    assert.equal(inboxResult.ok, false);
    assert.equal(inboxResult.status, 410);

    const ackResult = v1Ack(db, 'bob', ['fake-id'], sunset, now);
    assert.equal(ackResult.ok, false);
    assert.equal(ackResult.status, 410);

    db.close();
  });

  // Step 9: Dual-stack test — v1 send + v1 poll, no duplicates
  it('step 9: v1 send + poll produces exactly one message (no duplicates)', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const msgId = randomUUID();
    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      text: 'Dual stack test',
      messageId: msgId,
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    v1Send(db, params, 'alice', futureSunset(now), now);

    // Poll twice — should get same message both times (until ack)
    const inbox1 = v1Inbox(db, 'bob', futureSunset(now), now);
    const inbox2 = v1Inbox(db, 'bob', futureSunset(now), now);
    const msgs1 = inbox1.data as Array<{ id: string }>;
    const msgs2 = inbox2.data as Array<{ id: string }>;
    assert.equal(msgs1.length, 1);
    assert.equal(msgs2.length, 1);
    assert.equal(msgs1[0]!.id, msgId);

    // Ack once
    v1Ack(db, 'bob', [msgId], futureSunset(now), now);

    // Now inbox is empty
    const inbox3 = v1Inbox(db, 'bob', futureSunset(now), now);
    assert.deepEqual(inbox3.data, []);

    db.close();
  });
});

// ================================================================
// Additional v1 compat coverage
// ================================================================

describe('v1 compat: edge cases', () => {
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

  it('replay protection: duplicate nonce rejected', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const nonce = randomUUID();
    const params: V1SendParams = {
      from: 'alice',
      to: 'bob',
      type: 'text',
      messageId: randomUUID(),
      nonce,
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    v1Send(db, params, 'alice', futureSunset(now), now);

    const params2: V1SendParams = { ...params, messageId: randomUUID() };
    const result = v1Send(db, params2, 'alice', futureSunset(now), now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.match(result.error!, /replay/i);

    db.close();
  });

  it('from mismatch rejected', () => {
    const db = withDb();
    const sender = genKeypair();
    const recipient = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);
    createActiveAgent(db, 'bob', recipient.publicKeyBase64);

    const now = Date.now();
    const params: V1SendParams = {
      from: 'bob',
      to: 'bob',
      type: 'text',
      messageId: randomUUID(),
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    const result = v1Send(db, params, 'alice', futureSunset(now), now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);

    db.close();
  });

  it('unknown recipient rejected', () => {
    const db = withDb();
    const sender = genKeypair();
    createActiveAgent(db, 'alice', sender.publicKeyBase64);

    const now = Date.now();
    const params: V1SendParams = {
      from: 'alice',
      to: 'ghost',
      type: 'text',
      messageId: randomUUID(),
      nonce: randomUUID(),
      timestamp: new Date(now).toISOString(),
      signature: 'sig',
    };

    const result = v1Send(db, params, 'alice', futureSunset(now), now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);

    db.close();
  });

  it('empty messageIds in ack rejected', () => {
    const db = withDb();
    const now = Date.now();
    const result = v1Ack(db, 'bob', [], futureSunset(now), now);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    db.close();
  });

  it('isSunset returns false before date', () => {
    const future = new Date(Date.now() + 1000000);
    assert.equal(isSunset(future), false);
  });

  it('isSunset returns true after date', () => {
    const past = new Date(Date.now() - 1000);
    assert.equal(isSunset(past), true);
  });
});
