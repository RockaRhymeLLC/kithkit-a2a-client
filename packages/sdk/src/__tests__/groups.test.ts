/**
 * Tests for SDK group features (t-087 through t-092).
 *
 * t-087: SDK relay API group methods — uses MockRelayAPI backed by real relay DB functions.
 * t-088: SDK group lifecycle — create, invite, accept (via CC4MeNetwork class).
 * t-089: SDK group lifecycle — leave, remove, dissolve (via CC4MeNetwork class).
 * t-090: Group message fan-out — all online.
 * t-091: Group message fan-out — offline member.
 * t-092: Group message receive — verify and decrypt.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CC4MeNetwork, type CC4MeNetworkInternalOptions, type DeliverFn } from '../client.js';
import type { WireEnvelope, GroupMessage } from '../types.js';

import type {
  IRelayAPI,
  RelayContact,
  RelayPendingRequest,
  RelayBroadcast,
  RelayResponse,
  RelayGroup,
  RelayGroupMember,
  RelayGroupInvitation,
  RelayGroupChange,
} from '../relay-api.js';

// Import relay DB + route functions for the mock
import { initializeDatabase } from '../../../relay/src/db.js';
import {
  listContacts as relayListContacts,
  requestContact as relayRequestContact,
  acceptContact as relayAcceptContact,
} from '../../../relay/src/routes/contacts.js';
import {
  updatePresence as relayUpdatePresence,
} from '../../../relay/src/routes/presence.js';
import {
  createGroup as relayCreateGroup,
  getGroupDetails as relayGetGroupDetails,
  inviteToGroup as relayInviteToGroup,
  acceptInvitation as relayAcceptInvitation,
  declineInvitation as relayDeclineInvitation,
  leaveGroup as relayLeaveGroup,
  removeMember as relayRemoveMember,
  dissolveGroup as relayDissolveGroup,
  listGroups as relayListGroups,
  listMembers as relayListMembers,
  listInvitations as relayListInvitations,
  getChanges as relayGetChanges,
} from '../../../relay/src/routes/groups.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-groups-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

function createActiveAgent(db: ReturnType<typeof initializeDatabase>, name: string) {
  db.prepare(
    `INSERT INTO agents (name, public_key, email_verified, status, approved_by, approved_at, last_seen)
     VALUES (?, ?, 1, 'active', 'test-admin', datetime('now'), datetime('now'))`
  ).run(name, `pubkey-${name}`);
}

function makeContacts(db: ReturnType<typeof initializeDatabase>, a: string, b: string) {
  const [agent_a, agent_b] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES (?, ?, 'active', ?)`
  ).run(agent_a, agent_b, a);
}

/**
 * MockRelayAPI backed by real relay DB functions — for groups.
 * Implements group methods; other methods are stubs.
 */
class MockRelayAPI implements IRelayAPI {
  constructor(
    private db: ReturnType<typeof initializeDatabase>,
    private agentName: string,
  ) {}

  // Group methods — backed by real relay functions

  async createGroup(name: string, settings?: any): Promise<RelayResponse<RelayGroup>> {
    const result = relayCreateGroup(this.db, this.agentName, name, settings);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return {
      ok: true,
      status: 201,
      data: {
        groupId: result.groupId as string,
        name: result.name as string,
        owner: result.owner as string,
        status: 'active',
        settings: result.settings as any,
        createdAt: result.createdAt as string,
      },
    };
  }

  async getGroup(groupId: string): Promise<RelayResponse<RelayGroup>> {
    const result = relayGetGroupDetails(this.db, groupId, this.agentName);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return {
      ok: true,
      status: 200,
      data: {
        groupId: result.groupId as string,
        name: result.name as string,
        owner: result.owner as string,
        status: result.status as string,
        settings: result.settings as any,
        memberCount: result.memberCount as number,
        createdAt: result.createdAt as string,
      },
    };
  }

