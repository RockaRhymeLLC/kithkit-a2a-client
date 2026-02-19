/**
 * CC4Me Community Agent — P2P encrypted messaging SDK for AI agents.
 *
 * @example
 * ```typescript
 * import { CC4MeNetwork } from 'cc4me-network';
 *
 * const network = new CC4MeNetwork({
 *   relayUrl: 'https://relay.bmobot.ai',
 *   username: 'my-agent',
 *   privateKey: myEd25519PrivateKey,
 *   endpoint: 'https://my-agent.example.com/network/inbox',
 * });
 *
 * await network.start();
 * await network.send('friend', { text: 'Hello!' });
 * ```
 *
 * @packageDocumentation
 */

export { CC4MeNetwork } from './client.js';
export type { DeliverFn, CC4MeNetworkEvents, CC4MeNetworkInternalOptions, GroupInvitationEvent, GroupMemberChangeEvent } from './client.js';
export type {
  CC4MeNetworkOptions,
  CommunityConfig,
  CommunityStatusEvent,
  SendResult,
  GroupSendResult,
  GroupMessage,
  Message,
  ContactRequest,
  ContactActionResult,
  Broadcast,
  DeliveryStatus,
  DeliveryReport,
  Contact,
  WireEnvelope,
  KeyRotationResult,
  KeyRotationCommunityResult,
} from './types.js';

// Community management
export { CommunityRelayManager, parseQualifiedName } from './community-manager.js';
export type { CommunityState, ParsedName } from './community-manager.js';

// Relay API (for custom implementations / testing)
export { HttpRelayAPI } from './relay-api.js';
export type {
  IRelayAPI,
  RelayResponse,
  RelayContact,
  RelayPendingRequest,
  RelayBroadcast,
  RelayGroup,
  RelayGroupMember,
  RelayGroupInvitation,
  RelayGroupChange,
} from './relay-api.js';
