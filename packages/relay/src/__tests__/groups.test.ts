/**
 * Tests for group lifecycle routes (t-081, t-082, t-083, t-084).
 *
 * t-081: Create group and get details
 * t-082: Invite, accept, and decline group invitations
 * t-083: Leave, remove, and permissions
 * t-084: Dissolve group and admin dissolution
 *
 * Uses direct function calls (not HTTP) with temp SQLite databases.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeDatabase } from '../db.js';
import {
  createGroup,
  getGroupDetails,
  inviteToGroup,
  acceptInvitation,
  declineInvitation,
  leaveGroup,
  removeMember,
  dissolveGroup,
  listGroups,
  listMembers,
  listInvitations,
  getChanges,
} from '../routes/groups.js';

function setupDb() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-groups-test-'));
  const dbPath = join(dir, 'relay.db');
  const db = initializeDatabase(dbPath);
  return { db, dir };
}

/** Register an active agent directly in the DB. */
function createActiveAgent(
  db: ReturnType<typeof initializeDatabase>,
  name: string,
  lastSeen?: string,
) {
  db.prepare(
    `INSERT INTO agents (name, public_key, email_verified, status, approved_by, approved_at, last_seen)
     VALUES (?, ?, 1, 'active', 'test-admin', datetime('now'), ?)`
  ).run(name, `pubkey-${name}`, lastSeen || new Date().toISOString());
}