  async inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<RelayResponse> {
    const result = relayInviteToGroup(this.db, this.agentName, groupId, agent, greeting);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async acceptGroupInvitation(groupId: string): Promise<RelayResponse> {
    const result = relayAcceptInvitation(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async declineGroupInvitation(groupId: string): Promise<RelayResponse> {
    const result = relayDeclineInvitation(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async leaveGroup(groupId: string): Promise<RelayResponse> {
    const result = relayLeaveGroup(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async removeMember(groupId: string, agent: string): Promise<RelayResponse> {
    const result = relayRemoveMember(this.db, this.agentName, groupId, agent);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async dissolveGroup(groupId: string): Promise<RelayResponse> {
    const result = relayDissolveGroup(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async listGroups(): Promise<RelayResponse<RelayGroup[]>> {
    const result = relayListGroups(this.db, this.agentName);
    return { ok: true, status: 200, data: (result.groups as any[]) || [] };
  }

  async getGroupMembers(groupId: string): Promise<RelayResponse<RelayGroupMember[]>> {
    const result = relayListMembers(this.db, groupId, this.agentName);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200, data: (result.members as any[]) || [] };
  }

  async getGroupInvitations(): Promise<RelayResponse<RelayGroupInvitation[]>> {
    const result = relayListInvitations(this.db, this.agentName);
    return { ok: true, status: 200, data: (result.invitations as any[]) || [] };
  }

  async getGroupChanges(groupId: string, since: string): Promise<RelayResponse<RelayGroupChange[]>> {
    const result = relayGetChanges(this.db, groupId, this.agentName, since);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200, data: (result.changes as any[]) || [] };
  }

  // Transfer ownership — backed by real relay function
  async transferGroupOwnership(groupId: string, newOwner: string): Promise<RelayResponse> {
    const { transferOwnership } = await import('../../../relay/src/routes/groups.js');
    const result = transferOwnership(this.db, this.agentName, groupId, newOwner);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  // Stub methods — not tested here
  async requestContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async acceptContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async denyContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async removeContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async getContacts(): Promise<RelayResponse<RelayContact[]>> { return { ok: true, status: 200, data: [] }; }
  async getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>> { return { ok: true, status: 200, data: [] }; }
  async heartbeat(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async createBroadcast(): Promise<RelayResponse<{ broadcastId: string }>> { return { ok: false, status: 403 }; }
  async listBroadcasts(): Promise<RelayResponse<RelayBroadcast[]>> { return { ok: true, status: 200, data: [] }; }
  async revokeAgent(): Promise<RelayResponse> { return { ok: false, status: 403 }; }
  async rotateKey(): Promise<RelayResponse> { return { ok: false, status: 403 }; }
  async recoverKey(): Promise<RelayResponse> { return { ok: false, status: 403 }; }
}

// ================================================================
// t-087: SDK relay API group methods
// ================================================================

describe('t-087: SDK relay API group methods', () => {
  let cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs = [];
  });

  function withEnv() {
    const { db, dir } = setupDb();
    cleanupDirs.push(dir);
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    createActiveAgent(db, 'nova');
    makeContacts(db, 'bmo', 'atlas');
    makeContacts(db, 'bmo', 'nova');
    const bmoRelay = new MockRelayAPI(db, 'bmo');
    const atlasRelay = new MockRelayAPI(db, 'atlas');
    const novaRelay = new MockRelayAPI(db, 'nova');
    return { db, bmoRelay, atlasRelay, novaRelay };
  }

  // Step 1: createGroup returns groupId and metadata
  it('step 1: createGroup returns groupId and metadata', async () => {
    const { bmoRelay } = withEnv();
    const result = await bmoRelay.createGroup('project-alpha');
    assert.ok(result.ok);
    assert.ok(result.data);
    assert.ok(result.data.groupId);
    assert.equal(result.data.name, 'project-alpha');
    assert.equal(result.data.owner, 'bmo');
    assert.ok(result.data.settings);
    assert.ok(result.data.createdAt);
  });

  // Step 2: inviteToGroup checks mutual contact
  it('step 2: inviteToGroup rejects non-contacts', async () => {
    const { bmoRelay, db } = withEnv();
    createActiveAgent(db, 'stranger');
    const group = await bmoRelay.createGroup('team');
    // stranger is not a contact of bmo
    const result = await bmoRelay.inviteToGroup(group.data!.groupId, 'stranger');
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
  });

  // Step 3: acceptGroupInvitation updates membership to active
  it('step 3: acceptGroupInvitation updates membership', async () => {
    const { bmoRelay, atlasRelay } = withEnv();
    const group = await bmoRelay.createGroup('team');
    const groupId = group.data!.groupId;
    await bmoRelay.inviteToGroup(groupId, 'atlas');

    const result = await atlasRelay.acceptGroupInvitation(groupId);
    assert.ok(result.ok);

    // Verify Atlas is in member list
    const members = await bmoRelay.getGroupMembers(groupId);
    assert.ok(members.ok);
    const memberList = members.data!;
    assert.ok(memberList.some(m => m.agent === 'atlas'));
  });

  // Step 4: getGroupMembers returns correct list
  it('step 4: getGroupMembers returns active members with roles', async () => {
    const { bmoRelay, atlasRelay } = withEnv();
    const group = await bmoRelay.createGroup('team');
    const groupId = group.data!.groupId;
    await bmoRelay.inviteToGroup(groupId, 'atlas');
    await atlasRelay.acceptGroupInvitation(groupId);

    const members = await bmoRelay.getGroupMembers(groupId);
    assert.ok(members.ok);
    assert.equal(members.data!.length, 2);

    const bmoMember = members.data!.find(m => m.agent === 'bmo');
    assert.equal(bmoMember!.role, 'owner');

    const atlasMember = members.data!.find(m => m.agent === 'atlas');
    assert.equal(atlasMember!.role, 'member');
  });

  // Step 5: leaveGroup updates membership to left
  it('step 5: leaveGroup updates membership', async () => {
    const { bmoRelay, atlasRelay } = withEnv();
    const group = await bmoRelay.createGroup('team');
    const groupId = group.data!.groupId;
    await bmoRelay.inviteToGroup(groupId, 'atlas');
    await atlasRelay.acceptGroupInvitation(groupId);

    const result = await atlasRelay.leaveGroup(groupId);
    assert.ok(result.ok);

    // Atlas no longer in member list
    const members = await bmoRelay.getGroupMembers(groupId);
    assert.ok(!members.data!.some(m => m.agent === 'atlas'));
  });

  // Step 6: dissolveGroup marks group dissolved and updates all memberships
  it('step 6: dissolveGroup marks group dissolved', async () => {
    const { bmoRelay, atlasRelay } = withEnv();
    const group = await bmoRelay.createGroup('team');
    const groupId = group.data!.groupId;
    await bmoRelay.inviteToGroup(groupId, 'atlas');
    await atlasRelay.acceptGroupInvitation(groupId);

    const result = await bmoRelay.dissolveGroup(groupId);
    assert.ok(result.ok);

    // Group is no longer accessible (getGroup returns 403 since membership is 'left')
    const details = await bmoRelay.getGroup(groupId);
    assert.ok(!details.ok);
  });
});

// ================================================================
// Helpers for t-088 / t-089: CC4MeNetwork-level group tests
// ================================================================

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKeyDer: kp.privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
  };
}

function createActiveAgentWithKey(db: ReturnType<typeof initializeDatabase>, name: string, publicKeyBase64: string) {
  db.prepare(
    `INSERT INTO agents (name, public_key, email_verified, status, approved_by, approved_at, last_seen)
     VALUES (?, ?, 1, 'active', 'test-admin', datetime('now'), datetime('now'))`
  ).run(name, publicKeyBase64);
}

/** Create a CC4MeNetwork client backed by MockRelayAPI for group testing. */
function createGroupNetworkClient(
  relay: MockRelayAPI,
  username: string,
  privateKeyDer: Buffer,
  dir: string,
): CC4MeNetwork {
  return new CC4MeNetwork({
    relayUrl: 'http://localhost:0', // not used — mock relay
    username,
    privateKey: Buffer.from(privateKeyDer),
    endpoint: `https://${username}.example.com/inbox`,
    dataDir: join(dir, `${username}-data`),
    heartbeatInterval: 60_000, // long interval — manual in tests
    relayAPI: relay,
  } as CC4MeNetworkInternalOptions);
}

// ================================================================
// t-088: SDK group lifecycle — create, invite, accept
// ================================================================

describe('t-088: SDK group lifecycle — create, invite, accept', () => {
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

  function withNetworkEnv() {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-groups-net-'));
    const dbPath = join(dir, 'relay.db');
    const db = initializeDatabase(dbPath);

    const bmoKeys = genKeypair();
    const atlasKeys = genKeypair();

    createActiveAgentWithKey(db, 'bmo', bmoKeys.publicKeyBase64);
    createActiveAgentWithKey(db, 'atlas', atlasKeys.publicKeyBase64);
    makeContacts(db, 'bmo', 'atlas');

    const bmoRelay = new MockRelayAPI(db, 'bmo');
    const atlasRelay = new MockRelayAPI(db, 'atlas');

    const bmo = createGroupNetworkClient(bmoRelay, 'bmo', bmoKeys.privateKeyDer as Buffer, dir);
    const atlas = createGroupNetworkClient(atlasRelay, 'atlas', atlasKeys.privateKeyDer as Buffer, dir);

    cleanups.push({ dir, networks: [bmo, atlas] });
    return { db, bmo, atlas, bmoRelay, atlasRelay };
  }

  // Step 1: BMO creates group via network.createGroup()
  it('step 1: createGroup returns group object with groupId', async () => {
    const { bmo } = withNetworkEnv();
    await bmo.start();

    const group = await bmo.createGroup('project-alpha');
    assert.ok(group.groupId);
    assert.equal(group.name, 'project-alpha');
    assert.equal(group.owner, 'bmo');
  });

  // Step 2: BMO invites Atlas via network.inviteToGroup()
  it('step 2: inviteToGroup stores invitation on relay', async () => {
    const { bmo, atlas } = withNetworkEnv();
    await bmo.start();
    await atlas.start();

    const group = await bmo.createGroup('team');
    await bmo.inviteToGroup(group.groupId, 'atlas', 'Join us!');

    // Atlas should have pending invitation
    const invitations = await atlas.getGroupInvitations();
    assert.equal(invitations.length, 1);
    assert.equal(invitations[0]!.groupId, group.groupId);
  });

  // Step 3: Atlas receives 'group-invitation' event
  it('step 3: checkGroupInvitations emits group-invitation event', async () => {
    const { bmo, atlas } = withNetworkEnv();
    await bmo.start();
    await atlas.start();

    const group = await bmo.createGroup('team');
    await bmo.inviteToGroup(group.groupId, 'atlas', 'Welcome aboard!');

    const events: any[] = [];
    atlas.on('group-invitation', (inv: any) => events.push(inv));

    await atlas.checkGroupInvitations();

    assert.equal(events.length, 1);
    assert.equal(events[0].groupId, group.groupId);
    assert.equal(events[0].groupName, 'team');
    assert.equal(events[0].invitedBy, 'bmo');
    assert.equal(events[0].greeting, 'Welcome aboard!');
  });

  // Step 4: Atlas calls network.acceptGroupInvitation()
  it('step 4: acceptGroupInvitation activates membership', async () => {
    const { bmo, atlas } = withNetworkEnv();
    await bmo.start();
    await atlas.start();

    const group = await bmo.createGroup('team');
    await bmo.inviteToGroup(group.groupId, 'atlas');
    await atlas.acceptGroupInvitation(group.groupId);

    // Atlas is now an active member
    const members = await bmo.getGroupMembers(group.groupId);
    assert.ok(members.some(m => m.agent === 'atlas'));
  });

  // Step 5: network.getGroups() lists the group for both
  it('step 5: getGroups lists the group for both BMO and Atlas', async () => {
    const { bmo, atlas } = withNetworkEnv();
    await bmo.start();
    await atlas.start();

    const group = await bmo.createGroup('team');
    await bmo.inviteToGroup(group.groupId, 'atlas');
    await atlas.acceptGroupInvitation(group.groupId);

    const bmoGroups = await bmo.getGroups();
    const atlasGroups = await atlas.getGroups();

    assert.ok(bmoGroups.some(g => g.groupId === group.groupId));
    assert.ok(atlasGroups.some(g => g.groupId === group.groupId));
  });

  // Step 6: network.getGroupMembers() shows both with correct roles
  it('step 6: getGroupMembers shows BMO as owner, Atlas as member', async () => {
    const { bmo, atlas } = withNetworkEnv();
    await bmo.start();
    await atlas.start();

    const group = await bmo.createGroup('team');
    await bmo.inviteToGroup(group.groupId, 'atlas');
    await atlas.acceptGroupInvitation(group.groupId);

    const members = await bmo.getGroupMembers(group.groupId);
    assert.equal(members.length, 2);

    const bmoMember = members.find(m => m.agent === 'bmo');
    assert.equal(bmoMember!.role, 'owner');

    const atlasMember = members.find(m => m.agent === 'atlas');
    assert.equal(atlasMember!.role, 'member');
  });
});

// ================================================================
// t-089: SDK group lifecycle — leave, remove, dissolve
// ================================================================

describe('t-089: SDK group lifecycle — leave, remove, dissolve', () => {
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

  function withNetworkEnv() {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-groups-net-'));
    const dbPath = join(dir, 'relay.db');
    const db = initializeDatabase(dbPath);

    const bmoKeys = genKeypair();
    const atlasKeys = genKeypair();
    const novaKeys = genKeypair();

    createActiveAgentWithKey(db, 'bmo', bmoKeys.publicKeyBase64);
    createActiveAgentWithKey(db, 'atlas', atlasKeys.publicKeyBase64);
    createActiveAgentWithKey(db, 'nova', novaKeys.publicKeyBase64);
    makeContacts(db, 'bmo', 'atlas');
    makeContacts(db, 'bmo', 'nova');

    const bmoRelay = new MockRelayAPI(db, 'bmo');
    const atlasRelay = new MockRelayAPI(db, 'atlas');
    const novaRelay = new MockRelayAPI(db, 'nova');

    const bmo = createGroupNetworkClient(bmoRelay, 'bmo', bmoKeys.privateKeyDer as Buffer, dir);
    const atlas = createGroupNetworkClient(atlasRelay, 'atlas', atlasKeys.privateKeyDer as Buffer, dir);
    const nova = createGroupNetworkClient(novaRelay, 'nova', novaKeys.privateKeyDer as Buffer, dir);

    cleanups.push({ dir, networks: [bmo, atlas, nova] });
    return { db, bmo, atlas, nova };
  }

  /** Create a group with BMO, Atlas, and Nova as active members. */
  async function setupFullGroup(env: ReturnType<typeof withNetworkEnv>) {
    await env.bmo.start();
    await env.atlas.start();
    await env.nova.start();

    const group = await env.bmo.createGroup('team');
    await env.bmo.inviteToGroup(group.groupId, 'atlas');
    await env.bmo.inviteToGroup(group.groupId, 'nova');
    await env.atlas.acceptGroupInvitation(group.groupId);
    await env.nova.acceptGroupInvitation(group.groupId);

    return group;
  }

  // Step 1: Create group with BMO, Atlas, Nova → 3 active members
  it('step 1: group with 3 active members', async () => {
    const env = withNetworkEnv();
    const group = await setupFullGroup(env);

    const members = await env.bmo.getGroupMembers(group.groupId);
    assert.equal(members.length, 3);
    assert.ok(members.some(m => m.agent === 'bmo'));
    assert.ok(members.some(m => m.agent === 'atlas'));
    assert.ok(members.some(m => m.agent === 'nova'));
  });

  // Step 2: Nova calls network.leaveGroup()
  it('step 2: leaveGroup removes Nova from active members', async () => {
    const env = withNetworkEnv();
    const group = await setupFullGroup(env);

    await env.nova.leaveGroup(group.groupId);

    const members = await env.bmo.getGroupMembers(group.groupId);
    assert.equal(members.length, 2);
    assert.ok(!members.some(m => m.agent === 'nova'));
  });

  // Step 3: 'group-member-change' event emits for Nova leaving
  it('step 3: group-member-change event emits with action=left', async () => {
    const env = withNetworkEnv();
    const group = await setupFullGroup(env);

    const events: any[] = [];
    env.nova.on('group-member-change', (change: any) => events.push(change));

    await env.nova.leaveGroup(group.groupId);

    assert.equal(events.length, 1);
    assert.equal(events[0].groupId, group.groupId);
    assert.equal(events[0].agent, 'nova');
    assert.equal(events[0].action, 'left');
  });

  // Step 4: BMO calls network.removeFromGroup(groupId, 'atlas')
  it('step 4: removeFromGroup removes Atlas', async () => {
    const env = withNetworkEnv();
    const group = await setupFullGroup(env);

    const removeEvents: any[] = [];
    env.bmo.on('group-member-change', (change: any) => removeEvents.push(change));

    await env.bmo.removeFromGroup(group.groupId, 'atlas');

    const members = await env.bmo.getGroupMembers(group.groupId);
    assert.ok(!members.some(m => m.agent === 'atlas'));

    assert.equal(removeEvents.length, 1);
    assert.equal(removeEvents[0].action, 'removed');
    assert.equal(removeEvents[0].agent, 'atlas');
  });

  // Step 5: BMO calls network.dissolveGroup()
  it('step 5: dissolveGroup dissolves the group', async () => {
    const env = withNetworkEnv();
    const group = await setupFullGroup(env);

    await env.bmo.dissolveGroup(group.groupId);

    // Group details should not be accessible
    const details = await env.bmo.getGroups();
    assert.ok(!details.some(g => g.groupId === group.groupId));
  });

  // Step 6: network.getGroups() no longer lists dissolved group
  it('step 6: getGroups returns empty after dissolve', async () => {
    const env = withNetworkEnv();
    const group = await setupFullGroup(env);

    await env.bmo.dissolveGroup(group.groupId);

    const bmoGroups = await env.bmo.getGroups();
    const atlasGroups = await env.atlas.getGroups();
    const novaGroups = await env.nova.getGroups();

    assert.ok(!bmoGroups.some(g => g.groupId === group.groupId));
    assert.ok(!atlasGroups.some(g => g.groupId === group.groupId));
    assert.ok(!novaGroups.some(g => g.groupId === group.groupId));
  });
});

// ================================================================
// FullMockRelayAPI — groups + contacts + presence for messaging tests
// ================================================================

/**
 * Full mock relay API backed by real DB functions for groups, contacts, and presence.
 * Used by t-090, t-091, t-092.
 */
class FullMockRelayAPI implements IRelayAPI {
  public offline = false;

  constructor(
    private db: ReturnType<typeof initializeDatabase>,
    private agentName: string,
  ) {}

  private checkOnline(): void {
    if (this.offline) throw new Error('Relay unreachable');
  }

  // Contacts — real DB
  async getContacts(): Promise<RelayResponse<RelayContact[]>> {
    this.checkOnline();
    const contacts = relayListContacts(this.db, this.agentName);
    return { ok: true, status: 200, data: contacts };
  }

  // Presence — real DB
  async heartbeat(endpoint: string): Promise<RelayResponse> {
    this.checkOnline();
    const result = relayUpdatePresence(this.db, this.agentName, endpoint);
    return { ok: result.ok, status: result.status || 200, error: result.error };
  }

  // getPresence removed in v3 — presence is in getContacts response

  // Groups — real DB
  async createGroup(name: string, settings?: any): Promise<RelayResponse<RelayGroup>> {
    const result = relayCreateGroup(this.db, this.agentName, name, settings);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return {
      ok: true, status: 201,
      data: { groupId: result.groupId as string, name: result.name as string, owner: result.owner as string, status: 'active', settings: result.settings as any, createdAt: result.createdAt as string },
    };
  }

  async getGroup(groupId: string): Promise<RelayResponse<RelayGroup>> {
    const result = relayGetGroupDetails(this.db, groupId, this.agentName);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200, data: { groupId: result.groupId as string, name: result.name as string, owner: result.owner as string, status: result.status as string, settings: result.settings as any, memberCount: result.memberCount as number, createdAt: result.createdAt as string } };
  }

  async inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<RelayResponse> {
    const result = relayInviteToGroup(this.db, this.agentName, groupId, agent, greeting);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async acceptGroupInvitation(groupId: string): Promise<RelayResponse> {
    const result = relayAcceptInvitation(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async declineGroupInvitation(groupId: string): Promise<RelayResponse> {
    const result = relayDeclineInvitation(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async leaveGroup(groupId: string): Promise<RelayResponse> {
    const result = relayLeaveGroup(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async removeMember(groupId: string, agent: string): Promise<RelayResponse> {
    const result = relayRemoveMember(this.db, this.agentName, groupId, agent);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async dissolveGroup(groupId: string): Promise<RelayResponse> {
    const result = relayDissolveGroup(this.db, this.agentName, groupId);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  async listGroups(): Promise<RelayResponse<RelayGroup[]>> {
    const result = relayListGroups(this.db, this.agentName);
    return { ok: true, status: 200, data: (result.groups as any[]) || [] };
  }

  async getGroupMembers(groupId: string): Promise<RelayResponse<RelayGroupMember[]>> {
    const result = relayListMembers(this.db, groupId, this.agentName);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200, data: (result.members as any[]) || [] };
  }

  async getGroupInvitations(): Promise<RelayResponse<RelayGroupInvitation[]>> {
    const result = relayListInvitations(this.db, this.agentName);
    return { ok: true, status: 200, data: (result.invitations as any[]) || [] };
  }

  async getGroupChanges(groupId: string, since: string): Promise<RelayResponse<RelayGroupChange[]>> {
    const result = relayGetChanges(this.db, groupId, this.agentName, since);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200, data: (result.changes as any[]) || [] };
  }

  // Transfer ownership — backed by real relay function
  async transferGroupOwnership(groupId: string, newOwner: string): Promise<RelayResponse> {
    const { transferOwnership } = await import('../../../relay/src/routes/groups.js');
    const result = transferOwnership(this.db, this.agentName, groupId, newOwner);
    if (!result.ok) return { ok: false, status: result.status as number, error: result.error };
    return { ok: true, status: 200 };
  }

  // Stubs for unused methods
  async requestContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async acceptContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async denyContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async removeContact(): Promise<RelayResponse> { return { ok: true, status: 200 }; }
  async getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>> { return { ok: true, status: 200, data: [] }; }
  async createBroadcast(): Promise<RelayResponse<{ broadcastId: string }>> { return { ok: false, status: 403 }; }
  async listBroadcasts(): Promise<RelayResponse<RelayBroadcast[]>> { return { ok: true, status: 200, data: [] }; }
  async revokeAgent(): Promise<RelayResponse> { return { ok: false, status: 403 }; }
  async rotateKey(): Promise<RelayResponse> { return { ok: false, status: 403 }; }
  async recoverKey(): Promise<RelayResponse> { return { ok: false, status: 403 }; }
}

// ================================================================
// Helpers for t-090 / t-091 / t-092: messaging tests
// ================================================================

interface MsgAgentKeys {
  privateKeyDer: Buffer;
  publicKeyBase64: string;
}

interface MsgTestEnv {
  db: ReturnType<typeof initializeDatabase>;
  dir: string;
  keys: Record<string, MsgAgentKeys>;
  relays: Record<string, FullMockRelayAPI>;
  networks: Record<string, CC4MeNetwork>;
  delivered: WireEnvelope[];
}

function setupMsgEnv(agents: string[]): MsgTestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-groups-msg-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);

  const keys: Record<string, MsgAgentKeys> = {};
  const relays: Record<string, FullMockRelayAPI> = {};
  const networks: Record<string, CC4MeNetwork> = {};
  const delivered: WireEnvelope[] = [];

  // Create agents with keypairs
  for (const name of agents) {
    const kp = genKeypair();
    keys[name] = { privateKeyDer: kp.privateKeyDer as Buffer, publicKeyBase64: kp.publicKeyBase64 };
    createActiveAgentWithKey(db, name, kp.publicKeyBase64);
  }

  // Make all agents mutual contacts (required for group invites)
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      makeContacts(db, agents[i]!, agents[j]!);
    }
  }

  // Capture-and-route delivery function
  const deliverFn: DeliverFn = async (_endpoint: string, envelope: WireEnvelope) => {
    delivered.push(envelope);
    return true;
  };

  // Create relay mocks and network clients
  for (const name of agents) {
    relays[name] = new FullMockRelayAPI(db, name);
    networks[name] = new CC4MeNetwork({
      relayUrl: 'http://localhost:0',
      username: name,
      privateKey: Buffer.from(keys[name]!.privateKeyDer),
      endpoint: `https://${name}.example.com/inbox`,
      dataDir: join(dir, `${name}-data`),
      heartbeatInterval: 60_000,
      relayAPI: relays[name],
      deliverFn,
    } as CC4MeNetworkInternalOptions);
  }

  return { db, dir, keys, relays, networks, delivered };
}

// ================================================================
// t-090: Group message fan-out — all online
// ================================================================

describe('t-090: Group message fan-out — all online', () => {
  let env: MsgTestEnv | null = null;

  afterEach(async () => {
    if (env) {
      for (const n of Object.values(env.networks)) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(env.dir, { recursive: true, force: true });
      env = null;
    }
  });

  async function setup() {
    env = setupMsgEnv(['bmo', 'atlas', 'nova']);
    // Start all (sends heartbeats, populates contacts cache)
    for (const n of Object.values(env.networks)) await n.start();

    // Create group and invite members
    const group = await env.networks.bmo!.createGroup('team');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'atlas');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'nova');
    await env.networks.atlas!.acceptGroupInvitation(group.groupId);
    await env.networks.nova!.acceptGroupInvitation(group.groupId);
    return group;
  }

  // Step 1: Create group with 3 members
  it('step 1: group has 3 members', async () => {
    const group = await setup();
    const members = await env!.networks.bmo!.getGroupMembers(group.groupId);
    assert.equal(members.length, 3);
  });

  // Step 2: sendToGroup returns delivered for both recipients
  it('step 2: sendToGroup delivers to atlas and nova', async () => {
    const group = await setup();
    const result = await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    assert.ok(result.messageId);
    assert.equal(result.delivered.length, 2);
    assert.ok(result.delivered.includes('atlas'));
    assert.ok(result.delivered.includes('nova'));
    assert.equal(result.queued.length, 0);
    assert.equal(result.failed.length, 0);
  });

  // Step 3: Atlas receives 'group-message' event
  it('step 3: Atlas receives group-message with correct fields', async () => {
    const group = await setup();
    await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    // Find Atlas's envelope from delivered
    const atlasEnvelope = env!.delivered.find(e => e.recipient === 'atlas');
    assert.ok(atlasEnvelope);

    const events: GroupMessage[] = [];
    env!.networks.atlas!.on('group-message', (msg: GroupMessage) => events.push(msg));

    const msg = await env!.networks.atlas!.receiveGroupMessage(atlasEnvelope);
    assert.equal(msg.groupId, group.groupId);
    assert.equal(msg.sender, 'bmo');
    assert.deepEqual(msg.payload, { text: 'hello' });
    assert.equal(msg.verified, true);
    assert.equal(events.length, 1);
  });

  // Step 4: Nova receives same messageId
  it('step 4: Nova receives same messageId as Atlas', async () => {
    const group = await setup();
    await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    const atlasEnvelope = env!.delivered.find(e => e.recipient === 'atlas')!;
    const novaEnvelope = env!.delivered.find(e => e.recipient === 'nova')!;

    const atlasMsg = await env!.networks.atlas!.receiveGroupMessage(atlasEnvelope);
    const novaMsg = await env!.networks.nova!.receiveGroupMessage(novaEnvelope);

    assert.equal(atlasMsg.messageId, novaMsg.messageId);
  });

  // Step 5: Each member received individually encrypted envelope (different ciphertext)
  it('step 5: different ciphertext per member', async () => {
    const group = await setup();
    await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    const atlasEnvelope = env!.delivered.find(e => e.recipient === 'atlas')!;
    const novaEnvelope = env!.delivered.find(e => e.recipient === 'nova')!;

    assert.notEqual(
      atlasEnvelope.payload.ciphertext,
      novaEnvelope.payload.ciphertext,
    );
  });

  // Step 6: Envelopes have type='group' and correct groupId
  it('step 6: wire format has type=group and groupId', async () => {
    const group = await setup();
    await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    for (const envelope of env!.delivered) {
      assert.equal(envelope.type, 'group');
      assert.equal(envelope.groupId, group.groupId);
    }
  });
});

// ================================================================
// t-091: Group message fan-out — offline member
// ================================================================

describe('t-091: Group message fan-out — offline member', () => {
  let env: MsgTestEnv | null = null;

  afterEach(async () => {
    if (env) {
      for (const n of Object.values(env.networks)) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(env.dir, { recursive: true, force: true });
      env = null;
    }
  });

  async function setup() {
    env = setupMsgEnv(['bmo', 'atlas', 'nova']);
    for (const n of Object.values(env.networks)) await n.start();

    const group = await env.networks.bmo!.createGroup('team');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'atlas');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'nova');
    await env.networks.atlas!.acceptGroupInvitation(group.groupId);
    await env.networks.nova!.acceptGroupInvitation(group.groupId);

    return group;
  }

  // Step 1: 2 online, 1 offline
  it('step 1: Nova is offline', async () => {
    const group = await setup();

    // Mark Nova's relay as offline (presence check will fail)
    env!.relays.nova!.offline = true;
    // Clear Nova's presence from DB (make presence query return offline)
    env!.db.prepare("UPDATE agents SET last_seen = datetime('now', '-25 minutes') WHERE name = 'nova'").run();

    const members = await env!.networks.bmo!.getGroupMembers(group.groupId);
    assert.equal(members.length, 3); // Still a member, just offline
  });

  // Step 2: sendToGroup returns delivered for atlas, queued for nova
  it('step 2: atlas delivered, nova queued', async () => {
    const group = await setup();
    env!.db.prepare("UPDATE agents SET last_seen = ?, endpoint = NULL WHERE name = 'nova'").run(new Date(Date.now() - 25 * 60 * 1000).toISOString());

    const result = await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    assert.ok(result.delivered.includes('atlas'));
    assert.ok(result.queued.includes('nova'));
    assert.equal(result.failed.length, 0);
  });

  // Step 3: Atlas receives message immediately
  it('step 3: Atlas receives group-message event', async () => {
    const group = await setup();
    env!.db.prepare("UPDATE agents SET last_seen = ?, endpoint = NULL WHERE name = 'nova'").run(new Date(Date.now() - 25 * 60 * 1000).toISOString());

    await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    const atlasEnvelope = env!.delivered.find(e => e.recipient === 'atlas')!;
    assert.ok(atlasEnvelope);

    const msg = await env!.networks.atlas!.receiveGroupMessage(atlasEnvelope);
    assert.equal(msg.sender, 'bmo');
    assert.deepEqual(msg.payload, { text: 'hello' });
  });

  // Step 4: Nova's message is queued in RetryQueue
  it('step 4: Nova message queued, no envelope delivered to nova', async () => {
    const group = await setup();
    env!.db.prepare("UPDATE agents SET last_seen = ?, endpoint = NULL WHERE name = 'nova'").run(new Date(Date.now() - 25 * 60 * 1000).toISOString());

    const result = await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    // Nova should not have a delivered envelope
    const novaEnvelope = env!.delivered.find(e => e.recipient === 'nova');
    assert.ok(!novaEnvelope);

    // Nova should be in queued list
    assert.ok(result.queued.includes('nova'));
  });

  // Step 5: Nova comes online, retry delivers (verify retry queue has entry)
  it('step 5: retry queue has entry for nova', async () => {
    const group = await setup();
    env!.db.prepare("UPDATE agents SET last_seen = ?, endpoint = NULL WHERE name = 'nova'").run(new Date(Date.now() - 25 * 60 * 1000).toISOString());

    // Use a custom deliver fn that tracks per-call
    let novaRetried = false;
    const origDeliverFn = (env!.networks.bmo! as any).deliverFn;
    (env!.networks.bmo! as any).deliverFn = async (endpoint: string, envelope: WireEnvelope) => {
      if (envelope.recipient === 'nova') novaRetried = true;
      return origDeliverFn(endpoint, envelope);
    };

    const result = await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });
    assert.ok(result.queued.includes('nova'));

    // The retry queue should have the entry (verify via size)
    const retryQueue = (env!.networks.bmo! as any).retryQueue;
    assert.ok(retryQueue.size > 0);
  });

  // Step 6: Verify RetryQueue uses same backoff as 1:1 (10s, 30s, 90s)
  it('step 6: retry queue uses standard backoff delays', async () => {
    await setup();
    const retryQueue = (env!.networks.bmo! as any).retryQueue;
    const delays = retryQueue.retryDelays;
    assert.deepEqual(delays, [10_000, 30_000, 90_000]);
  });
});

// ================================================================
// t-092: Group message receive — verify and decrypt
// ================================================================

describe('t-092: Group message receive — verify and decrypt', () => {
  let env: MsgTestEnv | null = null;

  afterEach(async () => {
    if (env) {
      for (const n of Object.values(env.networks)) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(env.dir, { recursive: true, force: true });
      env = null;
    }
  });

  async function setup() {
    env = setupMsgEnv(['bmo', 'atlas', 'nova']);
    for (const n of Object.values(env.networks)) await n.start();

    const group = await env.networks.bmo!.createGroup('team');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'atlas');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'nova');
    await env.networks.atlas!.acceptGroupInvitation(group.groupId);
    await env.networks.nova!.acceptGroupInvitation(group.groupId);

    return group;
  }

  // Step 1: Atlas sends a group message via fan-out
  it('step 1: Atlas sends group message, BMO and Nova should receive', async () => {
    const group = await setup();
    const result = await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'from atlas' });

    assert.ok(result.delivered.includes('bmo'));
    assert.ok(result.delivered.includes('nova'));
    assert.ok(!result.delivered.includes('atlas')); // Sender excluded
  });

  // Step 2: BMO receives envelope with type='group' and groupId
  it('step 2: received envelope has type=group and groupId', async () => {
    const group = await setup();
    await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'from atlas' });

    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo')!;
    assert.equal(bmoEnvelope.type, 'group');
    assert.equal(bmoEnvelope.groupId, group.groupId);
  });

  // Step 3: BMO verifies Atlas's Ed25519 signature
  it('step 3: signature verification succeeds', async () => {
    const group = await setup();
    await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'from atlas' });

    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo')!;
    const msg = await env!.networks.bmo!.receiveGroupMessage(bmoEnvelope);
    assert.equal(msg.verified, true);
  });

  // Step 4: BMO decrypts with BMO↔Atlas ECDH shared key
  it('step 4: payload decrypted correctly', async () => {
    const group = await setup();
    await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'from atlas' });

    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo')!;
    const msg = await env!.networks.bmo!.receiveGroupMessage(bmoEnvelope);
    assert.deepEqual(msg.payload, { text: 'from atlas' });
  });

  // Step 5: BMO checks Atlas is member of the group (membership cache)
  it('step 5: membership cache confirms sender is member', async () => {
    const group = await setup();

    // Pre-populate BMO's member cache by calling getGroupMembers
    await env!.networks.bmo!.getGroupMembers(group.groupId);

    await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'from atlas' });

    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo')!;

    // Warm the member cache via sendToGroup (it calls getGroupMembersCached internally)
    // receiveGroupMessage checks the cache
    const msg = await env!.networks.bmo!.receiveGroupMessage(bmoEnvelope);
    assert.equal(msg.sender, 'atlas');
    assert.equal(msg.verified, true);
  });

  // Step 6: 'group-message' event emitted with all fields
  it('step 6: group-message event has all required fields', async () => {
    const group = await setup();
    await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'from atlas' });

    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo')!;

    const events: GroupMessage[] = [];
    env!.networks.bmo!.on('group-message', (msg: GroupMessage) => events.push(msg));

    await env!.networks.bmo!.receiveGroupMessage(bmoEnvelope);

    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.ok(event.groupId);
    assert.equal(event.groupId, group.groupId);
    assert.equal(event.sender, 'atlas');
    assert.ok(event.messageId);
    assert.ok(event.timestamp);
    assert.deepEqual(event.payload, { text: 'from atlas' });
    assert.equal(event.verified, true);
  });
});

