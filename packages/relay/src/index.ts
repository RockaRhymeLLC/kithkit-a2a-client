/**
 * CC4Me Network Relay — identity, presence, and contacts server.
 *
 * The relay knows WHO is on the network but never sees WHAT they say.
 * Zero message content is ever stored or routed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { initializeDatabase, getDb, closeDb } from './db.js';
import { authenticateRequest } from './auth.js';
import {
  registerAgent,
  listAgents,
  getAgent,
  approveAgent,
  revokeAgent,
} from './routes/registry.js';
import {
  requestContact,
  listPendingRequests,
  acceptContact,
  denyContact,
  removeContact,
  listContacts,
} from './routes/contacts.js';
import {
  updatePresence,
  getPresence,
  batchPresence,
} from './routes/presence.js';
import {
  listPendingRegistrations,
  listAdminKeys,
  createBroadcast,
  listBroadcasts,
} from './routes/admin.js';
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
  transferOwnership,
} from './routes/groups.js';
import { v1Send, v1Inbox, v1Ack, isSunset } from './routes/v1-compat.js';
import { handleVerifySend, handleVerifyConfirm } from './routes/verify.js';
import { sesSender } from './ses-sender.js';
import type { EmailSender } from './email.js';

// Email sender — use SES in production, can be overridden via env
const emailSender: EmailSender = sesSender;

const PORT = parseInt(process.env.PORT || '8080', 10);
const DB_PATH = process.env.DB_PATH || './data/relay.db';

// v1 compat sunset: 30 days from deployment
const V1_SUNSET = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/** Read full request body as string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Send JSON response. */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Parse URL path params. Returns null if pattern doesn't match. */
function matchPath(
  pattern: string,
  actual: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  if (patternParts.length !== actualParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = actualParts[i];
    } else if (patternParts[i] !== actualParts[i]) {
      return null;
    }
  }
  return params;
}

/** Check if an authenticated agent is an admin. */
function isAdmin(agent: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT agent FROM admins WHERE agent = ?')
    .get(agent) as { agent: string } | undefined;
  return !!row;
}

