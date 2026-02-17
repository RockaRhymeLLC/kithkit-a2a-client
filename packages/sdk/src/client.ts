/**
 * CC4MeNetwork — main SDK client.
 *
 * Handles contacts, presence, local cache, lifecycle, and P2P encrypted messaging.
 */

import { EventEmitter } from 'node:events';
import { createPrivateKey, randomUUID, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type {
  CC4MeNetworkOptions,
  SendResult,
  GroupSendResult,
  GroupMessage,
  Message,
  ContactRequest,
  Broadcast,
  DeliveryStatus,
  PresenceInfo,
  DeliveryReport,
  Contact,
  WireEnvelope,
} from './types.js';
import {
  HttpRelayAPI,
  type IRelayAPI,
  type RelayContact,
  type RelayBroadcast,
  type RelayGroup,
  type RelayGroupMember,
  type RelayGroupInvitation,
  type RelayGroupChange,
} from './relay-api.js';
import {
  loadCache,
  saveCache,
  getCachePath,
  type CacheData,
  type CachedContact,
} from './cache.js';
import { RetryQueue } from './retry.js';
import {
  buildEnvelope,
  processEnvelope,
  httpDeliver,
} from './messaging.js';

/** Delivery function signature: POST envelope to endpoint, return success. */
export type DeliverFn = (endpoint: string, envelope: WireEnvelope) => Promise<boolean>;

export interface GroupInvitationEvent {
  groupId: string;
  groupName: string;
  invitedBy: string;
  greeting: string | null;
}

export interface GroupMemberChangeEvent {
  groupId: string;
  agent: string;
  action: 'joined' | 'left' | 'removed' | 'invited' | 'ownership-transferred';
}

export interface CC4MeNetworkEvents {
  message: [msg: Message];
  'contact-request': [req: ContactRequest];
  broadcast: [broadcast: Broadcast];
  'delivery-status': [status: DeliveryStatus];
  'group-invitation': [invitation: GroupInvitationEvent];
  'group-member-change': [change: GroupMemberChangeEvent];
  'group-message': [msg: GroupMessage];
}

export interface CC4MeNetworkInternalOptions extends CC4MeNetworkOptions {
  /** Injectable relay API (for testing). If not provided, uses HttpRelayAPI. */
  relayAPI?: IRelayAPI;
  /** Injectable delivery function (for testing). If not provided, uses HTTP POST. */
  deliverFn?: DeliverFn;
  /** Custom retry delays in ms (for testing). Default: [10000, 30000, 90000]. */
  retryDelays?: number[];
  /** Custom retry process interval in ms (for testing). Default: 1000. */
  retryProcessInterval?: number;
}

export class CC4MeNetwork extends EventEmitter {
  private options: Required<CC4MeNetworkOptions>;
  private started = false;
  private relayAPI: IRelayAPI;
  private privateKeyObj: KeyObject;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cache: CacheData | null = null;
  private cachePath: string;
  private retryQueue: RetryQueue;
  private deliverFn: DeliverFn;
  private deliveryReports: Map<string, DeliveryReport> = new Map();
  private seenBroadcastIds: Set<string> = new Set();
  private seenContactRequestIds: Set<string> = new Set();
  private memberCache: Map<string, { members: RelayGroupMember[]; fetchedAt: number }> = new Map();
  private static MEMBER_CACHE_TTL = 60_000; // 60s staleness threshold
  private seenGroupMessageIds: Set<string> = new Set();
  private static MAX_SEEN_GROUP_MSG_IDS = 1000;

  constructor(options: CC4MeNetworkInternalOptions) {
    super();
    this.options = {
      dataDir: './cc4me-network-data',
      heartbeatInterval: 5 * 60 * 1000,
      retryQueueMax: 100,
      ...options,
    };
    this.cachePath = getCachePath(this.options.dataDir);

    // Convert Buffer (PKCS8 DER) to KeyObject
    this.privateKeyObj = createPrivateKey({
      key: Buffer.from(this.options.privateKey),
      format: 'der',
      type: 'pkcs8',
    });

    // Use injected relay API or create HTTP client
    this.relayAPI = options.relayAPI || new HttpRelayAPI(
      this.options.relayUrl,
      this.options.username,
      this.privateKeyObj,
    );

    // Delivery function: injectable for testing, defaults to HTTP POST
    this.deliverFn = options.deliverFn || httpDeliver;

    // Retry queue with configurable timing
    this.retryQueue = new RetryQueue(
      this.options.retryQueueMax,
      options.retryDelays,
      options.retryProcessInterval,
    );

    // Wire retry queue's send function with delivery tracking
    this.retryQueue.setSendFn(async (msg) => {
      const contact = this.getCachedContact(msg.recipient);
      if (!contact) return false;

      const startTime = Date.now();
      const presence = await this.checkPresence(msg.recipient);
      if (!presence.online) {
        this.recordAttempt(msg.messageId, presence.online, presence.endpoint || '', undefined, 'Recipient offline', Date.now() - startTime);
        return false;
      }

      const endpoint = presence.endpoint || contact.endpoint;
      if (!endpoint) return false;

      const envelope = buildEnvelope({
        sender: this.options.username,
        recipient: msg.recipient,
        payload: msg.payload,
        senderPrivateKey: this.privateKeyObj,
        recipientPublicKeyBase64: contact.publicKey,
        messageId: msg.messageId,
        type: msg.groupId ? 'group' : 'direct',
        groupId: msg.groupId,
      });

      const success = await this.deliverFn(endpoint, envelope);
      this.recordAttempt(msg.messageId, true, endpoint, success ? 200 : 0, success ? undefined : 'Delivery failed', Date.now() - startTime);
      if (success) this.finalizeReport(msg.messageId, 'delivered');
      return success;
    });

    // Forward retry queue delivery-status events
    this.retryQueue.on('delivery-status', (status: DeliveryStatus) => {
      this.emit('delivery-status', status);
    });
  }

  /** Start the network client (loads cache, begins heartbeat, starts retry queue). */
  async start(): Promise<void> {
    if (this.started) return;

    // Load local cache
    this.cache = loadCache(this.cachePath);

    // If no cache or cache was corrupt, try to populate from relay
    if (!this.cache) {
      await this.refreshContactsFromRelay();
    }

    // Send initial heartbeat
    await this.sendHeartbeat();

    // Start heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat().catch(() => { /* relay temporarily unreachable */ });
    }, this.options.heartbeatInterval);

    // Start retry queue processing
    this.retryQueue.start();

    this.started = true;
  }

  /** Stop the network client. */
  async stop(): Promise<void> {
    if (!this.started) return;

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Stop retry queue
    this.retryQueue.stop();

    // Flush cache
    if (this.cache) {
      saveCache(this.cachePath, this.cache);
    }

    this.started = false;
  }

  /** Whether the client is currently running. */
  get isStarted(): boolean {
    return this.started;
  }

  // --- Contacts ---

  async requestContact(username: string, greeting?: string): Promise<void> {
    const result = await this.relayAPI.requestContact(username, greeting);
    if (!result.ok) {
      throw new Error(result.error || `Failed to request contact: ${result.status}`);
    }
  }

  async getPendingRequests(): Promise<ContactRequest[]> {
    const result = await this.relayAPI.getPendingRequests();
    if (!result.ok) return [];
    return (result.data || []).map((r) => ({
      from: r.from,
      greeting: r.greeting || '',
      publicKey: '',
      ownerEmail: '',
    }));
  }

  async acceptContact(username: string): Promise<void> {
    const result = await this.relayAPI.acceptContact(username);
    if (!result.ok) {
      throw new Error(result.error || `Failed to accept contact: ${result.status}`);
    }
    // Refresh contacts cache
    await this.refreshContactsFromRelay();
  }

  async denyContact(username: string): Promise<void> {
    const result = await this.relayAPI.denyContact(username);
    if (!result.ok) {
      throw new Error(result.error || `Failed to deny contact: ${result.status}`);
    }
  }

  async removeContact(username: string): Promise<void> {
    const result = await this.relayAPI.removeContact(username);
    if (!result.ok) {
      throw new Error(result.error || `Failed to remove contact: ${result.status}`);
    }
    // Update cache
    if (this.cache) {
      this.cache.contacts = this.cache.contacts.filter((c) => c.username !== username);
      this.cache.lastUpdated = new Date().toISOString();
      saveCache(this.cachePath, this.cache);
    }
  }

  async getContacts(): Promise<Contact[]> {
    // Try relay first
    try {
      const result = await this.relayAPI.getContacts();
      if (result.ok && result.data) {
        this.updateContactsCache(result.data);
        return result.data.map(toContact);
      }
    } catch {
      // Relay unreachable — use cache
    }

    // Fall back to cache
    if (this.cache) {
      return this.cache.contacts.map((c) => ({
        username: c.username,
        publicKey: c.publicKey,
        endpoint: c.endpoint || '',
        addedAt: c.addedAt,
      }));
    }

    return [];
  }

  /** Get a contact from the local cache (no relay call). */
  getCachedContact(username: string): CachedContact | undefined {
    return this.cache?.contacts.find((c) => c.username === username);
  }

  // --- Presence ---

  async checkPresence(username: string): Promise<PresenceInfo> {
    try {
      const result = await this.relayAPI.getPresence(username);
      if (result.ok && result.data) {
        return {
          agent: result.data.agent,
          online: result.data.online,
          endpoint: result.data.endpoint || undefined,
          lastSeen: result.data.lastSeen || '',
        };
      }
    } catch {
      // Relay unreachable — return cached data if available
      const cached = this.getCachedContact(username);
      if (cached) {
        return {
          agent: username,
          online: false, // Can't confirm, assume offline
          endpoint: cached.endpoint || undefined,
          lastSeen: '',
        };
      }
    }

    return { agent: username, online: false, lastSeen: '' };
  }

  // --- Messaging ---

  /**
   * Send an encrypted message to a contact.
   *
   * Flow:
   * 1. Verify recipient is a contact
   * 2. Check presence — if offline, queue for retry
   * 3. Build encrypted envelope (X25519 ECDH + AES-256-GCM, Ed25519 signed)
   * 4. Deliver to recipient's endpoint
   * 5. If delivery fails, queue for retry
   */
  async send(to: string, payload: Record<string, unknown>): Promise<SendResult> {
    // Check: must be a contact
    let contact = this.getCachedContact(to);
    if (!contact) {
      // Try refreshing from relay
      await this.refreshContactsFromRelay();
      contact = this.getCachedContact(to);
      if (!contact) {
        return { status: 'failed', messageId: '', error: 'Not a contact' };
      }
    }

    if (!contact.publicKey) {
      return { status: 'failed', messageId: '', error: 'Contact has no public key' };
    }

    // Build encrypted, signed envelope
    const envelope = buildEnvelope({
      sender: this.options.username,
      recipient: to,
      payload,
      senderPrivateKey: this.privateKeyObj,
      recipientPublicKeyBase64: contact.publicKey,
    });

    // Initialize delivery report
    this.initReport(envelope.messageId);

    // Check presence
    const startTime = Date.now();
    const presence = await this.checkPresence(to);

    if (!presence.online) {
      this.recordAttempt(envelope.messageId, false, '', undefined, 'Recipient offline', Date.now() - startTime);
      // Offline — queue for retry
      const queued = this.retryQueue.enqueue(envelope.messageId, to, payload);
      if (queued) {
        return { status: 'queued', messageId: envelope.messageId };
      }
      this.finalizeReport(envelope.messageId, 'failed');
      return { status: 'failed', messageId: envelope.messageId, error: 'Retry queue full' };
    }

    // Online — try direct delivery
    const endpoint = presence.endpoint || contact.endpoint;
    if (!endpoint) {
      this.finalizeReport(envelope.messageId, 'failed');
      return { status: 'failed', messageId: envelope.messageId, error: 'No endpoint for recipient' };
    }

    const delivered = await this.deliverFn(endpoint, envelope);
    this.recordAttempt(envelope.messageId, true, endpoint, delivered ? 200 : 0, delivered ? undefined : 'Delivery failed', Date.now() - startTime);

    if (delivered) {
      this.finalizeReport(envelope.messageId, 'delivered');
      return { status: 'delivered', messageId: envelope.messageId };
    }

    // Delivery failed — queue for retry
    const queued = this.retryQueue.enqueue(envelope.messageId, to, payload);
    if (queued) {
      return { status: 'queued', messageId: envelope.messageId };
    }
    this.finalizeReport(envelope.messageId, 'failed');
    return { status: 'failed', messageId: envelope.messageId, error: 'Delivery failed and retry queue full' };
  }

  /**
   * Process an incoming message envelope.
   *
   * Verifies the sender is a contact, checks Ed25519 signature,
   * decrypts AES-256-GCM payload, and emits 'message' event.
   *
   * Returns null if the message is not addressed to this agent.
   * Throws on non-contact sender, invalid signature, or decryption failure.
   */
  receiveMessage(envelope: WireEnvelope): Message {
    // Validate it's addressed to us
    if (envelope.recipient !== this.options.username) {
      throw new Error(`Message not addressed to us (to: ${envelope.recipient})`);
    }

    // Check sender is a contact
    const contact = this.getCachedContact(envelope.sender);
    if (!contact) {
      throw new Error(`Sender '${envelope.sender}' is not a contact`);
    }

    if (!contact.publicKey) {
      throw new Error(`No public key for sender '${envelope.sender}'`);
    }

    // Verify signature + decrypt
    const processed = processEnvelope({
      envelope,
      recipientPrivateKey: this.privateKeyObj,
      senderPublicKeyBase64: contact.publicKey,
    });

    const msg: Message = {
      sender: processed.sender,
      messageId: processed.messageId,
      timestamp: processed.timestamp,
      payload: processed.payload,
      verified: processed.verified,
    };

    // Emit event
    this.emit('message', msg);

    return msg;
  }

  // --- Admin ---

  /**
   * Get an admin interface using the provided admin private key.
   * Admin ops require the caller to be registered as an admin on the relay.
   */
  asAdmin(adminPrivateKey: Buffer) {
    const adminKeyObj = createPrivateKey({
      key: adminPrivateKey,
      format: 'der',
      type: 'pkcs8',
    });
    const relayAPI = this.relayAPI;

    return {
      /**
       * Send a signed admin broadcast.
       * Payload is JSON-stringified and signed with the admin key.
       */
      broadcast: async (type: string, payload: Record<string, unknown>): Promise<void> => {
        const payloadStr = JSON.stringify(payload);
        const sig = cryptoSign(null, Buffer.from(payloadStr), adminKeyObj);
        const signatureBase64 = Buffer.from(sig).toString('base64');
        const result = await relayAPI.createBroadcast(type, payloadStr, signatureBase64);
        if (!result.ok) {
          throw new Error(result.error || 'Failed to create broadcast');
        }
      },

      /** Approve a pending agent registration. */
      approveAgent: async (name: string): Promise<void> => {
        const result = await relayAPI.approveAgent(name);
        if (!result.ok) {
          throw new Error(result.error || 'Failed to approve agent');
        }
      },

      /** Revoke an active agent. */
      revokeAgent: async (name: string): Promise<void> => {
        const result = await relayAPI.revokeAgent(name);
        if (!result.ok) {
          throw new Error(result.error || 'Failed to revoke agent');
        }
      },
    };
  }

  // --- Broadcasts ---

  /**
   * Check for new broadcasts from the relay.
   * Emits 'broadcast' event for each new broadcast found.
   * Returns the list of new broadcasts.
   */
  async checkBroadcasts(): Promise<Broadcast[]> {
    try {
      const result = await this.relayAPI.listBroadcasts();
      if (!result.ok || !result.data) return [];

      const newBroadcasts: Broadcast[] = [];
      for (const b of result.data) {
        if (this.seenBroadcastIds.has(b.id)) continue;
        this.seenBroadcastIds.add(b.id);

        const broadcast: Broadcast = {
          type: b.type,
          payload: safeParse(b.payload),
          sender: b.sender,
          verified: true, // Relay verified the signature on creation
        };
        newBroadcasts.push(broadcast);
        this.emit('broadcast', broadcast);
      }
      return newBroadcasts;
    } catch {
      return [];
    }
  }

  // --- Contact Request Events ---

  /**
   * Check for new contact requests and emit events.
   * Returns the list of new requests found.
   */
  async checkContactRequests(): Promise<ContactRequest[]> {
    const requests = await this.getPendingRequests();
    const newRequests: ContactRequest[] = [];

    for (const req of requests) {
      if (this.seenContactRequestIds.has(req.from)) continue;
      this.seenContactRequestIds.add(req.from);
      newRequests.push(req);
      this.emit('contact-request', req);
    }

    return newRequests;
  }

  // --- Groups ---

  /** Create a new group. Returns the group object with groupId. */
  async createGroup(name: string, settings?: { membersCanInvite?: boolean; membersCanSend?: boolean; maxMembers?: number }): Promise<RelayGroup> {
    const result = await this.relayAPI.createGroup(name, settings);
    if (!result.ok || !result.data) {
      throw new Error(result.error || 'Failed to create group');
    }
    return result.data;
  }

  /** Invite a contact to a group. */
  async inviteToGroup(groupId: string, agent: string, greeting?: string): Promise<void> {
    const result = await this.relayAPI.inviteToGroup(groupId, agent, greeting);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to invite to group');
    }
  }

  /** Accept a group invitation. */
  async acceptGroupInvitation(groupId: string): Promise<void> {
    const result = await this.relayAPI.acceptGroupInvitation(groupId);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to accept group invitation');
    }
  }

  /** Decline a group invitation. */
  async declineGroupInvitation(groupId: string): Promise<void> {
    const result = await this.relayAPI.declineGroupInvitation(groupId);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to decline group invitation');
    }
  }

  /** Leave a group. Owners must dissolve instead. */
  async leaveGroup(groupId: string): Promise<void> {
    const result = await this.relayAPI.leaveGroup(groupId);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to leave group');
    }
    this.emit('group-member-change', { groupId, agent: this.options.username, action: 'left' });
  }

  /** Remove a member from a group (owner/admin only). */
  async removeFromGroup(groupId: string, agent: string): Promise<void> {
    const result = await this.relayAPI.removeMember(groupId, agent);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to remove member');
    }
    this.emit('group-member-change', { groupId, agent, action: 'removed' });
  }

  /** Dissolve a group (owner, or admin if owner offline > 7 days). */
  async dissolveGroup(groupId: string): Promise<void> {
    const result = await this.relayAPI.dissolveGroup(groupId);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to dissolve group');
    }
  }

  /** List the caller's groups. */
  async getGroups(): Promise<RelayGroup[]> {
    const result = await this.relayAPI.listGroups();
    if (!result.ok) return [];
    return result.data || [];
  }

  /** List active members of a group. */
  async getGroupMembers(groupId: string): Promise<RelayGroupMember[]> {
    const result = await this.relayAPI.getGroupMembers(groupId);
    if (!result.ok) return [];
    return result.data || [];
  }

  /** List pending group invitations for the caller. */
  async getGroupInvitations(): Promise<RelayGroupInvitation[]> {
    const result = await this.relayAPI.getGroupInvitations();
    if (!result.ok) return [];
    return result.data || [];
  }

  /**
   * Check for new group invitations and emit events.
   * Returns new invitations found.
   */
  async checkGroupInvitations(): Promise<GroupInvitationEvent[]> {
    const invitations = await this.getGroupInvitations();
    const events: GroupInvitationEvent[] = [];
    for (const inv of invitations) {
      const event: GroupInvitationEvent = {
        groupId: inv.groupId,
        groupName: inv.groupName,
        invitedBy: inv.invitedBy,
        greeting: inv.greeting,
      };
      events.push(event);
      this.emit('group-invitation', event);
    }
    return events;
  }

  // --- Group Messaging ---

  /**
   * Send an encrypted message to all group members (fan-out).
   *
   * Each member receives an individually encrypted envelope (1:1 ECDH keys).
   * Deliveries happen in parallel (max 10 concurrent, 5s timeout each).
   * Failed deliveries are queued in the RetryQueue.
   */
  async sendToGroup(groupId: string, payload: Record<string, unknown>): Promise<GroupSendResult> {
    const messageId = randomUUID();
    const members = await this.getGroupMembersCached(groupId);
    const recipients = members.filter(m => m.agent !== this.options.username);

    const result: GroupSendResult = { messageId, delivered: [], queued: [], failed: [] };

    const deliverTo = async (member: RelayGroupMember) => {
      const contact = this.getCachedContact(member.agent);
      if (!contact?.publicKey) {
        result.failed.push(member.agent);
        return;
      }

      // Build per-member encrypted envelope with type='group'
      const envelope = buildEnvelope({
        sender: this.options.username,
        recipient: member.agent,
        payload,
        senderPrivateKey: this.privateKeyObj,
        recipientPublicKeyBase64: contact.publicKey,
        messageId,
        type: 'group',
        groupId,
      });

      // Check presence
      const presence = await this.checkPresence(member.agent);
      if (!presence.online) {
        const retryId = randomUUID();
        const enqueued = this.retryQueue.enqueue(retryId, member.agent, payload, groupId);
        if (enqueued) result.queued.push(member.agent);
        else result.failed.push(member.agent);
        return;
      }

      const endpoint = presence.endpoint || contact.endpoint;
      if (!endpoint) {
        result.failed.push(member.agent);
        return;
      }

      // Deliver with 5s timeout
      try {
        const success = await Promise.race([
          this.deliverFn(endpoint, envelope),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 5000)),
        ]);
        if (success) {
          result.delivered.push(member.agent);
        } else {
          const retryId = randomUUID();
          const enqueued = this.retryQueue.enqueue(retryId, member.agent, payload, groupId);
          if (enqueued) result.queued.push(member.agent);
          else result.failed.push(member.agent);
        }
      } catch {
        result.failed.push(member.agent);
      }
    };

    // Fan-out with concurrency limit
    await parallelLimit(recipients, 10, deliverTo);
    return result;
  }

  /**
   * Process an incoming group message envelope.
   *
   * Verifies the sender's Ed25519 signature, decrypts with pairwise ECDH key,
   * validates sender is a group member, and emits 'group-message' event.
   * Deduplicates based on messageId (last 1000 seen). Returns null for duplicates.
   * If sender is not in the member cache, refreshes from relay before rejecting.
   */
  async receiveGroupMessage(envelope: WireEnvelope): Promise<GroupMessage | null> {
    if (envelope.type !== 'group') {
      throw new Error('Not a group envelope');
    }
    if (!envelope.groupId) {
      throw new Error('Missing groupId');
    }
    if (envelope.recipient !== this.options.username) {
      throw new Error(`Message not addressed to us (to: ${envelope.recipient})`);
    }

    // Dedup: skip already-seen messageIds
    if (this.seenGroupMessageIds.has(envelope.messageId)) {
      return null;
    }

    // Check sender is a contact (needed for public key)
    const contact = this.getCachedContact(envelope.sender);
    if (!contact?.publicKey) {
      throw new Error(`No public key for sender '${envelope.sender}'`);
    }

    // Verify signature + decrypt (same crypto as direct messages)
    const processed = processEnvelope({
      envelope,
      recipientPrivateKey: this.privateKeyObj,
      senderPublicKeyBase64: contact.publicKey,
    });

    // Verify sender is a member of the group
    const cachedMembers = this.memberCache.get(envelope.groupId);
    const members = cachedMembers?.members;
    const isMember = members?.some(m => m.agent === envelope.sender);

    if (!isMember) {
      // Cache might be stale or missing — refresh from relay and check again
      const freshMembers = await this.getGroupMembers(envelope.groupId);
      this.memberCache.set(envelope.groupId, { members: freshMembers, fetchedAt: Date.now() });
      const isMemberNow = freshMembers.some(m => m.agent === envelope.sender);
      if (!isMemberNow) {
        throw new Error(`Sender '${envelope.sender}' is not a member of group ${envelope.groupId}`);
      }
    }

    // Track this messageId for dedup
    this.seenGroupMessageIds.add(envelope.messageId);
    if (this.seenGroupMessageIds.size > CC4MeNetwork.MAX_SEEN_GROUP_MSG_IDS) {
      const first = this.seenGroupMessageIds.values().next().value;
      if (first) this.seenGroupMessageIds.delete(first);
    }

    const msg: GroupMessage = {
      groupId: envelope.groupId,
      sender: processed.sender,
      messageId: processed.messageId,
      timestamp: processed.timestamp,
      payload: processed.payload,
      verified: processed.verified,
    };

    this.emit('group-message', msg);
    return msg;
  }

  /** Transfer group ownership to another active member. */
  async transferGroupOwnership(groupId: string, newOwner: string): Promise<void> {
    const result = await this.relayAPI.transferGroupOwnership(groupId, newOwner);
    if (!result.ok) {
      throw new Error(result.error || 'Failed to transfer ownership');
    }
    this.emit('group-member-change', { groupId, agent: newOwner, action: 'ownership-transferred' });
  }

  /** Get group members with local caching (60s staleness). */
  private async getGroupMembersCached(groupId: string): Promise<RelayGroupMember[]> {
    const cached = this.memberCache.get(groupId);
    if (cached && Date.now() - cached.fetchedAt < CC4MeNetwork.MEMBER_CACHE_TTL) {
      return cached.members;
    }
    const members = await this.getGroupMembers(groupId);
    this.memberCache.set(groupId, { members, fetchedAt: Date.now() });
    return members;
  }

  // --- Delivery Reports ---

  /**
   * Get diagnostic delivery report for a message.
   * Tracks all delivery attempts, presence checks, and final status.
   */
  getDeliveryReport(messageId: string): DeliveryReport | undefined {
    return this.deliveryReports.get(messageId);
  }

  // --- Internal ---

  /** Send a presence heartbeat to the relay. */
  private async sendHeartbeat(): Promise<void> {
    try {
      await this.relayAPI.heartbeat(this.options.endpoint);
    } catch {
      // Relay unreachable — will retry on next interval
    }
  }

  /** Refresh contacts list from relay and update cache. */
  private async refreshContactsFromRelay(): Promise<void> {
    try {
      const result = await this.relayAPI.getContacts();
      if (result.ok && result.data) {
        this.updateContactsCache(result.data);
      }
    } catch {
      // Relay unreachable — keep existing cache
    }
  }

  /** Initialize a delivery report for a message. */
  private initReport(messageId: string): void {
    this.deliveryReports.set(messageId, {
      messageId,
      attempts: [],
      finalStatus: 'failed',
    });
  }

  /** Record a delivery attempt. */
  private recordAttempt(
    messageId: string,
    presenceCheck: boolean,
    endpoint: string,
    httpStatus: number | undefined,
    error: string | undefined,
    durationMs: number,
  ): void {
    const report = this.deliveryReports.get(messageId);
    if (!report) return;
    report.attempts.push({
      timestamp: new Date().toISOString(),
      presenceCheck,
      endpoint,
      httpStatus,
      error,
      durationMs,
    });
  }

  /** Set the final status of a delivery report. */
  private finalizeReport(messageId: string, status: DeliveryReport['finalStatus']): void {
    const report = this.deliveryReports.get(messageId);
    if (report) report.finalStatus = status;
  }

  /** Update the local contacts cache. */
  private updateContactsCache(contacts: RelayContact[]): void {
    this.cache = {
      contacts: contacts.map((c) => ({
        username: c.agent,
        publicKey: c.publicKey,
        endpoint: c.endpoint,
        addedAt: c.since,
      })),
      lastUpdated: new Date().toISOString(),
    };
    saveCache(this.cachePath, this.cache);
  }
}

/** Convert a relay contact to the SDK Contact type. */
function toContact(rc: RelayContact): Contact {
  return {
    username: rc.agent,
    publicKey: rc.publicKey,
    endpoint: rc.endpoint || '',
    addedAt: rc.since,
  };
}

/** Safely parse a JSON string, returning empty object on failure. */
function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Execute async functions with a concurrency limit. */
async function parallelLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const executing: Set<Promise<void>> = new Set();
  for (const item of items) {
    const p = fn(item).finally(() => executing.delete(p));
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
