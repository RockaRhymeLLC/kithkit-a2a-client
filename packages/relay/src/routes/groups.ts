/**
 * Group lifecycle routes — create, invite, accept/decline, leave, remove, dissolve, list.
 *
 * POST   /groups                         — Create group (R-01)
 * GET    /groups/:groupId                — Get group details (R-02)
 * POST   /groups/:groupId/invite         — Invite to group (R-03)
 * POST   /groups/:groupId/accept         — Accept invitation (R-04)
 * POST   /groups/:groupId/decline        — Decline invitation (R-04)
 * POST   /groups/:groupId/leave          — Leave group (R-05)
 * DELETE /groups/:groupId/members/:agent — Remove member (R-05)
 * DELETE /groups/:groupId                — Dissolve group (R-05)
 * GET    /groups                         — List caller's groups (R-06)
 * GET    /groups/:groupId/members        — List members (R-06)
 * GET    /groups/invitations             — List pending invitations (R-06)
 * GET    /groups/:groupId/changes        — Membership changes feed (R-07)
 *
 * The relay manages group metadata. Message content never touches the relay.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** Max group name length. */
const MAX_NAME_LENGTH = 64;

/** Max greeting length for invitations. */
const MAX_GREETING_LENGTH = 500;

/** Max groups per agent. */
const MAX_GROUPS_PER_AGENT = 100;

/** Owner inactivity threshold for admin dissolution (7 days). */
const OWNER_OFFLINE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupResult {
  ok: boolean;
  status?: number | string;
  error?: string;
  [key: string]: unknown;
}

// ================================================================
// Helpers
// ================================================================

/** Check if agent is an active registered agent. */
function isActiveAgent(db: Database.Database, name: string): boolean {
  const row = db.prepare(
    "SELECT status FROM agents WHERE name = ? AND status = 'active'"
  ).get(name) as { status: string } | undefined;
  return !!row;
}

/** Check if two agents are mutual contacts (status = 'active'). */
function areMutualContacts(db: Database.Database, a: string, b: string): boolean {
  const [agent_a, agent_b] = a < b ? [a, b] : [b, a];
  const row = db.prepare(
    "SELECT status FROM contacts WHERE agent_a = ? AND agent_b = ? AND status = 'active'"
  ).get(agent_a, agent_b) as { status: string } | undefined;
  return !!row;
}

/** Get a membership record. */
function getMembership(db: Database.Database, groupId: string, agent: string) {
  return db.prepare(
    'SELECT * FROM group_memberships WHERE group_id = ? AND agent = ?'
  ).get(groupId, agent) as {
    group_id: string; agent: string; role: string; status: string;
    invited_by: string | null; greeting: string | null;
    joined_at: string | null; left_at: string | null; created_at: string;
  } | undefined;
}

/** Get group record by ID. */
function getGroup(db: Database.Database, groupId: string) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as {
    id: string; name: string; owner: string; status: string;
    members_can_invite: number; members_can_send: number;
    max_members: number; created_at: string; dissolved_at: string | null;
  } | undefined;
}

/** Count active members in a group. */
function activeMembers(db: Database.Database, groupId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM group_memberships WHERE group_id = ? AND status = 'active'"
  ).get(groupId) as { count: number };
  return row.count;
}

/** Count how many groups an agent is actively in (as active member). */
function agentGroupCount(db: Database.Database, agent: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM group_memberships WHERE agent = ? AND status = 'active'"
  ).get(agent) as { count: number };
  return row.count;
}

// ================================================================
// R-01: Create group
// ================================================================

export function createGroup(
  db: Database.Database,
  owner: string,
  name: string,
  settings?: { membersCanInvite?: boolean; membersCanSend?: boolean; maxMembers?: number },
): GroupResult {
  if (!isActiveAgent(db, owner)) {
    return { ok: false, status: 403, error: 'Agent not active' };
  }

  if (!name || typeof name !== 'string' || name.length === 0) {
    return { ok: false, status: 400, error: 'Group name is required' };
  }

  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, status: 400, error: `Group name too long (max ${MAX_NAME_LENGTH} chars)` };
  }

  if (agentGroupCount(db, owner) >= MAX_GROUPS_PER_AGENT) {
    return { ok: false, status: 400, error: `Max ${MAX_GROUPS_PER_AGENT} groups per agent` };
  }

  const groupId = randomUUID();
  const membersCanInvite = settings?.membersCanInvite ? 1 : 0;
  const membersCanSend = settings?.membersCanSend !== false ? 1 : 0;
  const maxMembers = Math.min(settings?.maxMembers || 50, 50);

  db.prepare(
    `INSERT INTO groups (id, name, owner, members_can_invite, members_can_send, max_members)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(groupId, name, owner, membersCanInvite, membersCanSend, maxMembers);

  // Owner auto-joins as owner role, active status
  db.prepare(
    `INSERT INTO group_memberships (group_id, agent, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', datetime('now'))`
  ).run(groupId, owner);

  const group = getGroup(db, groupId)!;

  return {
    ok: true,
    status: 201,
    groupId,
    name: group.name,
    owner: group.owner,
    settings: {
      membersCanInvite: !!group.members_can_invite,
      membersCanSend: !!group.members_can_send,
      maxMembers: group.max_members,
    },
    createdAt: group.created_at,
  };
}