const server = createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', `http://localhost:${PORT}`);
    const path = urlObj.pathname;
    const method = req.method || 'GET';

    // Health check
    if (path === '/health' && method === 'GET') {
      return json(res, 200, { status: 'ok', version: '2.0' });
    }

    const db = getDb();
    const body = ['POST', 'PUT', 'DELETE'].includes(method)
      ? await readBody(req)
      : '';

    // --- Helper: authenticate request ---
    const auth = () =>
      authenticateRequest(
        db,
        method,
        path,
        req.headers['x-timestamp'] as string || '',
        body,
        req.headers['authorization'] as string | undefined,
      );

    // --- Helper: parse JSON body ---
    const parseBody = () => {
      try {
        return body ? JSON.parse(body) : {};
      } catch {
        return null;
      }
    };

    // ==========================================================
    // VERIFICATION ROUTES (unauthenticated)
    // ==========================================================

    // POST /verify/send — request verification code
    if (path === '/verify/send' && method === 'POST') {
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim();
      const result = await handleVerifySend(db, data, emailSender, ip);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // POST /verify/confirm — submit verification code
    if (path === '/verify/confirm' && method === 'POST') {
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = handleVerifyConfirm(db, data);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // ==========================================================
    // REGISTRY ROUTES
    // ==========================================================

    // POST /registry/agents — register (unauthenticated, requires email verification)
    if (path === '/registry/agents' && method === 'POST') {
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = registerAgent(
        db,
        data.name,
        data.publicKey,
        data.ownerEmail,
        data.endpoint,
      );
      return json(res, result.status || (result.ok ? 201 : 400), result);
    }

    // GET /registry/agents — list all (public)
    if (path === '/registry/agents' && method === 'GET') {
      return json(res, 200, listAgents(db));
    }

    // GET /registry/agents/:name — get one (public)
    let params = matchPath('/registry/agents/:name', path);
    if (params && method === 'GET') {
      const agent = getAgent(db, params.name);
      return agent
        ? json(res, 200, agent)
        : json(res, 404, { error: 'Agent not found' });
    }

    // POST /registry/agents/:name/approve — admin only
    params = matchPath('/registry/agents/:name/approve', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = approveAgent(db, params.name, a.agent!);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // POST /registry/agents/:name/revoke — admin only
    params = matchPath('/registry/agents/:name/revoke', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = revokeAgent(db, params.name, a.agent!);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // ==========================================================
    // CONTACTS ROUTES
    // ==========================================================

    // POST /contacts/request — request a contact (authenticated)
    if (path === '/contacts/request' && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = requestContact(db, a.agent!, data.to, data.greeting);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // GET /contacts/pending — list pending requests (authenticated)
    if (path === '/contacts/pending' && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      return json(res, 200, listPendingRequests(db, a.agent!));
    }

    // GET /contacts — list contacts (authenticated)
    if (path === '/contacts' && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      return json(res, 200, listContacts(db, a.agent!));
    }

    // POST /contacts/:agent/accept — accept contact (authenticated)
    params = matchPath('/contacts/:agent/accept', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = acceptContact(db, a.agent!, params.agent);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // POST /contacts/:agent/deny — deny contact (authenticated)
    params = matchPath('/contacts/:agent/deny', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = denyContact(db, a.agent!, params.agent);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // DELETE /contacts/:agent — remove contact (authenticated)
    params = matchPath('/contacts/:agent', path);
    if (params && method === 'DELETE') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = removeContact(db, a.agent!, params.agent);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // ==========================================================
    // PRESENCE ROUTES
    // ==========================================================

    // PUT /presence — heartbeat (authenticated)
    if (path === '/presence' && method === 'PUT') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      const result = updatePresence(db, a.agent!, data?.endpoint);
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // GET /presence/batch — batch presence query (public)
    if (path === '/presence/batch' && method === 'GET') {
      const agentsParam = urlObj.searchParams.get('agents') || '';
      const agents = agentsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return json(res, 200, batchPresence(db, agents));
    }

    // GET /presence/:agent — single presence (public)
    params = matchPath('/presence/:agent', path);
    if (params && method === 'GET') {
      const info = getPresence(db, params.agent);
      return info
        ? json(res, 200, info)
        : json(res, 404, { error: 'Agent not found' });
    }

    // ==========================================================
    // ADMIN ROUTES
    // ==========================================================

    // GET /admin/pending — list pending registrations (admin only)
    if (path === '/admin/pending' && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      if (!isAdmin(a.agent!))
        return json(res, 403, { error: 'Not an admin' });
      return json(res, 200, listPendingRegistrations(db));
    }

    // GET /admin/keys — list admin keys (public)
    if (path === '/admin/keys' && method === 'GET') {
      return json(res, 200, listAdminKeys(db));
    }

    // POST /admin/broadcast — create broadcast (admin only)
    if (path === '/admin/broadcast' && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = createBroadcast(
        db,
        a.agent!,
        data.type,
        data.payload,
        data.signature,
      );
      return json(res, result.status || (result.ok ? 201 : 400), result);
    }

    // GET /admin/broadcasts — list broadcasts (authenticated)
    if ((path === '/admin/broadcasts' || path.startsWith('/admin/broadcasts?')) && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const type = urlObj.searchParams.get('type') || undefined;
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      return json(res, 200, listBroadcasts(db, type, limit));
    }

    // ==========================================================
    // GROUP ROUTES
    // ==========================================================

    // GET /groups/invitations — list pending invitations (must be before /groups/:groupId)
    if (path === '/groups/invitations' && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = listInvitations(db, a.agent!);
      return json(res, 200, result.invitations || []);
    }

    // POST /groups — create group
    if (path === '/groups' && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = createGroup(db, a.agent!, data.name, data.settings);
      return json(res, result.status === 201 ? 201 : (typeof result.status === 'number' ? result.status : 400), result);
    }

    // GET /groups — list caller's groups
    if (path === '/groups' && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = listGroups(db, a.agent!);
      return json(res, 200, result.groups || []);
    }

    // POST /groups/:groupId/invite
    params = matchPath('/groups/:groupId/invite', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = inviteToGroup(db, a.agent!, params.groupId, data.agent, data.greeting);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // POST /groups/:groupId/accept
    params = matchPath('/groups/:groupId/accept', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = acceptInvitation(db, a.agent!, params.groupId);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // POST /groups/:groupId/decline
    params = matchPath('/groups/:groupId/decline', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = declineInvitation(db, a.agent!, params.groupId);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // POST /groups/:groupId/leave
    params = matchPath('/groups/:groupId/leave', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = leaveGroup(db, a.agent!, params.groupId);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // POST /groups/:groupId/transfer
    params = matchPath('/groups/:groupId/transfer', path);
    if (params && method === 'POST') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = transferOwnership(db, a.agent!, params.groupId, data.newOwner);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // GET /groups/:groupId/members
    params = matchPath('/groups/:groupId/members', path);
    if (params && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = listMembers(db, params.groupId, a.agent!);
      if (!result.ok) return json(res, typeof result.status === 'number' ? result.status : 403, { error: result.error });
      return json(res, 200, result.members || []);
    }

    // GET /groups/:groupId/changes
    params = matchPath('/groups/:groupId/changes', path);
    if (params && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const since = urlObj.searchParams.get('since') || '1970-01-01T00:00:00Z';
      const result = getChanges(db, params.groupId, a.agent!, since);
      if (!result.ok) return json(res, typeof result.status === 'number' ? result.status : 403, { error: result.error });
      return json(res, 200, result.changes || []);
    }

    // DELETE /groups/:groupId/members/:agent — remove member
    params = matchPath('/groups/:groupId/members/:agent', path);
    if (params && method === 'DELETE') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = removeMember(db, a.agent!, params.groupId, params.agent);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // DELETE /groups/:groupId — dissolve group
    params = matchPath('/groups/:groupId', path);
    if (params && method === 'DELETE') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = dissolveGroup(db, a.agent!, params.groupId);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // GET /groups/:groupId — get group details
    params = matchPath('/groups/:groupId', path);
    if (params && method === 'GET') {
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const result = getGroupDetails(db, params.groupId, a.agent!);
      return json(res, typeof result.status === 'number' ? result.status : 200, result);
    }

    // ==========================================================
    // V1 COMPAT ROUTES (deprecated, 30-day sunset)
    // ==========================================================

    if (path === '/relay/send' && method === 'POST') {
      if (isSunset(V1_SUNSET)) return json(res, 410, { error: 'v1 API sunset — use v2' });
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = v1Send(db, data, a.agent!, V1_SUNSET);
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', V1_SUNSET.toUTCString());
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    params = matchPath('/relay/inbox/:agent', path);
    if (params && method === 'GET') {
      if (isSunset(V1_SUNSET)) return json(res, 410, { error: 'v1 API sunset — use v2' });
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      if (a.agent !== params.agent) return json(res, 403, { error: 'Forbidden' });
      const result = v1Inbox(db, params.agent, V1_SUNSET);
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', V1_SUNSET.toUTCString());
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    params = matchPath('/relay/inbox/:agent/ack', path);
    if (params && method === 'POST') {
      if (isSunset(V1_SUNSET)) return json(res, 410, { error: 'v1 API sunset — use v2' });
      const a = auth();
      if (!a.ok) return json(res, a.status || 401, { error: a.error });
      if (a.agent !== params.agent) return json(res, 403, { error: 'Forbidden' });
      const data = parseBody();
      if (!data) return json(res, 400, { error: 'Invalid JSON' });
      const result = v1Ack(db, params.agent, data.messageIds || [], V1_SUNSET);
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', V1_SUNSET.toUTCString());
      return json(res, result.status || (result.ok ? 200 : 400), result);
    }

    // ==========================================================
    // 404
    // ==========================================================
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Request error:', err);
    json(res, 500, { error: 'Internal server error' });
  }
});

// Initialize database and start server
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))
) {
  const db = initializeDatabase(DB_PATH);
  console.log(`Database initialized at ${DB_PATH}`);

  server.listen(PORT, () => {
    console.log(`CC4Me Relay v2 listening on :${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close();
    closeDb();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    server.close();
    closeDb();
    process.exit(0);
  });
}

export { server };