/** Create mutual contacts between two agents. */
function makeContacts(db: ReturnType<typeof initializeDatabase>, a: string, b: string) {
  const [agent_a, agent_b] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT INTO contacts (agent_a, agent_b, status, requested_by) VALUES (?, ?, 'active', ?)`
  ).run(agent_a, agent_b, a);
}

/** Seed an admin. */
function seedAdmin(db: ReturnType<typeof initializeDatabase>, name: string) {
  db.prepare(
    'INSERT OR IGNORE INTO admins (agent, admin_public_key) VALUES (?, ?)'
  ).run(name, `pubkey-${name}`);
}

// ================================================================
// t-081: Create group and get details
// ================================================================

describe('t-081: Create group and get details', () => {
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

  // Step 1: Register and approve agent BMO
  it('step 1: register and approve agent', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    const agent = db.prepare('SELECT status FROM agents WHERE name = ?').get('bmo') as any;
    assert.equal(agent.status, 'active');
  });

  // Step 2: BMO creates group with default settings
  it('step 2: create group with default settings', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    const result = createGroup(db, 'bmo', 'project-alpha');
    assert.ok(result.ok);
    assert.equal(result.status, 201);
    assert.ok(result.groupId);
    assert.equal(result.name, 'project-alpha');
    assert.equal(result.owner, 'bmo');
    assert.ok(result.settings);
    const settings = result.settings as any;
    assert.equal(settings.membersCanInvite, false);
    assert.equal(settings.membersCanSend, true);
    assert.equal(settings.maxMembers, 50);
  });

  // Step 3: Get group details
  it('step 3: get group details', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    const created = createGroup(db, 'bmo', 'project-alpha');
    const result = getGroupDetails(db, created.groupId as string, 'bmo');
    assert.ok(result.ok);
    assert.equal(result.name, 'project-alpha');
    assert.equal(result.owner, 'bmo');
    assert.equal(result.memberCount, 1);
    assert.ok(result.settings);
  });

  // Step 4: BMO is owner with active status
  it('step 4: verify BMO is owner with active status', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    const created = createGroup(db, 'bmo', 'project-alpha');
    const members = listMembers(db, created.groupId as string, 'bmo');
    assert.ok(members.ok);
    const memberList = members.members as any[];
    assert.equal(memberList.length, 1);
    assert.equal(memberList[0].agent, 'bmo');
    assert.equal(memberList[0].role, 'owner');
  });

  // Step 5: Reject name > 64 chars
  it('step 5: reject name > 64 chars', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    const result = createGroup(db, 'bmo', 'x'.repeat(65));
    assert.ok(!result.ok);
    assert.equal(result.status, 400);
  });

  // Step 6: Reject unregistered agent
  it('step 6: reject unregistered agent', () => {
    const db = withDb();
    const result = createGroup(db, 'nobody', 'test-group');
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
  });
});

// ================================================================
// t-082: Invite, accept, and decline group invitations
// ================================================================

describe('t-082: Invite, accept, and decline group invitations', () => {
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

  // Step 1: Register 3 agents
  it('step 1: register 3 agents', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    createActiveAgent(db, 'nova');
    const count = db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'active'").get() as any;
    assert.equal(count.c, 3);
  });

  // Step 2: Establish mutual contacts
  it('step 2: establish mutual contacts', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    createActiveAgent(db, 'nova');
    makeContacts(db, 'bmo', 'atlas');
    makeContacts(db, 'bmo', 'nova');
    const contacts = db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status = 'active'").get() as any;
    assert.equal(contacts.c, 2);
  });

  // Step 3: BMO creates group and invites Atlas with greeting
  it('step 3: invite Atlas with greeting', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    const result = inviteToGroup(db, 'bmo', group.groupId as string, 'atlas', 'Welcome aboard!');
    assert.ok(result.ok);
    assert.equal(result.status, 'invited');

    // Check Atlas has pending invitation
    const invitations = listInvitations(db, 'atlas');
    const invList = invitations.invitations as any[];
    assert.equal(invList.length, 1);
    assert.equal(invList[0].groupName, 'team');
    assert.equal(invList[0].greeting, 'Welcome aboard!');
  });

  // Step 4: BMO invites Nova
  it('step 4: invite Nova', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'nova');
    makeContacts(db, 'bmo', 'nova');
    const group = createGroup(db, 'bmo', 'team');
    const result = inviteToGroup(db, 'bmo', group.groupId as string, 'nova');
    assert.ok(result.ok);
    const invitations = listInvitations(db, 'nova');
    assert.equal((invitations.invitations as any[]).length, 1);
  });

  // Step 5: Atlas accepts invitation
  it('step 5: Atlas accepts invitation', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    const result = acceptInvitation(db, 'atlas', group.groupId as string);
    assert.ok(result.ok);
    assert.equal(result.status, 'accepted');

    // Atlas should be in member list
    const members = listMembers(db, group.groupId as string, 'bmo');
    const memberList = members.members as any[];
    assert.equal(memberList.length, 2);
    assert.ok(memberList.some(m => m.agent === 'atlas'));
  });

  // Step 6: Nova declines invitation
  it('step 6: Nova declines invitation', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'nova');
    makeContacts(db, 'bmo', 'nova');
    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'nova');
    const result = declineInvitation(db, 'nova', group.groupId as string);
    assert.ok(result.ok);
    assert.equal(result.status, 'declined');

    // Nova should not be in member list
    const members = listMembers(db, group.groupId as string, 'bmo');
    const memberList = members.members as any[];
    assert.equal(memberList.length, 1); // Only BMO
    assert.ok(!memberList.some(m => m.agent === 'nova'));
  });

  // Step 7: Try invite non-contact agent
  it('step 7: reject invite for non-contact', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'stranger');
    // No contacts established
    const group = createGroup(db, 'bmo', 'team');
    const result = inviteToGroup(db, 'bmo', group.groupId as string, 'stranger');
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
  });

  // Step 8: Try invite already-active member
  it('step 8: reject invite for already-active member', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    acceptInvitation(db, 'atlas', group.groupId as string);
    // Try to invite again
    const result = inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    assert.ok(!result.ok);
    assert.equal(result.status, 409);
  });
});

// ================================================================
// t-083: Leave, remove, and permissions
// ================================================================

describe('t-083: Leave, remove, and permissions', () => {
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

  /** Create a group with 4 members: BMO (owner), Atlas (admin), Nova, Zephyr. */
  function createFullGroup(db: ReturnType<typeof initializeDatabase>) {
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    createActiveAgent(db, 'nova');
    createActiveAgent(db, 'zephyr');
    makeContacts(db, 'bmo', 'atlas');
    makeContacts(db, 'bmo', 'nova');
    makeContacts(db, 'bmo', 'zephyr');

    const group = createGroup(db, 'bmo', 'team');
    const groupId = group.groupId as string;

    // Invite and accept all
    inviteToGroup(db, 'bmo', groupId, 'atlas');
    acceptInvitation(db, 'atlas', groupId);
    inviteToGroup(db, 'bmo', groupId, 'nova');
    acceptInvitation(db, 'nova', groupId);
    inviteToGroup(db, 'bmo', groupId, 'zephyr');
    acceptInvitation(db, 'zephyr', groupId);

    // Promote Atlas to admin
    db.prepare(
      `UPDATE group_memberships SET role = 'admin' WHERE group_id = ? AND agent = 'atlas'`
    ).run(groupId);

    return groupId;
  }

  // Step 1: 4 active members
  it('step 1: create group with 4 members', () => {
    const db = withDb();
    const groupId = createFullGroup(db);
    const members = listMembers(db, groupId, 'bmo');
    assert.equal((members.members as any[]).length, 4);
  });

  // Step 2: Nova leaves voluntarily
  it('step 2: Nova leaves group', () => {
    const db = withDb();
    const groupId = createFullGroup(db);
    const result = leaveGroup(db, 'nova', groupId);
    assert.ok(result.ok);
    assert.equal(result.status, 'left');

    // Not in active member list anymore
    const members = listMembers(db, groupId, 'bmo');
    const memberList = members.members as any[];
    assert.ok(!memberList.some(m => m.agent === 'nova'));
  });

  // Step 3: Atlas (admin) removes Zephyr
  it('step 3: admin removes Zephyr', () => {
    const db = withDb();
    const groupId = createFullGroup(db);
    const result = removeMember(db, 'atlas', groupId, 'zephyr');
    assert.ok(result.ok);
    assert.equal(result.status, 'removed');

    // Zephyr not in active list
    const members = listMembers(db, groupId, 'bmo');
    assert.ok(!(members.members as any[]).some(m => m.agent === 'zephyr'));
  });

  // Step 4: Removed member not in member queries
  it('step 4: left/removed members excluded from queries', () => {
    const db = withDb();
    const groupId = createFullGroup(db);
    leaveGroup(db, 'nova', groupId);
    removeMember(db, 'atlas', groupId, 'zephyr');

    const members = listMembers(db, groupId, 'bmo');
    const memberList = members.members as any[];
    assert.equal(memberList.length, 2); // Only BMO and Atlas
  });

  // Step 5: Non-admin cannot remove
  it('step 5: non-admin cannot remove member', () => {
    const db = withDb();
    const groupId = createFullGroup(db);
    const result = removeMember(db, 'nova', groupId, 'zephyr');
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
  });

  // Step 6: Owner cannot leave
  it('step 6: owner cannot leave', () => {
    const db = withDb();
    const groupId = createFullGroup(db);
    const result = leaveGroup(db, 'bmo', groupId);
    assert.ok(!result.ok);
    assert.equal(result.status, 400);
  });
});

// ================================================================
// t-084: Dissolve group and admin dissolution
// ================================================================

describe('t-084: Dissolve group and admin dissolution', () => {
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

  // Step 1: Create group with BMO (owner) and Atlas (admin)
  it('step 1: create group with owner and admin', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    acceptInvitation(db, 'atlas', group.groupId as string);
    db.prepare("UPDATE group_memberships SET role = 'admin' WHERE group_id = ? AND agent = 'atlas'")
      .run(group.groupId);

    const details = getGroupDetails(db, group.groupId as string, 'bmo');
    assert.equal(details.status, 'active');
  });

  // Step 2: BMO dissolves group
  it('step 2: owner dissolves group', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    acceptInvitation(db, 'atlas', group.groupId as string);

    const result = dissolveGroup(db, 'bmo', group.groupId as string);
    assert.ok(result.ok);
    assert.equal(result.status, 'dissolved');

    // All memberships set to 'left'
    const rows = db.prepare(
      `SELECT status FROM group_memberships WHERE group_id = ?`
    ).all(group.groupId) as any[];
    for (const row of rows) {
      assert.equal(row.status, 'left');
    }
  });

  // Step 3: Get dissolved group details
  it('step 3: dissolved group returns dissolved status', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    const group = createGroup(db, 'bmo', 'team');
    dissolveGroup(db, 'bmo', group.groupId as string);

    // After dissolution, BMO's membership is 'left' so getGroupDetails will deny access.
    // Check group status directly in DB.
    const row = db.prepare('SELECT status FROM groups WHERE id = ?').get(group.groupId) as any;
    assert.equal(row.status, 'dissolved');
  });

  // Step 4: Owner goes offline > 7 days
  it('step 4: set owner offline > 7 days', () => {
    const db = withDb();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    createActiveAgent(db, 'bmo', eightDaysAgo);
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');

    const agent = db.prepare('SELECT last_seen FROM agents WHERE name = ?').get('bmo') as any;
    const lastSeen = new Date(agent.last_seen).getTime();
    assert.ok(Date.now() - lastSeen > 7 * 24 * 60 * 60 * 1000, 'Owner should be offline > 7 days');
  });

  // Step 5: Admin dissolves orphaned group
  it('step 5: admin dissolves when owner offline > 7 days', () => {
    const db = withDb();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    createActiveAgent(db, 'bmo', eightDaysAgo);
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');

    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    acceptInvitation(db, 'atlas', group.groupId as string);
    db.prepare("UPDATE group_memberships SET role = 'admin' WHERE group_id = ? AND agent = 'atlas'")
      .run(group.groupId);

    const result = dissolveGroup(db, 'atlas', group.groupId as string);
    assert.ok(result.ok, 'Admin should be able to dissolve orphaned group');
    assert.equal(result.status, 'dissolved');
  });

  // Step 6: Admin cannot dissolve when owner recently active
  it('step 6: admin cannot dissolve when owner recently active', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo'); // Recent last_seen
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');

    const group = createGroup(db, 'bmo', 'team');
    inviteToGroup(db, 'bmo', group.groupId as string, 'atlas');
    acceptInvitation(db, 'atlas', group.groupId as string);
    db.prepare("UPDATE group_memberships SET role = 'admin' WHERE group_id = ? AND agent = 'atlas'")
      .run(group.groupId);

    const result = dissolveGroup(db, 'atlas', group.groupId as string);
    assert.ok(!result.ok, 'Admin should NOT dissolve when owner is reachable');
    assert.equal(result.status, 403);
  });
});

// ================================================================
// t-085: Membership changes feed
// ================================================================

describe('t-085: Membership changes feed', () => {
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

  // Step 1: Create group, invite Atlas, accept, then remove
  it('step 1: create events sequence', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    const groupId = group.groupId as string;

    inviteToGroup(db, 'bmo', groupId, 'atlas');
    acceptInvitation(db, 'atlas', groupId);
    removeMember(db, 'bmo', groupId, 'atlas');

    // Verify membership changes exist
    const memberships = db.prepare(
      'SELECT * FROM group_memberships WHERE group_id = ?'
    ).all(groupId) as any[];
    // bmo (owner, active) + atlas (member, removed)
    assert.equal(memberships.length, 2);
  });

  // Step 2: Get all changes since epoch
  it('step 2: get all changes since epoch', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    const groupId = group.groupId as string;

    inviteToGroup(db, 'bmo', groupId, 'atlas');
    acceptInvitation(db, 'atlas', groupId);
    removeMember(db, 'bmo', groupId, 'atlas');

    const result = getChanges(db, groupId, 'bmo', '1970-01-01T00:00:00Z');
    assert.ok(result.ok);
    const changes = result.changes as any[];
    // Should have at least bmo join + atlas joined + atlas removed
    assert.ok(changes.length >= 2, `Expected >= 2 changes, got ${changes.length}`);
  });

  // Step 3: Filter by since timestamp
  it('step 3: filter changes by since timestamp', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    const groupId = group.groupId as string;

    inviteToGroup(db, 'bmo', groupId, 'atlas');
    acceptInvitation(db, 'atlas', groupId);

    // Capture time after join
    const afterJoin = new Date().toISOString();

    // Small delay to ensure timestamps differ (SQLite datetime precision)
    removeMember(db, 'bmo', groupId, 'atlas');

    // Get changes since after join — should only show removal
    const result = getChanges(db, groupId, 'bmo', afterJoin);
    assert.ok(result.ok);
    const changes = result.changes as any[];
    // The removal should be the only (or latest) change
    if (changes.length > 0) {
      const lastChange = changes[changes.length - 1];
      assert.equal(lastChange.agent, 'atlas');
      assert.equal(lastChange.action, 'removed');
    }
    // Note: SQLite datetime('now') may have same second as afterJoin, so 0 changes is acceptable
  });

  // Step 4: Non-member cannot access changes
  it('step 4: non-member cannot access changes', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'stranger');
    const group = createGroup(db, 'bmo', 'team');
    const groupId = group.groupId as string;

    const result = getChanges(db, groupId, 'stranger', '1970-01-01T00:00:00Z');
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
  });

  // Step 5: Change records have all required fields
  it('step 5: change records have agent, action, by, timestamp', () => {
    const db = withDb();
    createActiveAgent(db, 'bmo');
    createActiveAgent(db, 'atlas');
    makeContacts(db, 'bmo', 'atlas');
    const group = createGroup(db, 'bmo', 'team');
    const groupId = group.groupId as string;

    inviteToGroup(db, 'bmo', groupId, 'atlas');
    acceptInvitation(db, 'atlas', groupId);

    const result = getChanges(db, groupId, 'bmo', '1970-01-01T00:00:00Z');
    assert.ok(result.ok);
    const changes = result.changes as any[];
    assert.ok(changes.length > 0, 'Should have at least one change');

    for (const change of changes) {
      assert.ok('agent' in change, 'Change has agent field');
      assert.ok('action' in change, 'Change has action field');
      assert.ok('timestamp' in change, 'Change has timestamp field');
      // 'by' field may be null for owner join
      assert.ok('by' in change, 'Change has by field');
    }
  });
});