// ================================================================
// t-093: Should-haves — dedup, cache refresh, ownership transfer
// ================================================================

describe('t-093: Should-haves — dedup, cache refresh, ownership transfer', () => {
  let env: MsgTestEnv | null = null;

  afterEach(async () => {
    if (env) {
      for (const n of Object.values(env.networks)) {
        try { await n.stop(); } catch { /* ignore */ }
      }
      rmSync(env.dir, { recursive: true, force: true });
      env = null;
    }
  });

  async function setup() {
    env = setupMsgEnv(['bmo', 'atlas', 'nova']);
    for (const n of Object.values(env.networks)) await n.start();

    const group = await env.networks.bmo!.createGroup('team');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'atlas');
    await env.networks.bmo!.inviteToGroup(group.groupId, 'nova');
    await env.networks.atlas!.acceptGroupInvitation(group.groupId);
    await env.networks.nova!.acceptGroupInvitation(group.groupId);

    return group;
  }

  // Step 1: Dedup — same messageId twice, second is skipped
  it('step 1: duplicate messageId detected and skipped', async () => {
    const group = await setup();
    await env!.networks.bmo!.sendToGroup(group.groupId, { text: 'hello' });

    const atlasEnvelope = env!.delivered.find(e => e.recipient === 'atlas')!;

    // First receive — should work
    const msg1 = await env!.networks.atlas!.receiveGroupMessage(atlasEnvelope);
    assert.ok(msg1);
    assert.equal(msg1!.sender, 'bmo');

    // Second receive of same envelope — should return null (duplicate)
    const msg2 = await env!.networks.atlas!.receiveGroupMessage(atlasEnvelope);
    assert.equal(msg2, null);
  });

  // Step 2: Cache refresh — newly joined member's message accepted
  it('step 2: message from newly-joined member accepted after cache refresh', async () => {
    const group = await setup();

    // BMO fetches members to populate cache (bmo, atlas, nova)
    await env!.networks.bmo!.getGroupMembers(group.groupId);

    // Add a new agent 'spark' who joins the group
    const sparkKeys = genKeypair();
    createActiveAgentWithKey(env!.db, 'spark', sparkKeys.publicKeyBase64);
    makeContacts(env!.db, 'bmo', 'spark');
    makeContacts(env!.db, 'atlas', 'spark');

    // Create spark's relay and network
    env!.relays.spark = new FullMockRelayAPI(env!.db, 'spark');
    env!.keys.spark = { privateKeyDer: sparkKeys.privateKeyDer as Buffer, publicKeyBase64: sparkKeys.publicKeyBase64 };
    env!.networks.spark = new CC4MeNetwork({
      relayUrl: 'http://localhost:0',
      username: 'spark',
      privateKey: Buffer.from(sparkKeys.privateKeyDer),
      endpoint: 'https://spark.example.com/inbox',
      dataDir: join(env!.dir, 'spark-data'),
      heartbeatInterval: 60_000,
      relayAPI: env!.relays.spark,
      deliverFn: async (_ep: string, envelope: WireEnvelope) => {
        env!.delivered.push(envelope);
        return true;
      },
    } as CC4MeNetworkInternalOptions);
    await env!.networks.spark!.start();

    // Refresh BMO's contacts cache (spark was added after start())
    await env!.networks.bmo!.getContacts();

    // BMO invites spark, spark accepts
    await env!.networks.bmo!.inviteToGroup(group.groupId, 'spark');
    await env!.networks.spark!.acceptGroupInvitation(group.groupId);

    // Spark sends a group message — BMO's cache doesn't have spark yet
    await env!.networks.spark!.sendToGroup(group.groupId, { text: 'hi from spark' });

    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo' && e.sender === 'spark')!;
    assert.ok(bmoEnvelope);

    // BMO receives — should trigger cache refresh and accept
    const msg = await env!.networks.bmo!.receiveGroupMessage(bmoEnvelope);
    assert.ok(msg);
    assert.equal(msg!.sender, 'spark');
    assert.deepEqual(msg!.payload, { text: 'hi from spark' });
  });

  // Step 3: Cache refresh — removed member's message rejected
  it('step 3: message from non-member rejected after cache refresh', async () => {
    const group = await setup();

    // BMO fetches members to populate cache (bmo, atlas, nova)
    await env!.networks.bmo!.getGroupMembers(group.groupId);

    // Atlas sends a group message BEFORE removal — capture the envelope
    await env!.networks.atlas!.sendToGroup(group.groupId, { text: 'still here?' });
    const bmoEnvelope = env!.delivered.find(e => e.recipient === 'bmo' && e.sender === 'atlas')!;
    assert.ok(bmoEnvelope);

    // Now remove Atlas from the group
    await env!.networks.bmo!.removeFromGroup(group.groupId, 'atlas');

    // Invalidate BMO's member cache so it must refresh from relay
    (env!.networks.bmo! as any).memberCache.delete(group.groupId);

    // BMO receives the stale envelope — cache refresh confirms Atlas is no longer a member
    await assert.rejects(
      () => env!.networks.bmo!.receiveGroupMessage(bmoEnvelope),
      { message: /not a member/ },
    );
  });

  // Step 4: Owner transfers ownership to Atlas
  it('step 4: ownership transfer succeeds', async () => {
    const group = await setup();

    await env!.networks.bmo!.transferGroupOwnership(group.groupId, 'atlas');

    // Verify via relay
    const details = await env!.relays.bmo!.getGroup(group.groupId);
    assert.ok(details.ok);
    assert.equal(details.data!.owner, 'atlas');
  });

  // Step 5: Ownership transfer reflected in relay
  it('step 5: getGroup shows new owner', async () => {
    const group = await setup();
    await env!.networks.bmo!.transferGroupOwnership(group.groupId, 'atlas');

    // Atlas can now verify she's the owner
    const members = await env!.networks.atlas!.getGroupMembers(group.groupId);
    const atlasMember = members.find(m => m.agent === 'atlas');
    assert.equal(atlasMember!.role, 'owner');

    const bmoMember = members.find(m => m.agent === 'bmo');
    assert.equal(bmoMember!.role, 'admin');
  });

  // Step 6: Ownership transfer emits group-member-change event
  it('step 6: group-member-change event with action=ownership-transferred', async () => {
    const group = await setup();

    const events: any[] = [];
    env!.networks.bmo!.on('group-member-change', (change: any) => events.push(change));

    await env!.networks.bmo!.transferGroupOwnership(group.groupId, 'atlas');

    assert.equal(events.length, 1);
    assert.equal(events[0].groupId, group.groupId);
    assert.equal(events[0].agent, 'atlas');
    assert.equal(events[0].action, 'ownership-transferred');
  });
});
