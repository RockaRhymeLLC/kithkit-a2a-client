/**
 * Relay API client — HTTP interface to the CC4Me relay server.
 *
 * Uses Ed25519 signature auth per the relay spec:
 *   Authorization: Signature <agent>:<base64_sig>
 *   X-Timestamp: <ISO-8601>
 *   Signing string: <METHOD> <PATH>\n<TIMESTAMP>\n<BODY_SHA256>
 */

import { createHash, sign as cryptoSign, type KeyObject } from 'node:crypto';

export interface RelayContact {
  agent: string;
  publicKey: string;
  endpoint: string | null;
  since: string;
}

export interface RelayPendingRequest {
  from: string;
  greeting: string | null;
  createdAt: string;
}

export interface RelayPresence {
  agent: string;
  online: boolean;
  endpoint: string | null;
  lastSeen: string | null;
}

export interface RelayBroadcast {
  id: string;
  type: string;
  payload: string;
  sender: string;
  signature: string;
  createdAt: string;
}

export interface RelayResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export interface RelayGroup {
  groupId: string;
  name: string;
  owner: string;
  status: string;
  role?: string;
  settings?: {
    membersCanInvite: boolean;
    membersCanSend: boolean;
    maxMembers: number;
  };
  memberCount?: number;
  createdAt: string;
}

export interface RelayGroupMember {
  agent: string;
  role: string;
  joinedAt: string;
}

export interface RelayGroupInvitation {
  groupId: string;
  groupName: string;
  invitedBy: string;
  greeting: string | null;
  createdAt: string;
}

export interface RelayGroupChange {
  agent: string;
  action: string;
  by: string | null;
  timestamp: string;
}

/**
 * Abstract relay API interface — injectable for testing.
 */
export interface IRelayAPI {
  // Contacts
  requestContact(toAgent: string, greeting?: string): Promise<RelayResponse>;
  acceptContact(agent: string): Promise<RelayResponse>;
  denyContact(agent: string): Promise<RelayResponse>;
  removeContact(agent: string): Promise<RelayResponse>;
  getContacts(): Promise<RelayResponse<RelayContact[]>>;
  getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>>;

  // Presence
  heartbeat(endpoint: string): Promise<RelayResponse>;
  getPresence(agent: string): Promise<RelayResponse<RelayPresence>>;
  batchPresence(agents: string[]): Promise<RelayResponse<RelayPresence[]>>;

  // Admin
  createBroadcast(type: string, payload: string, signature: string): Promise<RelayResponse<{ broadcastId: string }>>;
  listBroadcasts(type?: string): Promise<RelayResponse<RelayBroadcast[]>>;
  approveAgent(agent: string): Promise<RelayResponse>;
  revokeAgent(agent: string): Promise<RelayResponse>;

  // Groups
  createGroup(name: string, settings?: { membersCanInvite?: boolean; membersCanSend?: boolean; maxMembers?: number }): Promise<RelayResponse<RelayGroup>>;
  getGroup(groupId: string): Promise<RelayResponse<RelayGroup>>;
  inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<RelayResponse>;
  acceptGroupInvitation(groupId: string): Promise<RelayResponse>;
  declineGroupInvitation(groupId: string): Promise<RelayResponse>;
  leaveGroup(groupId: string): Promise<RelayResponse>;
  removeMember(groupId: string, agent: string): Promise<RelayResponse>;
  dissolveGroup(groupId: string): Promise<RelayResponse>;
  listGroups(): Promise<RelayResponse<RelayGroup[]>>;
  getGroupMembers(groupId: string): Promise<RelayResponse<RelayGroupMember[]>>;
  getGroupInvitations(): Promise<RelayResponse<RelayGroupInvitation[]>>;
  getGroupChanges(groupId: string, since: string): Promise<RelayResponse<RelayGroupChange[]>>;
  transferGroupOwnership(groupId: string, newOwner: string): Promise<RelayResponse>;
}

/**
 * Build the signing string for relay auth.
 */
function buildSigningString(method: string, path: string, timestamp: string, bodyHash: string): string {
  return `${method} ${path}\n${timestamp}\n${bodyHash}`;
}

/**
 * Hash body content with SHA-256.
 */
function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * HTTP-based relay API client.
 */
