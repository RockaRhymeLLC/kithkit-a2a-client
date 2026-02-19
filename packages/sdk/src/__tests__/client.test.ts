/**
 * Tests for SDK client core (t-065).
 *
 * t-065: SDK local cache: contacts cached, works during relay outage
 *
 * Uses a MockRelayAPI backed by the real relay DB functions,
 * giving full integration coverage without HTTP.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CC4MeNetwork, type CC4MeNetworkInternalOptions } from '../client.js';
import { loadCache, getCachePath } from '../cache.js';
import type { IRelayAPI, RelayContact, RelayPendingRequest, RelayResponse } from '../relay-api.js';

// Import relay functions directly for the mock
import { initializeDatabase } from 'cc4me-relay/dist/db.js';
import {
  requestContact as relayRequestContact,
  listPendingRequests as relayPendingRequests,
  acceptContact as relayAcceptContact,
  denyContact as relayDenyContact,
  removeContact as relayRemoveContact,
  listContacts as relayListContacts,
} from 'cc4me-relay/dist/routes/contacts.js';
import {
  updatePresence as relayUpdatePresence,
} from 'cc4me-relay/dist/routes/presence.js';

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
 * Can be toggled "offline" to simulate relay outage.
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

  async requestContact(toAgent: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayRequestContact(this.db, this.agentName, toAgent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async acceptContact(agent: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayAcceptContact(this.db, this.agentName, agent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async denyContact(agent: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayDenyContact(this.db, this.agentName, agent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async removeContact(agent: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayRemoveContact(this.db, this.agentName, agent);
    return { ok: result.ok, status: result.status || 200, error: result.error };
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

  // Admin stubs — not tested in client.test.ts
  async createBroadcast(): Promise<RelayResponse<{ broadcastId: string }>> {
    return { ok: false, status: 403, error: 'Not admin' };
  }
  async listBroadcasts(): Promise<RelayResponse<import('../relay-api.js').RelayBroadcast[]>> {
    return { ok: true, status: 200, data: [] };
  }
  async revokeAgent(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not admin' };
  }
  async rotateKey(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not admin' };
  }
  async recoverKey(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not admin' };
  }

  // Group stubs — not tested in client.test.ts
  async createGroup(): Promise<RelayResponse<import('../relay-api.js').RelayGroup>> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async getGroup(): Promise<RelayResponse<import('../relay-api.js').RelayGroup>> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async inviteToGroup(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async acceptGroupInvitation(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async declineGroupInvitation(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async leaveGroup(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async removeMember(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async dissolveGroup(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async listGroups(): Promise<RelayResponse<import('../relay-api.js').RelayGroup[]>> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async getGroupMembers(): Promise<RelayResponse<import('../relay-api.js').RelayGroupMember[]>> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async getGroupInvitations(): Promise<RelayResponse<import('../relay-api.js').RelayGroupInvitation[]>> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async getGroupChanges(): Promise<RelayResponse<import('../relay-api.js').RelayGroupChange[]>> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async transferGroupOwnership(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
}

interface TestEnv {
  db: ReturnType<typeof initializeDatabase>;
  dir: string;
  aliceKeys: ReturnType<typeof genKeypair>;
  bobKeys: ReturnType<typeof genKeypair>;
  aliceRelay: MockRelayAPI;
  bobRelay: MockRelayAPI;
}

function setupTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-client-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);

  const aliceKeys = genKeypair();
  const bobKeys = genKeypair();

  createActiveAgent(db, 'alice', aliceKeys.publicKeyBase64, 'https://alice.example.com/inbox');
  createActiveAgent(db, 'bob', bobKeys.publicKeyBase64, 'https://bob.example.com/inbox');

  const aliceRelay = new MockRelayAPI(db, 'alice');
  const bobRelay = new MockRelayAPI(db, 'bob');

  return { db, dir, aliceKeys, bobKeys, aliceRelay, bobRelay };
}

function createNetworkClient(
  env: TestEnv,
  agent: 'alice' | 'bob',
  dataDirSuffix: string = '',
): CC4MeNetwork {
  const keys = agent === 'alice' ? env.aliceKeys : env.bobKeys;
  const relay = agent === 'alice' ? env.aliceRelay : env.bobRelay;
  const dataDir = join(env.dir, `${agent}-data${dataDirSuffix}`);

  return new CC4MeNetwork({
    relayUrl: 'http://localhost:0', // not used — mock relay
    username: agent,
    privateKey: Buffer.from(keys.privateKeyDer),
    endpoint: `https://${agent}.example.com/inbox`,
    dataDir,
    heartbeatInterval: 60_000, // Long interval — we call manually in tests
    relayAPI: relay,
  } as CC4MeNetworkInternalOptions);
}

// ================================================================
// t-065: SDK local cache tests
// ================================================================

describe('t-065: SDK local cache: contacts cached, works during relay outage', () => {
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

  // Step 1: Create Alice and Bob SDK instances, establish contacts, exchange messages
  it('step 1: create instances and establish contacts', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();

    assert.equal(alice.isStarted, true);
    assert.equal(bob.isStarted, true);

    // Request + accept contact
    await alice.requestContact('bob');
    const pending = await bob.getPendingRequests();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.from, 'alice');

    await bob.acceptContact('alice');

    // Both see each other
    const aliceContacts = await alice.getContacts();
    const bobContacts = await bob.getContacts();
    assert.equal(aliceContacts.length, 1);
    assert.equal(bobContacts.length, 1);
    assert.equal(aliceContacts[0]!.username, 'bob');
    assert.equal(bobContacts[0]!.username, 'alice');
  });

  // Step 2: Verify local cache file exists in Alice's dataDir
  it('step 2: cache file created with contacts data', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts(); // Triggers cache write

    const cachePath = getCachePath(join(env.dir, 'alice-data'));
    assert.equal(existsSync(cachePath), true);

    const cache = loadCache(cachePath);
    assert.ok(cache);
    assert.equal(cache.contacts.length, 1);
    assert.equal(cache.contacts[0]!.username, 'bob');
    assert.ok(cache.contacts[0]!.publicKey);
  });

  // Steps 3-5: Relay outage — Alice can still use cached contacts
  it('steps 3-5: relay offline, contacts available from cache', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts(); // Populate cache

    // Kill relay
    env.aliceRelay.offline = true;

    // Alice can still get contacts from cache
    const contacts = await alice.getContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]!.username, 'bob');
    assert.ok(contacts[0]!.publicKey);
  });

  // Step 6: checkPresence during outage returns cached data
  it('step 6: checkPresence during outage returns cached/offline', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts();

    // Kill relay
    env.aliceRelay.offline = true;

    const presence = await alice.checkPresence('bob');
    assert.equal(presence.agent, 'bob');
    // v3: returns last cached online status (was true when relay was up)
    assert.equal(typeof presence.online, 'boolean');
  });

  // Steps 7-8: Relay comes back, cache refreshed
  it('steps 7-8: relay recovers, cache refreshed from relay', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts();

    // Kill relay
    env.aliceRelay.offline = true;
    const cachedContacts = await alice.getContacts();
    assert.equal(cachedContacts.length, 1);

    // Bring relay back
    env.aliceRelay.offline = false;
    const freshContacts = await alice.getContacts();
    assert.equal(freshContacts.length, 1);
    assert.equal(freshContacts[0]!.username, 'bob');

    // Presence works again
    const presence = await alice.checkPresence('bob');
    assert.equal(presence.agent, 'bob');
  });

  // Step 9-10: Cache corruption triggers graceful regeneration
  it('steps 9-10: corrupt cache → graceful regeneration from relay', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts();
    await alice.stop();

    // Corrupt the cache file
    const cachePath = getCachePath(join(env.dir, 'alice-data'));
    writeFileSync(cachePath, '{corrupt json!!!');

    // Restart Alice — should regenerate from relay
    const alice2 = createNetworkClient(env, 'alice');
    track(env, alice2);

    await alice2.start();
    const contacts = await alice2.getContacts();
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]!.username, 'bob');

    // Cache file should be fixed now
    const cache = loadCache(cachePath);
    assert.ok(cache);
    assert.equal(cache.contacts.length, 1);
  });
});

// ================================================================
// Additional SDK client coverage
// ================================================================

describe('SDK client: lifecycle and contacts', () => {
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

  it('start sends initial heartbeat', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    track(env, alice);

    await alice.start();

    assert.equal(env.aliceRelay.heartbeatCalls.length, 1);
    assert.equal(env.aliceRelay.heartbeatCalls[0]!.endpoint, 'https://alice.example.com/inbox');
  });

  it('stop flushes cache to disk', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts();
    await alice.stop();

    const cachePath = getCachePath(join(env.dir, 'alice-data'));
    const cache = loadCache(cachePath);
    assert.ok(cache);
    assert.equal(cache.contacts.length, 1);
  });

  it('deny contact works', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.denyContact('alice');

    const pending = await bob.getPendingRequests();
    assert.equal(pending.length, 0);
  });

  it('remove contact works', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');

    await alice.removeContact('bob');
    const contacts = await alice.getContacts();
    assert.equal(contacts.length, 0);
  });

  it('getCachedContact returns contact from local cache', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();
    await alice.requestContact('bob');
    await bob.acceptContact('alice');
    await alice.getContacts();

    const cached = alice.getCachedContact('bob');
    assert.ok(cached);
    assert.equal(cached.username, 'bob');
    assert.ok(cached.publicKey);
  });

  it('checkPresence returns online when heartbeat is fresh', async () => {
    const env = setupTestEnv();
    const alice = createNetworkClient(env, 'alice');
    const bob = createNetworkClient(env, 'bob');
    track(env, alice, bob);

    await alice.start();
    await bob.start();

    // v3: presence is only available for contacts
    await alice.requestContact('bob');
    await bob.acceptContact('alice');

    const presence = await alice.checkPresence('bob');
    assert.equal(presence.agent, 'bob');
    assert.equal(presence.online, true);
  });

  it('empty cache file handled gracefully', async () => {
    const env = setupTestEnv();

    // Write empty cache
    const dataDir = join(env.dir, 'alice-data');
    const cachePath = getCachePath(dataDir);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath, '');

    const alice = createNetworkClient(env, 'alice');
    track(env, alice);

    // Should not crash, should regenerate
    await alice.start();
    assert.equal(alice.isStarted, true);
  });
});