// ================================================================
// R-02: Get group details
// ================================================================

export function getGroupDetails(
  db: Database.Database,
  groupId: string,
  caller: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group) {
    return { ok: false, status: 404, error: 'Group not found' };
  }

  // Only active members can view group details
  const membership = getMembership(db, groupId, caller);
  if (!membership || membership.status !== 'active') {
    return { ok: false, status: 403, error: 'Not a member of this group' };
  }

  const memberCount = activeMembers(db, groupId);

  return {
    ok: true,
    groupId: group.id,
    name: group.name,
    owner: group.owner,
    status: group.status,
    settings: {
      membersCanInvite: !!group.members_can_invite,
      membersCanSend: !!group.members_can_send,
      maxMembers: group.max_members,
    },
    memberCount,
    createdAt: group.created_at,
    dissolvedAt: group.dissolved_at,
  };
}

// ================================================================
// R-03: Invite to group
// ================================================================

export function inviteToGroup(
  db: Database.Database,
  caller: string,
  groupId: string,
  invitee: string,
  greeting?: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or dissolved' };
  }

  // Caller must be an active member
  const callerMembership = getMembership(db, groupId, caller);
  if (!callerMembership || callerMembership.status !== 'active') {
    return { ok: false, status: 403, error: 'Not a member of this group' };
  }

  // Permission check: owner/admin can always invite, members only if setting allows
  if (callerMembership.role === 'member' && !group.members_can_invite) {
    return { ok: false, status: 403, error: 'Members cannot invite to this group' };
  }

  // Invitee must be an active agent
  if (!isActiveAgent(db, invitee)) {
    return { ok: false, status: 404, error: 'Invitee not found or not active' };
  }

  // Mutual contact check
  if (!areMutualContacts(db, caller, invitee)) {
    return { ok: false, status: 403, error: 'Must be mutual contacts to invite' };
  }

  // Check if already a member
  const existingMembership = getMembership(db, groupId, invitee);
  if (existingMembership) {
    if (existingMembership.status === 'active') {
      return { ok: false, status: 409, error: 'Already a member' };
    }
    if (existingMembership.status === 'pending') {
      return { ok: false, status: 409, error: 'Invitation already pending' };
    }
    // If left or removed, allow re-invite by deleting old row
    db.prepare(
      'DELETE FROM group_memberships WHERE group_id = ? AND agent = ?'
    ).run(groupId, invitee);
  }

  // Check max members
  if (activeMembers(db, groupId) >= group.max_members) {
    return { ok: false, status: 400, error: 'Group is full' };
  }

  // Validate greeting
  if (greeting && greeting.length > MAX_GREETING_LENGTH) {
    return { ok: false, status: 400, error: `Greeting too long (max ${MAX_GREETING_LENGTH} chars)` };
  }

  db.prepare(
    `INSERT INTO group_memberships (group_id, agent, role, status, invited_by, greeting)
     VALUES (?, ?, 'member', 'pending', ?, ?)`
  ).run(groupId, invitee, caller, greeting || null);

  return { ok: true, status: 'invited' };
}

// ================================================================
// R-04: Accept / Decline invitation
// ================================================================

export function acceptInvitation(
  db: Database.Database,
  caller: string,
  groupId: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or dissolved' };
  }

  const membership = getMembership(db, groupId, caller);
  if (!membership || membership.status !== 'pending') {
    return { ok: false, status: 404, error: 'No pending invitation' };
  }

  db.prepare(
    `UPDATE group_memberships SET status = 'active', joined_at = datetime('now')
     WHERE group_id = ? AND agent = ?`
  ).run(groupId, caller);

  return { ok: true, status: 'accepted' };
}

export function declineInvitation(
  db: Database.Database,
  caller: string,
  groupId: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or dissolved' };
  }

  const membership = getMembership(db, groupId, caller);
  if (!membership || membership.status !== 'pending') {
    return { ok: false, status: 404, error: 'No pending invitation' };
  }

  // Remove the pending invitation entirely
  db.prepare(
    'DELETE FROM group_memberships WHERE group_id = ? AND agent = ?'
  ).run(groupId, caller);

  return { ok: true, status: 'declined' };
}

