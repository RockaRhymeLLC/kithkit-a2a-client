/**
 * Tests for P2P encrypted messaging (t-063, t-064).
 *
 * t-063: SDK E2E: send encrypted message, receive + verify + decrypt
 * t-064: SDK presence-gated: offline → queued → retry → delivered
 *
 * Uses MockRelayAPI + injectable deliverFn for full integration without HTTP.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CC4MeNetwork, type CC4MeNetworkInternalOptions } from '../client.js';
import type { IRelayAPI, RelayContact, RelayPendingRequest, RelayPresence, RelayResponse } from '../relay-api.js';
import type { WireEnvelope, Message, DeliveryStatus } from '../types.js';

// Import relay functions directly for the mock
import { initializeDatabase } from '../../../relay/src/db.js';
import {
  requestContact as relayRequestContact,
  acceptContact as relayAcceptContact,
  listContacts as relayListContacts,
  listPendingRequests as relayPendingRequests,
} from '../../../relay/src/routes/contacts.js';
import {
  updatePresence as relayUpdatePresence,
  getPresence as relayGetPresence,
  batchPresence as relayBatchPresence,
} from '../../../relay/src/routes/presence.js';

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
    privateKeyDer: kp.privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

function createActiveAgent(db: ReturnType<typeof initializeDatabase>, name: string, publicKeyBase64: string, endpoint?: string) {
  db.prepare(
    "INSERT INTO agents (name, public_key, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'test-admin', datetime('now'))"
  ).run(name, publicKeyBase64, endpoint || null);
}

/**
 * Mock relay API backed by real DB functions.
 * Can be toggled "offline" (relay unreachable) or "agent offline" (presence stale).
 */
class MockRelayAPI implements IRelayAPI {
  public offline = false;
  public heartbeatCalls: Array<{ agent: string; endpoint: string }> = [];

  constructor(
    private db: ReturnType<typeof initializeDatabase>,
    private agentName: string,
  ) {}

  private checkOnline(): void {
    if (this.offline) throw new Error('Relay unreachable');
  }

