/**
 * Tests for SDK admin ops + delivery diagnostics (t-070).
 *
 * t-070: SDK admin ops + delivery diagnostics
 *
 * Tests admin broadcast, agent approval/revocation, delivery reports,
 * broadcast events, and contact-request events.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CC4MeNetwork, type CC4MeNetworkInternalOptions } from '../client.js';
import type {
  IRelayAPI,
  RelayContact,
  RelayPendingRequest,
  RelayBroadcast,
  RelayResponse,
} from '../relay-api.js';
import type { WireEnvelope, Broadcast, ContactRequest } from '../types.js';

// Import relay functions for the mock
import { initializeDatabase } from '../../../relay/src/db.js';
import {
  requestContact as relayRequestContact,
  acceptContact as relayAcceptContact,
  listContacts as relayListContacts,
  listPendingRequests as relayPendingRequests,
} from '../../../relay/src/routes/contacts.js';
import {
  updatePresence as relayUpdatePresence,
} from '../../../relay/src/routes/presence.js';
import {
  createBroadcast as relayCreateBroadcast,
  listBroadcasts as relayListBroadcasts,
} from '../../../relay/src/routes/admin.js';
import {
  approveAgent as relayApproveAgent,
  revokeAgent as relayRevokeAgent,
} from '../../../relay/src/routes/registry.js';

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey: kp.privateKey,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
    privateKeyDer: kp.privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

function createActiveAgent(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  publicKeyBase64: string,
  endpoint?: string,
) {
  db.prepare(
    "INSERT INTO agents (name, public_key, endpoint, email_verified, status, approved_by, approved_at) VALUES (?, ?, ?, 1, 'active', 'test-admin', datetime('now'))"
  ).run(name, publicKeyBase64, endpoint || null);
}

function createPendingAgent(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  publicKeyBase64: string,
) {
  db.prepare(
    "INSERT INTO agents (name, public_key, email_verified, status) VALUES (?, ?, 1, 'pending')"
  ).run(name, publicKeyBase64);
}

function seedAdmin(
  db: ReturnType<typeof initializeDatabase>,
  agentName: string,
  adminPublicKeyBase64: string,
) {
  db.prepare(
    'INSERT INTO admins (agent, admin_public_key) VALUES (?, ?)'
  ).run(agentName, adminPublicKeyBase64);
}

/**
 * Full MockRelayAPI with admin support.
 */
class MockRelayAPI implements IRelayAPI {
  public offline = false;

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
    const result = relayUpdatePresence(this.db, this.agentName, endpoint);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  async createBroadcast(type: string, payload: string, signature: string): Promise<RelayResponse<{ broadcastId: string }>> {
    this.checkOnline();
    const result = relayCreateBroadcast(this.db, this.agentName, type, payload, signature);
    if (!result.ok) return { ok: false, status: result.status || 400, error: result.error };
    return { ok: true, status: 201, data: { broadcastId: result.broadcastId! } };
  }

  async listBroadcasts(type?: string): Promise<RelayResponse<RelayBroadcast[]>> {
    this.checkOnline();
    const broadcasts = relayListBroadcasts(this.db, type);
    return { ok: true, status: 200, data: broadcasts };
  }

  async revokeAgent(agent: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayRevokeAgent(this.db, agent, this.agentName);
    if (!result.ok) return { ok: false, status: result.status || 400, error: result.error };
    return { ok: true, status: 200 };
  }

  // Group stubs — not tested in admin.test.ts
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
  async rotateKey(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
  async recoverKey(): Promise<RelayResponse> {
    return { ok: false, status: 403, error: 'Not implemented' };
  }
}

interface TestEnv {
  db: ReturnType<typeof initializeDatabase>;
  dir: string;
  adminKeys: ReturnType<typeof genKeypair>;
  bobKeys: ReturnType<typeof genKeypair>;
  adminRelay: MockRelayAPI;
  bobRelay: MockRelayAPI;
}

function setupTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-admin-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);

  const adminKeys = genKeypair();
  const bobKeys = genKeypair();

  // Create admin agent + admin entry
  createActiveAgent(db, 'admin-agent', adminKeys.publicKeyBase64, 'https://admin.example.com/inbox');
  seedAdmin(db, 'admin-agent', adminKeys.publicKeyBase64);

  // Create Bob
  createActiveAgent(db, 'bob', bobKeys.publicKeyBase64, 'https://bob.example.com/inbox');

  const adminRelay = new MockRelayAPI(db, 'admin-agent');
  const bobRelay = new MockRelayAPI(db, 'bob');

  return { db, dir, adminKeys, bobKeys, adminRelay, bobRelay };
}