// ================================================================
// R-05: Leave / Remove / Dissolve
// ================================================================

export function leaveGroup(
  db: Database.Database,
  caller: string,
  groupId: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or dissolved' };
  }

  const membership = getMembership(db, groupId, caller);
  if (!membership || membership.status !== 'active') {
    return { ok: false, status: 404, error: 'Not an active member' };
  }

  // Owner cannot leave — must dissolve or transfer
  if (membership.role === 'owner') {
    return { ok: false, status: 400, error: 'Owner cannot leave. Dissolve the group or transfer ownership.' };
  }

  db.prepare(
    `UPDATE group_memberships SET status = 'left', left_at = datetime('now')
     WHERE group_id = ? AND agent = ?`
  ).run(groupId, caller);

  return { ok: true, status: 'left' };
}

export function removeMember(
  db: Database.Database,
  caller: string,
  groupId: string,
  targetAgent: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or dissolved' };
  }

  const callerMembership = getMembership(db, groupId, caller);
  if (!callerMembership || callerMembership.status !== 'active') {
    return { ok: false, status: 403, error: 'Not a member' };
  }

  // Only owner or admin can remove
  if (callerMembership.role !== 'owner' && callerMembership.role !== 'admin') {
    return { ok: false, status: 403, error: 'Only owner or admin can remove members' };
  }

  const targetMembership = getMembership(db, groupId, targetAgent);
  if (!targetMembership || targetMembership.status !== 'active') {
    return { ok: false, status: 404, error: 'Target is not an active member' };
  }

  // Can't remove the owner
  if (targetMembership.role === 'owner') {
    return { ok: false, status: 403, error: 'Cannot remove the owner' };
  }

  // Admin can't remove another admin (only owner can)
  if (targetMembership.role === 'admin' && callerMembership.role !== 'owner') {
    return { ok: false, status: 403, error: 'Only the owner can remove admins' };
  }

  db.prepare(
    `UPDATE group_memberships SET status = 'removed', left_at = datetime('now')
     WHERE group_id = ? AND agent = ?`
  ).run(groupId, targetAgent);

  return { ok: true, status: 'removed' };
}

export function dissolveGroup(
  db: Database.Database,
  caller: string,
  groupId: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or already dissolved' };
  }

  const callerMembership = getMembership(db, groupId, caller);
  if (!callerMembership || callerMembership.status !== 'active') {
    return { ok: false, status: 403, error: 'Not a member' };
  }

  if (callerMembership.role === 'owner') {
    // Owner can always dissolve
  } else if (callerMembership.role === 'admin') {
    // Admin can dissolve only if owner is offline > 7 days
    const ownerAgent = db.prepare(
      'SELECT last_seen FROM agents WHERE name = ?'
    ).get(group.owner) as { last_seen: string | null } | undefined;

    const lastSeen = ownerAgent?.last_seen ? new Date(ownerAgent.last_seen).getTime() : 0;
    const offlineDuration = Date.now() - lastSeen;

    if (offlineDuration < OWNER_OFFLINE_THRESHOLD_MS) {
      return { ok: false, status: 403, error: 'Owner still reachable. Only owner can dissolve, or admin after 7 days of owner absence.' };
    }
  } else {
    return { ok: false, status: 403, error: 'Only owner or admin can dissolve a group' };
  }

  // Dissolve: update group status, set all active memberships to left
  db.prepare(
    `UPDATE groups SET status = 'dissolved', dissolved_at = datetime('now') WHERE id = ?`
  ).run(groupId);

  db.prepare(
    `UPDATE group_memberships SET status = 'left', left_at = datetime('now')
     WHERE group_id = ? AND status IN ('active', 'pending')`
  ).run(groupId);

  return { ok: true, status: 'dissolved' };
}

// ================================================================
// R-06: List groups / members / invitations
// ================================================================

export function listGroups(
  db: Database.Database,
  caller: string,
): GroupResult {
  const rows = db.prepare(
    `SELECT g.id, g.name, g.owner, g.status, g.created_at, gm.role
     FROM group_memberships gm
     JOIN groups g ON g.id = gm.group_id
     WHERE gm.agent = ? AND gm.status = 'active'
     ORDER BY g.created_at DESC`
  ).all(caller) as Array<{
    id: string; name: string; owner: string; status: string;
    created_at: string; role: string;
  }>;

  return {
    ok: true,
    groups: rows.map(r => ({
      groupId: r.id,
      name: r.name,
      owner: r.owner,
      status: r.status,
      role: r.role,
      createdAt: r.created_at,
    })),
  };
}

