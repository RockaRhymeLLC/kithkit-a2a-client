/**
 * SDK type definitions.
 */

export interface CC4MeNetworkOptions {
  /** Relay server URL */
  relayUrl: string;
  /** Agent's username on the network */
  username: string;
  /** Ed25519 private key (PKCS8 DER format) */
  privateKey: Buffer;
  /** Agent's reachable HTTPS endpoint for receiving messages */
  endpoint: string;
  /** Directory for persisting local cache (contacts, keys) */
  dataDir?: string;
  /** Presence heartbeat interval in ms (default: 300000 = 5 min) */
  heartbeatInterval?: number;
  /** Max messages in retry queue (default: 100) */
  retryQueueMax?: number;
}

export interface SendResult {
  status: 'delivered' | 'queued' | 'failed';
  messageId: string;
  error?: string;
}

export interface Message {
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
}

export interface ContactRequest {
  from: string;
  greeting: string;
  publicKey: string;
  ownerEmail: string;
}

export interface Broadcast {
  type: string;
  payload: Record<string, unknown>;
  sender: string;
  verified: boolean;
}

export interface DeliveryStatus {
  messageId: string;
  status: 'pending' | 'sending' | 'delivered' | 'expired' | 'failed';
  attempts: number;
}

export interface PresenceInfo {
  agent: string;
  online: boolean;
  endpoint?: string;
  lastSeen: string;
}

export interface DeliveryReport {
  messageId: string;
  attempts: Array<{
    timestamp: string;
    presenceCheck: boolean;
    endpoint: string;
    httpStatus?: number;
    error?: string;
    durationMs: number;
  }>;
  finalStatus: 'delivered' | 'expired' | 'failed';
}

export interface Contact {
  username: string;
  publicKey: string;
  endpoint: string;
  addedAt: string;
}

export interface GroupMessage {
  groupId: string;
  sender: string;
  messageId: string;
  timestamp: string;
  payload: Record<string, unknown>;
  verified: boolean;
}

export interface GroupSendResult {
  messageId: string;
  delivered: string[];
  queued: string[];
  failed: string[];
}

/**
 * Wire format envelope — every P2P message uses this structure.
 */
export interface WireEnvelope {
  version: string;
  type: 'direct' | 'group' | 'broadcast' | 'contact-request' | 'contact-response' | 'revocation' | 'receipt';
  messageId: string;
  sender: string;
  recipient: string;
  timestamp: string;
  /** Group ID — required for type='group', must not be present for type='direct'. */
  groupId?: string;
  payload: {
    ciphertext?: string;
    nonce?: string;
    [key: string]: unknown;
  };
  signature: string;
}