export class HttpRelayAPI implements IRelayAPI {
  constructor(
    private relayUrl: string,
    private username: string,
    private privateKey: KeyObject,
  ) {}

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<RelayResponse<T>> {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const bodyStr = body ? JSON.stringify(body) : '';
      const timestamp = new Date().toISOString();
      const bodyHash = hashBody(bodyStr);
      const signingString = buildSigningString(method, path, timestamp, bodyHash);
      const sig = cryptoSign(null, Buffer.from(signingString), this.privateKey);
      const authHeader = `Signature ${this.username}:${Buffer.from(sig).toString('base64')}`;

      const url = `${this.relayUrl}${path}`;
      const headers: Record<string, string> = {
        'Authorization': authHeader,
        'X-Timestamp': timestamp,
        'Connection': 'close',
      };
      if (bodyStr) headers['Content-Type'] = 'application/json';

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: bodyStr || undefined,
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let data: T;
        try {
          data = JSON.parse(text) as T;
        } catch {
          // Non-JSON response (e.g. Cloudflare challenge page) — retry
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
            continue;
          }
          return { ok: false, status: res.status, error: `Non-JSON response (${text.slice(0, 80)})` };
        }
        if (res.ok) {
          return { ok: true, status: res.status, data };
        }
        return { ok: false, status: res.status, error: (data as any)?.error || res.statusText };
      } catch (err: any) {
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        const detail = err.cause?.message ? ` (${err.cause.message})` : '';
        return { ok: false, status: 0, error: `${err.message}${detail}` };
      }
    }
    return { ok: false, status: 0, error: 'Max retries exceeded' };
  }

  async requestContact(toAgent: string, greeting?: string): Promise<RelayResponse> {
    return this.request('POST', '/contacts/request', { toAgent, greeting });
  }

  async acceptContact(agent: string): Promise<RelayResponse> {
    return this.request('POST', `/contacts/${agent}/accept`);
  }

  async denyContact(agent: string): Promise<RelayResponse> {
    return this.request('POST', `/contacts/${agent}/deny`);
  }

  async removeContact(agent: string): Promise<RelayResponse> {
    return this.request('DELETE', `/contacts/${agent}`);
  }

  async getContacts(): Promise<RelayResponse<RelayContact[]>> {
    return this.request<RelayContact[]>('GET', '/contacts');
  }

  async getPendingRequests(): Promise<RelayResponse<RelayPendingRequest[]>> {
    return this.request<RelayPendingRequest[]>('GET', '/contacts/pending');
  }

  async heartbeat(endpoint: string): Promise<RelayResponse> {
    return this.request('PUT', '/presence', { endpoint });
  }

  async getPresence(agent: string): Promise<RelayResponse<RelayPresence>> {
    return this.request<RelayPresence>('GET', `/presence/${agent}`);
  }

  async batchPresence(agents: string[]): Promise<RelayResponse<RelayPresence[]>> {
    return this.request<RelayPresence[]>('GET', `/presence/batch?agents=${agents.join(',')}`);
  }

  async createBroadcast(type: string, payload: string, signature: string): Promise<RelayResponse<{ broadcastId: string }>> {
    return this.request<{ broadcastId: string }>('POST', '/admin/broadcast', { type, payload, signature });
  }

  async listBroadcasts(type?: string): Promise<RelayResponse<RelayBroadcast[]>> {
    const path = type ? `/admin/broadcasts?type=${type}` : '/admin/broadcasts';
    return this.request<RelayBroadcast[]>('GET', path);
  }

  async approveAgent(agent: string): Promise<RelayResponse> {
    return this.request('POST', `/registry/agents/${agent}/approve`);
  }

  async revokeAgent(agent: string): Promise<RelayResponse> {
    return this.request('POST', `/registry/agents/${agent}/revoke`);
  }

  // Groups

  async createGroup(name: string, settings?: { membersCanInvite?: boolean; membersCanSend?: boolean; maxMembers?: number }): Promise<RelayResponse<RelayGroup>> {
    return this.request<RelayGroup>('POST', '/groups', { name, settings });
  }

  async getGroup(groupId: string): Promise<RelayResponse<RelayGroup>> {
    return this.request<RelayGroup>('GET', `/groups/${groupId}`);
  }

  async inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<RelayResponse> {
    return this.request('POST', `/groups/${groupId}/invite`, { agent, greeting });
  }

  async acceptGroupInvitation(groupId: string): Promise<RelayResponse> {
    return this.request('POST', `/groups/${groupId}/accept`);
  }

  async declineGroupInvitation(groupId: string): Promise<RelayResponse> {
    return this.request('POST', `/groups/${groupId}/decline`);
  }

  async leaveGroup(groupId: string): Promise<RelayResponse> {
    return this.request('POST', `/groups/${groupId}/leave`);
  }

  async removeMember(groupId: string, agent: string): Promise<RelayResponse> {
    return this.request('DELETE', `/groups/${groupId}/members/${agent}`);
  }

  async dissolveGroup(groupId: string): Promise<RelayResponse> {
    return this.request('DELETE', `/groups/${groupId}`);
  }

  async listGroups(): Promise<RelayResponse<RelayGroup[]>> {
    return this.request<RelayGroup[]>('GET', '/groups');
  }

  async getGroupMembers(groupId: string): Promise<RelayResponse<RelayGroupMember[]>> {
    return this.request<RelayGroupMember[]>('GET', `/groups/${groupId}/members`);
  }

  async getGroupInvitations(): Promise<RelayResponse<RelayGroupInvitation[]>> {
    return this.request<RelayGroupInvitation[]>('GET', '/groups/invitations');
  }

  async getGroupChanges(groupId: string, since: string): Promise<RelayResponse<RelayGroupChange[]>> {
    return this.request<RelayGroupChange[]>('GET', `/groups/${groupId}/changes?since=${encodeURIComponent(since)}`);
  }

  async transferGroupOwnership(groupId: string, newOwner: string): Promise<RelayResponse> {
    return this.request('POST', `/groups/${groupId}/transfer`, { newOwner });
  }
}