export function listMembers(
  db: Database.Database,
  groupId: string,
  caller: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group) {
    return { ok: false, status: 404, error: 'Group not found' };
  }

  // Only active members can list members
  const callerMembership = getMembership(db, groupId, caller);
  if (!callerMembership || callerMembership.status !== 'active') {
    return { ok: false, status: 403, error: 'Not a member of this group' };
  }

  const rows = db.prepare(
    `SELECT agent, role, status, joined_at
     FROM group_memberships
     WHERE group_id = ? AND status = 'active'
     ORDER BY role, agent`
  ).all(groupId) as Array<{
    agent: string; role: string; status: string; joined_at: string;
  }>;

  return {
    ok: true,
    members: rows.map(r => ({
      agent: r.agent,
      role: r.role,
      joinedAt: r.joined_at,
    })),
  };
}

export function listInvitations(
  db: Database.Database,
  caller: string,
): GroupResult {
  const rows = db.prepare(
    `SELECT gm.group_id, g.name, gm.invited_by, gm.greeting, gm.created_at
     FROM group_memberships gm
     JOIN groups g ON g.id = gm.group_id
     WHERE gm.agent = ? AND gm.status = 'pending' AND g.status = 'active'
     ORDER BY gm.created_at ASC`
  ).all(caller) as Array<{
    group_id: string; name: string; invited_by: string;
    greeting: string | null; created_at: string;
  }>;

  return {
    ok: true,
    invitations: rows.map(r => ({
      groupId: r.group_id,
      groupName: r.name,
      invitedBy: r.invited_by,
      greeting: r.greeting,
      createdAt: r.created_at,
    })),
  };
}

// ================================================================
// R-07: Membership changes feed
// ================================================================

export function getChanges(
  db: Database.Database,
  groupId: string,
  caller: string,
  since: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group) {
    return { ok: false, status: 404, error: 'Group not found' };
  }

  // Must be a member (current or former) to see changes
  const callerMembership = getMembership(db, groupId, caller);
  if (!callerMembership) {
    return { ok: false, status: 403, error: 'Not a member of this group' };
  }

  // Return membership changes since the given timestamp
  // We track changes via joined_at/left_at/created_at columns
  const rows = db.prepare(
    `SELECT agent, role, status, invited_by, joined_at, left_at, created_at
     FROM group_memberships
     WHERE group_id = ?
       AND (
         (joined_at IS NOT NULL AND joined_at > ?)
         OR (left_at IS NOT NULL AND left_at > ?)
         OR (created_at > ?)
       )
     ORDER BY COALESCE(left_at, joined_at, created_at) ASC`
  ).all(groupId, since, since, since) as Array<{
    agent: string; role: string; status: string; invited_by: string | null;
    joined_at: string | null; left_at: string | null; created_at: string;
  }>;

  const changes = rows.map(r => {
    let action: string;
    let timestamp: string;
    if (r.left_at && r.left_at > since) {
      action = r.status === 'removed' ? 'removed' : 'left';
      timestamp = r.left_at;
    } else if (r.joined_at && r.joined_at > since) {
      action = 'joined';
      timestamp = r.joined_at;
    } else {
      action = 'invited';
      timestamp = r.created_at;
    }

    return {
      agent: r.agent,
      action,
      by: r.invited_by,
      timestamp,
    };
  });

  return { ok: true, changes };
}

// ================================================================
// Ownership transfer (R-05 bonus)
// ================================================================

export function transferOwnership(
  db: Database.Database,
  caller: string,
  groupId: string,
  newOwner: string,
): GroupResult {
  const group = getGroup(db, groupId);
  if (!group || group.status !== 'active') {
    return { ok: false, status: 404, error: 'Group not found or dissolved' };
  }

  const callerMembership = getMembership(db, groupId, caller);
  if (!callerMembership || callerMembership.role !== 'owner') {
    return { ok: false, status: 403, error: 'Only the owner can transfer ownership' };
  }

  const targetMembership = getMembership(db, groupId, newOwner);
  if (!targetMembership || targetMembership.status !== 'active') {
    return { ok: false, status: 404, error: 'New owner must be an active member' };
  }

  // Transfer: current owner becomes admin, new owner becomes owner
  db.prepare(
    `UPDATE group_memberships SET role = 'admin' WHERE group_id = ? AND agent = ?`
  ).run(groupId, caller);

  db.prepare(
    `UPDATE group_memberships SET role = 'owner' WHERE group_id = ? AND agent = ?`
  ).run(groupId, newOwner);

  db.prepare(
    `UPDATE groups SET owner = ? WHERE id = ?`
  ).run(newOwner, groupId);

  return { ok: true, status: 'transferred' };
}