function createNetworkClient(
  env: TestEnv,
  agent: 'admin-agent' | 'bob',
  deliverFn?: (endpoint: string, envelope: WireEnvelope) => Promise<boolean>,
): CC4MeNetwork {
  const keys = agent === 'admin-agent' ? env.adminKeys : env.bobKeys;
  const relay = agent === 'admin-agent' ? env.adminRelay : env.bobRelay;
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
  } as CC4MeNetworkInternalOptions);
}

// ================================================================
// t-070: SDK admin ops + delivery diagnostics
// ================================================================

describe('t-070: SDK admin ops + delivery diagnostics', () => {
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

  // Steps 1-2: Admin creates signed broadcast
  it('steps 1-2: admin creates signed broadcast stored on relay', async () => {
    const env = setupTestEnv();
    const admin = createNetworkClient(env, 'admin-agent');
    track(env, admin);

    await admin.start();

    // Create broadcast using admin interface
    const adminOps = admin.asAdmin(Buffer.from(env.adminKeys.privateKeyDer));
    await adminOps.broadcast('maintenance', { message: 'Scheduled maintenance at 2am' });

    // Verify broadcast stored on relay
    const broadcasts = relayListBroadcasts(env.db, 'maintenance');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'maintenance');
    assert.equal(broadcasts[0]!.sender, 'admin-agent');

    const payload = JSON.parse(broadcasts[0]!.payload);
    assert.equal(payload.message, 'Scheduled maintenance at 2am');
  });

  // Step 3: Second instance receives broadcast event
  it('step 3: second SDK instance receives broadcast event via checkBroadcasts', async () => {
    const env = setupTestEnv();
    const admin = createNetworkClient(env, 'admin-agent');
    const bob = createNetworkClient(env, 'bob');
    track(env, admin, bob);

    await admin.start();
    await bob.start();

    // Admin creates broadcast
    const adminOps = admin.asAdmin(Buffer.from(env.adminKeys.privateKeyDer));
    await adminOps.broadcast('announcement', { info: 'New feature released!' });

    // Bob checks for broadcasts
    const receivedBroadcasts: Broadcast[] = [];
    bob.on('broadcast', (b) => receivedBroadcasts.push(b));

    const newBroadcasts = await bob.checkBroadcasts();
    assert.equal(newBroadcasts.length, 1);
    assert.equal(newBroadcasts[0]!.type, 'announcement');
    assert.equal(newBroadcasts[0]!.sender, 'admin-agent');
    assert.deepEqual(newBroadcasts[0]!.payload, { info: 'New feature released!' });
    assert.equal(newBroadcasts[0]!.verified, true);

    // Event was emitted
    assert.equal(receivedBroadcasts.length, 1);

    // Second check should not re-emit (dedup by ID)
    const secondCheck = await bob.checkBroadcasts();
    assert.equal(secondCheck.length, 0);
    assert.equal(receivedBroadcasts.length, 1); // Still 1
  });

  // Step 4: approveAgent removed from SDK in v3 (auto-approve at registration)
  it('step 4: approveAgent is not available on admin interface (v3)', async () => {
    const env = setupTestEnv();
    const admin = createNetworkClient(env, 'admin-agent');
    track(env, admin);

    await admin.start();

    const adminOps = admin.asAdmin(Buffer.from(env.adminKeys.privateKeyDer));
    assert.equal(typeof (adminOps as any).approveAgent, 'undefined');
  });

  // Step 5: Admin revokes an active agent
  it('step 5: admin.revokeAgent changes active agent to revoked + broadcast', async () => {
    const env = setupTestEnv();
    const admin = createNetworkClient(env, 'admin-agent');
    track(env, admin);

    // Create a "bad agent"
    const badKeys = genKeypair();
    createActiveAgent(env.db, 'bad-agent', badKeys.publicKeyBase64);

    await admin.start();

    const adminOps = admin.asAdmin(Buffer.from(env.adminKeys.privateKeyDer));
    await adminOps.revokeAgent('bad-agent');

    // Verify agent is revoked
    const row = env.db.prepare("SELECT status FROM agents WHERE name = 'bad-agent'").get() as { status: string };
    assert.equal(row.status, 'revoked');

    // Verify revocation broadcast was created
    const broadcasts = relayListBroadcasts(env.db, 'revocation');
    assert.ok(broadcasts.length >= 1);
    const revBroadcast = broadcasts.find((b) => {
      const p = JSON.parse(b.payload);
      return p.revokedAgent === 'bad-agent';
    });
    assert.ok(revBroadcast);
  });

  // Step 6: Delivery report with attempts
  it('step 6: getDeliveryReport returns diagnostic info after send', async () => {
    const env = setupTestEnv();

    // Set up contacts between admin and bob
    const bob = createNetworkClient(env, 'bob');
    const deliverFn = async () => true; // Always succeeds
    const admin = createNetworkClient(env, 'admin-agent', deliverFn);
    track(env, admin, bob);

    await admin.start();
    await bob.start();

    // Establish contacts
    await admin.requestContact('bob');
    await bob.acceptContact('admin-agent');
    await admin.getContacts();

    // Send a message
    const result = await admin.send('bob', { text: 'Diagnostic test' });
    assert.equal(result.status, 'delivered');

    // Get delivery report
    const report = admin.getDeliveryReport(result.messageId);
    assert.ok(report);
    assert.equal(report.messageId, result.messageId);
    assert.equal(report.finalStatus, 'delivered');
    assert.ok(report.attempts.length >= 1);

    // Check attempt details
    const attempt = report.attempts[0]!;
    assert.equal(attempt.presenceCheck, true);
    assert.ok(attempt.endpoint);
    assert.equal(attempt.httpStatus, 200);
    assert.ok(typeof attempt.durationMs === 'number');
    assert.ok(attempt.timestamp);
  });

  // Step 7: Non-admin cannot perform admin operations
  it('step 7: non-admin agent gets error from admin operations', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');
    track(env, bob);

    await bob.start();

    // Bob tries to broadcast — should fail (bob is not in admins table)
    const bobOps = bob.asAdmin(Buffer.from(env.bobKeys.privateKeyDer));
    await assert.rejects(
      () => bobOps.broadcast('maintenance', { message: 'Hacker!' }),
      /Not an admin|Failed/,
    );
  });

  // Additional: contact-request events
  it('checkContactRequests emits events for new requests', async () => {
    const env = setupTestEnv();
    const admin = createNetworkClient(env, 'admin-agent');
    const bob = createNetworkClient(env, 'bob');
    track(env, admin, bob);

    await admin.start();
    await bob.start();

    // Admin sends a contact request to Bob
    await admin.requestContact('bob');

    // Bob checks for contact requests
    const receivedRequests: ContactRequest[] = [];
    bob.on('contact-request', (r) => receivedRequests.push(r));

    const newRequests = await bob.checkContactRequests();
    assert.equal(newRequests.length, 1);
    assert.equal(newRequests[0]!.from, 'admin-agent');

    // Event was emitted
    assert.equal(receivedRequests.length, 1);

    // Second check deduplicates
    const secondCheck = await bob.checkContactRequests();
    assert.equal(secondCheck.length, 0);
  });

  // Additional: delivery report for failed send
  it('delivery report tracks failed attempts', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');
    const deliverFn = async () => false; // Always fails
    const admin = createNetworkClient(env, 'admin-agent', deliverFn);
    track(env, admin, bob);

    await admin.start();
    await bob.start();

    await admin.requestContact('bob');
    await bob.acceptContact('admin-agent');
    await admin.getContacts();

    const result = await admin.send('bob', { text: 'Will fail' });
    // Delivery fails → queued for retry
    assert.equal(result.status, 'queued');

    const report = admin.getDeliveryReport(result.messageId);
    assert.ok(report);
    assert.ok(report.attempts.length >= 1);
    // First attempt should show delivery failure
    const attempt = report.attempts.find((a) => a.httpStatus === 0);
    assert.ok(attempt);
    assert.ok(attempt.error);
  });

  // Additional: delivery report for offline recipient
  it('delivery report records presence check failure', async () => {
    const env = setupTestEnv();
    const bob = createNetworkClient(env, 'bob');
    const admin = createNetworkClient(env, 'admin-agent');
    track(env, admin, bob);

    await admin.start();
    await bob.start();

    await admin.requestContact('bob');
    await bob.acceptContact('admin-agent');
    await admin.getContacts();

    // Make Bob offline
    await bob.stop();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    env.db.prepare("UPDATE agents SET last_seen = ? WHERE name = 'bob'").run(thirtyMinAgo);

    const result = await admin.send('bob', { text: 'Bob is offline' });
    assert.equal(result.status, 'queued');

    const report = admin.getDeliveryReport(result.messageId);
    assert.ok(report);
    assert.ok(report.attempts.length >= 1);
    // Should record the offline presence check
    const attempt = report.attempts[0]!;
    assert.equal(attempt.presenceCheck, false);
    assert.ok(attempt.error?.includes('offline'));
  });
});
