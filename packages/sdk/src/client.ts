/**
 * CC4MeNetwork — main SDK client.
 *
 * Handles contacts, presence, local cache, lifecycle, and P2P encrypted messaging.
 */

import { EventEmitter } from 'node:events';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import type {
  CC4MeNetworkOptions,
  SendResult,
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

export interface CC4MeNetworkEvents {
  message: [msg: Message];
  'contact-request': [req: ContactRequest];
  broadcast: [broadcast: Broadcast];
  'delivery-status': [status: DeliveryStatus];
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

    // Wire retry queue's send function
    this.retryQueue.setSendFn(async (msg) => {
      const contact = this.getCachedContact(msg.recipient);
      if (!contact) return false;

      const presence = await this.checkPresence(msg.recipient);
      if (!presence.online) return false;

      const endpoint = presence.endpoint || contact.endpoint;
      if (!endpoint) return false;

      const envelope = buildEnvelope({
        sender: this.options.username,
        recipient: msg.recipient,
        payload: msg.payload,
        senderPrivateKey: this.privateKeyObj,
        recipientPublicKeyBase64: contact.publicKey,
        messageId: msg.messageId,
      });

      return this.deliverFn(endpoint, envelope);
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

    // Check presence
    const presence = await this.checkPresence(to);

    if (!presence.online) {
      // Offline — queue for retry
      const queued = this.retryQueue.enqueue(envelope.messageId, to, payload);
      if (queued) {
        return { status: 'queued', messageId: envelope.messageId };
      }
      return { status: 'failed', messageId: envelope.messageId, error: 'Retry queue full' };
    }

    // Online — try direct delivery
    const endpoint = presence.endpoint || contact.endpoint;
    if (!endpoint) {
      return { status: 'failed', messageId: envelope.messageId, error: 'No endpoint for recipient' };
    }

    const delivered = await this.deliverFn(endpoint, envelope);
    if (delivered) {
      return { status: 'delivered', messageId: envelope.messageId };
    }

    // Delivery failed — queue for retry
    const queued = this.retryQueue.enqueue(envelope.messageId, to, payload);
    if (queued) {
      return { status: 'queued', messageId: envelope.messageId };
    }
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

  // --- Admin (implemented later) ---

  asAdmin(adminPrivateKey: Buffer) {
    void adminPrivateKey;
    return {
      broadcast: async (type: string, payload: Record<string, unknown>) => {
        void type; void payload;
      },
      approveAgent: async (name: string) => { void name; },
      revokeAgent: async (name: string) => { void name; },
    };
  }

  getDeliveryReport(messageId: string): DeliveryReport | undefined {
    void messageId;
    return undefined;
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