  async requestContact(toAgent: string, greeting?: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayRequestContact(this.db, this.agentName, toAgent, greeting);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async acceptContact(agent: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayAcceptContact(this.db, this.agentName, agent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async denyContact(): Promise<RelayResponse> {
    this.checkOnline();
    return { ok: true, status: 200 };
  }

  async removeContact(): Promise<RelayResponse> {
    this.checkOnline();
    return { ok: true, status: 200 };
  }

  async getContacts(): Promise<RelayResponse<RelayContact[]>> {
    this.checkOnline();
    const contacts = relayListContacts(this.db, this.agentName);
    return { ok: true, status: 200, data: contacts };
  }

  async getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>> {
    this.checkOnline();
    const pending = relayPendingRequests(this.db, this.agentName);
    return { ok: true, status: 200, data: pending };
  }

  async heartbeat(endpoint: string): Promise<RelayResponse> {
    this.checkOnline();
    this.heartbeatCalls.push({ agent: this.agentName, endpoint });
    const result = relayUpdatePresence(this.db, this.agentName, endpoint);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async getPresence(agent: string): Promise<RelayResponse<RelayPresence>> {
    this.checkOnline();
    const presence = relayGetPresence(this.db, agent);
    if (!presence) {
      return { ok: false, status: 404, error: 'Agent not found' };
    }
    return { ok: true, status: 200, data: presence };
  }

  async batchPresence(agents: string[]): Promise<RelayResponse<RelayPresence[]>> {
    this.checkOnline();
    const batch = relayBatchPresence(this.db, agents);
    return { ok: true, status: 200, data: batch };
  }
}

interface TestEnv {
  db: ReturnType<typeof initializeDatabase>;
  dir: string;
  aliceKeys: ReturnType<typeof genKeypair>;
  bobKeys: ReturnType<typeof genKeypair>;
  aliceRelay: MockRelayAPI;
  bobRelay: MockRelayAPI;
  /** Envelopes delivered via deliverFn (for inspection) */
  deliveredEnvelopes: WireEnvelope[];
}

function setupTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-messaging-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);

  const aliceKeys = genKeypair();
  const bobKeys = genKeypair();

  createActiveAgent(db, 'alice', aliceKeys.publicKeyBase64, 'https://alice.example.com/inbox');
  createActiveAgent(db, 'bob', bobKeys.publicKeyBase64, 'https://bob.example.com/inbox');

  const aliceRelay = new MockRelayAPI(db, 'alice');
  const bobRelay = new MockRelayAPI(db, 'bob');

  return { db, dir, aliceKeys, bobKeys, aliceRelay, bobRelay, deliveredEnvelopes: [] };
}

/**
 * Create a delivery function that captures envelopes and optionally delivers to a recipient.
 * When `recipientNetwork` is provided, it calls receiveMessage on delivery.
 * When `shouldFail` is true, delivery always fails (simulating offline endpoint).
 */
function createDeliverFn(env: TestEnv, recipientNetwork?: CC4MeNetwork, shouldFail = false) {
  return async (_endpoint: string, envelope: WireEnvelope): Promise<boolean> => {
    env.deliveredEnvelopes.push(envelope);
    if (shouldFail) return false;
    if (recipientNetwork) {
      try {
        recipientNetwork.receiveMessage(envelope);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  };
}

function createNetworkClient(
  env: TestEnv,
  agent: 'alice' | 'bob',
  deliverFn?: (endpoint: string, envelope: WireEnvelope) => Promise<boolean>,
  retryDelays?: number[],
  retryProcessInterval?: number,
): CC4MeNetwork {
  const keys = agent === 'alice' ? env.aliceKeys : env.bobKeys;
  const relay = agent === 'alice' ? env.aliceRelay : env.bobRelay;
  const dataDir = join(env.dir, `${agent}-data`);

  return new CC4MeNetwork({
    relayUrl: 'http://localhost:0',
    username: agent,
    privateKey: Buffer.from(keys.privateKeyDer),
    endpoint: `https://${agent}.example.com/inbox`,
    dataDir,
    heartbeatInterval: 60_000,
    relayAPI: relay,
    deliverFn,
    retryDelays,
    retryProcessInterval,
  } as CC4MeNetworkInternalOptions);
}

/** Establish mutual contacts between Alice and Bob. */
async function establishContacts(alice: CC4MeNetwork, bob: CC4MeNetwork) {
  await alice.requestContact('bob');
  await bob.acceptContact('alice');
  // Refresh caches so both sides have each other's public keys
  await alice.getContacts();
  await bob.getContacts();
}

/** Wait for a specific number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================================================================
// t-063: SDK E2E: send encrypted message, receive + verify + decrypt
// ================================================================

describe('t-063: SDK E2E: send encrypted, receive + verify + decrypt', () => {
  let cleanups: Array<{ dir: string; networks: CC4MeNetwork[] }> = [];

  afterEach(async () => {
    for (const { networks, dir } of cleanups) {
      for (const n of networks) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    cleanups = [];
  });

  function track(env: TestEnv, ...networks: CC4MeNetwork[]) {
    cleanups.push({ dir: env.dir, networks });
  }

  // Steps 1-2: Create instances, establish contacts
  it('steps 1-2: create instances, register, establish mutual contacts', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    const aliceContacts = await alice.getContacts();
    const bobContacts = await bob.getContacts();
    assert.equal(aliceContacts.length, 1);
    assert.equal(bobContacts.length, 1);
    assert.equal(aliceContacts[0]!.username, 'bob');
    assert.equal(bobContacts[0]!.username, 'alice');
  });

  // Steps 3-6: Alice sends, Bob receives and decrypts
  it('steps 3-6: send encrypted message, Bob receives, verifies, decrypts', async () => {
    const env = setupTestEnv();

    // Create Bob first so we can pass him to Alice's deliverFn
    const bob = createNetworkClient(env, 'bob');
    const alice = createNetworkClient(env, 'alice', createDeliverFn(env, bob));
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    // Collect Bob's received messages
    const bobMessages: Message[] = [];
    bob.on('message', (msg) => bobMessages.push(msg));

    // Step 3: Alice sends
    const result = await alice.send('bob', { text: 'Hello Bob!' });
    assert.equal(result.status, 'delivered');
    assert.ok(result.messageId);

    // Step 4: Verify envelope has ciphertext, not plaintext
    assert.equal(env.deliveredEnvelopes.length, 1);
    const envelope = env.deliveredEnvelopes[0]!;
    assert.ok(envelope.payload.ciphertext, 'Envelope should have ciphertext');
    assert.ok(envelope.payload.nonce, 'Envelope should have nonce');
    // The plaintext "Hello Bob!" should NOT appear in the envelope
    const envelopeJson = JSON.stringify(envelope);
    assert.ok(!envelopeJson.includes('Hello Bob!'), 'Plaintext should not be in envelope');

    // Step 5: Verify Bob's message event fired
    assert.equal(bobMessages.length, 1);
    assert.equal(bobMessages[0]!.sender, 'alice');
    assert.equal(bobMessages[0]!.verified, true);

    // Step 6: Verify Bob can read the decrypted payload
    assert.deepEqual(bobMessages[0]!.payload, { text: 'Hello Bob!' });
  });

  // Step 7: Attempt to send message to a non-contact
  it('step 7: send to non-contact is rejected before sending', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice', createDeliverFn(env));
    track(env, alice);

    await alice.start();

    // Try sending to "charlie" who is not a contact
    const result = await alice.send('charlie', { text: 'Hey Charlie!' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Not a contact');

    // No delivery attempts were made
    assert.equal(env.deliveredEnvelopes.length, 0);
  });

  // Step 8: Verify relay received zero message content
  it('step 8: relay has zero message content (only contacts/presence calls)', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');
    const alice = createNetworkClient(env, 'alice', createDeliverFn(env, bob));
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    await alice.send('bob', { text: 'Secret message!' });

    // The relay DB's messages table should be empty (no content stored on relay)
    const relayMessages = env.db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    assert.equal(relayMessages.count, 0, 'Relay should have zero message content');
  });

  // Additional: bidirectional messaging
  it('bidirectional: Bob can reply to Alice', async () => {
    const env = setupTestEnv();

    // Use closure pattern so delivery functions reference the final instances
    let alice: CC4MeNetwork;
    let bob: CC4MeNetwork;

    const aliceDeliverFn = async (_ep: string, envelope: WireEnvelope) => {
      try { bob.receiveMessage(envelope); return true; } catch { return false; }
    };
    const bobDeliverFn = async (_ep: string, envelope: WireEnvelope) => {
      try { alice.receiveMessage(envelope); return true; } catch { return false; }
    };

    alice = createNetworkClient(env, 'alice', aliceDeliverFn);
    bob = createNetworkClient(env, 'bob', bobDeliverFn);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    const aliceMessages: Message[] = [];
    const bobMessages: Message[] = [];
    alice.on('message', (msg) => aliceMessages.push(msg));
    bob.on('message', (msg) => bobMessages.push(msg));

    // Alice → Bob
    const r1 = await alice.send('bob', { text: 'Hello Bob!' });
    assert.equal(r1.status, 'delivered');
    assert.equal(bobMessages.length, 1);
    assert.deepEqual(bobMessages[0]!.payload, { text: 'Hello Bob!' });

    // Bob → Alice
    const r2 = await bob.send('alice', { text: 'Hi Alice!' });
    assert.equal(r2.status, 'delivered');
    assert.equal(aliceMessages.length, 1);
    assert.deepEqual(aliceMessages[0]!.payload, { text: 'Hi Alice!' });
  });

  // Additional: incoming message from non-contact is rejected
  it('incoming message from non-contact rejected with error', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');
    track(env, bob);

    await bob.start();

    // Build a fake envelope from an unknown sender
    const charlieKeys = genKeypair();
    const { buildEnvelope: build } = await import('../messaging.js');
    const { createPrivateKey } = await import('node:crypto');
    const charliePriv = createPrivateKey({
      key: Buffer.from(charlieKeys.privateKeyDer),
      format: 'der',
      type: 'pkcs8',
    });

    // Charlie needs Bob's public key to encrypt — use a fake one
    // (This will fail at decryption anyway, but we're testing the contact check)
    const fakeEnvelope: WireEnvelope = {
      version: '2.0',
      type: 'direct',
      messageId: 'test-123',
      sender: 'charlie',
      recipient: 'bob',
      timestamp: new Date().toISOString(),
      payload: { ciphertext: 'fake', nonce: 'fake' },
      signature: 'fake',
    };

    assert.throws(() => bob.receiveMessage(fakeEnvelope), /not a contact/i);
  });

  // Additional: message with invalid signature is rejected
  it('message with tampered signature is rejected', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');

    // Build a valid envelope from Alice, but tamper with the signature
    let capturedEnvelope: WireEnvelope | null = null;
    const captureFn = async (_ep: string, envelope: WireEnvelope) => {
      capturedEnvelope = envelope;
      return true; // Don't actually deliver
    };
    const alice = createNetworkClient(env, 'alice', captureFn);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    await alice.send('bob', { text: 'Tamper me!' });
    assert.ok(capturedEnvelope);

    // Tamper with the signature
    const tampered = { ...capturedEnvelope! };
    tampered.signature = Buffer.from('invalid-signature-data').toString('base64');

    assert.throws(() => bob.receiveMessage(tampered), /Invalid signature/i);
  });

  // Additional: message with old timestamp is rejected
  it('message with timestamp > 5 min from local clock is rejected', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');

    let capturedEnvelope: WireEnvelope | null = null;
    const captureFn = async (_ep: string, envelope: WireEnvelope) => {
      capturedEnvelope = envelope;
      return true;
    };
    const alice = createNetworkClient(env, 'alice', captureFn);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    await alice.send('bob', { text: 'Old message' });
    assert.ok(capturedEnvelope);

    // Manually modify the envelope's timestamp to 10 minutes ago
    // This breaks the signature too, so we need to test processEnvelope directly
    const { processEnvelope } = await import('../messaging.js');
    const { createPrivateKey } = await import('node:crypto');
    const bobPriv = createPrivateKey({
      key: Buffer.from(env.bobKeys.privateKeyDer),
      format: 'der',
      type: 'pkcs8',
    });

    // Use a `now` that's 10 minutes ahead of the envelope's timestamp
    const envelopeTime = new Date(capturedEnvelope!.timestamp).getTime();
    const futureNow = envelopeTime + 10 * 60 * 1000;

    assert.throws(
      () => processEnvelope({
        envelope: capturedEnvelope!,
        recipientPrivateKey: bobPriv,
        senderPublicKeyBase64: env.aliceKeys.publicKeyBase64,
        now: futureNow,
      }),
      /timestamp too far/i,
    );
  });
});

// ================================================================
// t-064: SDK presence-gated: offline → queued → retry → delivered
// ================================================================

describe('t-064: SDK presence-gated: offline → queued → retry → delivered', () => {
  let cleanups: Array<{ dir: string; networks: CC4MeNetwork[] }> = [];

  afterEach(async () => {
    for (const { networks, dir } of cleanups) {
      for (const n of networks) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    cleanups = [];
  });

  function track(env: TestEnv, ...networks: CC4MeNetwork[]) {
    cleanups.push({ dir: env.dir, networks });
  }

  // Steps 1-4: Bob offline, message queued, delivery-status pending
  it('steps 1-4: Bob offline → send returns queued, delivery-status pending', async () => {
    const env = setupTestEnv();

    const bob = createNetworkClient(env, 'bob');
    const alice = createNetworkClient(env, 'alice', createDeliverFn(env, bob), [100, 200, 300], 50);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    // Step 2: Stop Bob (make presence stale by manipulating DB)
    await bob.stop();
    // Set Bob's last_seen to 30 minutes ago (well past the 2x heartbeat offline threshold)
    // Use ISO timestamp with Z suffix so JS Date parses as UTC correctly
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    env.db.prepare("UPDATE agents SET last_seen = ? WHERE name = 'bob'").run(thirtyMinAgo);

    // Collect delivery-status events
    const statuses: DeliveryStatus[] = [];
    alice.on('delivery-status', (s) => statuses.push(s));

    // Step 3: Alice sends — should return 'queued'
    const result = await alice.send('bob', { text: 'Are you there?' });
    assert.equal(result.status, 'queued');
    assert.ok(result.messageId);

    // Step 4: delivery-status event with 'pending'
    assert.ok(statuses.length >= 1);
    assert.equal(statuses[0]!.status, 'pending');
    assert.equal(statuses[0]!.messageId, result.messageId);
  });

  // Steps 5-9: Full retry flow — offline → retry fails → online → retry delivers
  it('steps 5-9: retry fails while offline, then delivers after Bob comes back', async () => {
    const env = setupTestEnv();

    // Track delivery attempts
    let bobNetwork: CC4MeNetwork | null = null;
    const deliverFn = async (_endpoint: string, envelope: WireEnvelope): Promise<boolean> => {
      env.deliveredEnvelopes.push(envelope);
      if (!bobNetwork) return false; // Bob offline
      try {
        bobNetwork.receiveMessage(envelope);
        return true;
      } catch {
        return false;
      }
    };

    const bob = createNetworkClient(env, 'bob');
    const alice = createNetworkClient(env, 'alice', deliverFn, [100, 200, 300], 50);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    // Make Bob offline
    await bob.stop();
    // Use ISO timestamp with Z suffix so JS Date parses as UTC correctly
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    env.db.prepare("UPDATE agents SET last_seen = ? WHERE name = 'bob'").run(thirtyMinAgo);

    const statuses: DeliveryStatus[] = [];
    alice.on('delivery-status', (s) => statuses.push(s));

    const bobMessages: Message[] = [];
    bob.on('message', (msg) => bobMessages.push(msg));

    // Alice sends — queued
    const result = await alice.send('bob', { text: 'Are you there?' });
    assert.equal(result.status, 'queued');

    // Step 5: Wait for first retry — Bob still offline
    await sleep(200);

    // Should have at least one retry attempt (sending then back to pending)
    const sendingEvents = statuses.filter((s) => s.status === 'sending');
    assert.ok(sendingEvents.length >= 1, 'Should have at least one sending attempt');

    // Step 6: Bring Bob back online
    await bob.start(); // This sends a heartbeat, updating last_seen
    bobNetwork = bob; // Enable delivery

    // Steps 7-8: Wait for next retry — should deliver
    await sleep(400);

    // Step 8: Verify Bob received the message
    assert.ok(bobMessages.length >= 1, 'Bob should have received the message');
    assert.deepEqual(bobMessages[0]!.payload, { text: 'Are you there?' });

    // Step 9: Verify Alice's delivery-status shows final 'delivered'
    const deliveredEvents = statuses.filter((s) => s.status === 'delivered');
    assert.ok(deliveredEvents.length >= 1, 'Should have delivered status');
    assert.equal(deliveredEvents[0]!.messageId, result.messageId);
  });

  // Additional: retry queue respects max size
  it('retry queue rejects when full', async () => {
    const env = setupTestEnv();

    // Create with max 1 message in retry queue
    const bob = createNetworkClient(env, 'bob');

    // Override retryQueueMax to 1
    const keys = env.aliceKeys;
    const dataDir = join(env.dir, 'alice-data');
    const alice = new CC4MeNetwork({
      relayUrl: 'http://localhost:0',
      username: 'alice',
      privateKey: Buffer.from(keys.privateKeyDer),
      endpoint: 'https://alice.example.com/inbox',
      dataDir,
      heartbeatInterval: 60_000,
      retryQueueMax: 1,
      relayAPI: env.aliceRelay,
      deliverFn: createDeliverFn(env, bob, true), // Always fail delivery
      retryDelays: [100000], // Very long retry so queue stays full
      retryProcessInterval: 100000,
    } as CC4MeNetworkInternalOptions);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);

    // First send — delivery fails, gets queued
    const r1 = await alice.send('bob', { text: 'First' });
    assert.equal(r1.status, 'queued');

    // Second send — queue full, fails
    const r2 = await alice.send('bob', { text: 'Second' });
    assert.equal(r2.status, 'failed');
    assert.ok(r2.error?.includes('queue full'));
  });

  // Additional: delivery-status events propagate from retry queue
  it('delivery-status events propagate through the client', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');
    const alice = createNetworkClient(env, 'alice', createDeliverFn(env, bob), [100, 200, 300], 50);
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await establishContacts(alice, bob);
    await bob.stop();
    // Use ISO timestamp with Z suffix so JS Date parses as UTC correctly
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    env.db.prepare("UPDATE agents SET last_seen = ? WHERE name = 'bob'").run(thirtyMinAgo);

    const statuses: DeliveryStatus[] = [];
    alice.on('delivery-status', (s) => statuses.push(s));

    await alice.send('bob', { text: 'Test' });

    // Should see 'pending' immediately from the enqueue
    assert.ok(statuses.length >= 1);
    assert.equal(statuses[0]!.status, 'pending');
  });
});
