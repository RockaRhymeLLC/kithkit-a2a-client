/**
 * Tests for multi-community types, config validation, and CommunityRelayManager.
 *
 * t-100: CommunityConfig type validation and mutual exclusion
 * t-101: CommunityRelayManager construction and API routing (s-m02)
 * t-102: Per-community independent heartbeat (s-m03)
 * t-103: Failover detection and sticky switch (s-m04)
 * t-104: Community fully offline (s-m04)
 * t-105: Per-community contact cache files and migration (s-m05)
 * t-106: Qualified name parsing and resolution (s-m06)
 * t-107: Community-scoped contact and messaging operations (s-m06)
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CC4MeNetwork, type CC4MeNetworkInternalOptions } from '../client.js';
import { CommunityRelayManager } from '../community-manager.js';
import type { CommunityConfig } from '../types.js';
import type { IRelayAPI, RelayResponse, RelayContact, RelayPendingRequest, RelayBroadcast, RelayGroup, RelayGroupMember, RelayGroupInvitation, RelayGroupChange } from '../relay-api.js';

function genKeypair() {
  const kp = generateKeyPairSync('ed25519');
  return {
    privateKey: kp.privateKey,
    publicKeyBase64: Buffer.from(kp.publicKey.export({ type: 'spki', format: 'der' })).toString('base64'),
    privateKeyDer: kp.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer,
  };
}

/** Minimal mock relay API for config validation tests (no real relay calls). */
function createMockRelayAPI(): IRelayAPI {
  const notCalled = async (): Promise<RelayResponse> => ({ ok: true, status: 200 });
  return {
    requestContact: notCalled,
    acceptContact: notCalled,
    denyContact: notCalled,
    removeContact: notCalled,
    getContacts: async () => ({ ok: true, status: 200, data: [] as RelayContact[] }),
    getPendingRequests: async () => ({ ok: true, status: 200, data: [] as RelayPendingRequest[] }),
    heartbeat: notCalled,
    createBroadcast: async () => ({ ok: true, status: 200, data: { broadcastId: 'b1' } }),
    listBroadcasts: async () => ({ ok: true, status: 200, data: [] as RelayBroadcast[] }),
    revokeAgent: notCalled,
    rotateKey: notCalled,
    recoverKey: notCalled,
    createGroup: async () => ({ ok: true, status: 200, data: { groupId: 'g1', name: 'test', owner: 'a', status: 'active', createdAt: '' } as RelayGroup }),
    getGroup: async () => ({ ok: true, status: 200, data: { groupId: 'g1', name: 'test', owner: 'a', status: 'active', createdAt: '' } as RelayGroup }),
    inviteToGroup: notCalled,
    acceptGroupInvitation: notCalled,
    declineGroupInvitation: notCalled,
    leaveGroup: notCalled,
    removeMember: notCalled,
    dissolveGroup: notCalled,
    listGroups: async () => ({ ok: true, status: 200, data: [] as RelayGroup[] }),
    getGroupMembers: async () => ({ ok: true, status: 200, data: [] as RelayGroupMember[] }),
    getGroupInvitations: async () => ({ ok: true, status: 200, data: [] as RelayGroupInvitation[] }),
    getGroupChanges: async () => ({ ok: true, status: 200, data: [] as RelayGroupChange[] }),
    transferGroupOwnership: notCalled,
  };
}

function baseOpts(kp: ReturnType<typeof genKeypair>): Omit<CC4MeNetworkInternalOptions, 'relayUrl' | 'communities'> {
  return {
    username: 'test-agent',
    privateKey: kp.privateKeyDer,
    endpoint: 'https://test.example.com/inbox',
    relayAPI: createMockRelayAPI(),
    deliverFn: async () => true,
  };
}

// ─── t-100: CommunityConfig type validation and mutual exclusion ─────────────

describe('t-100: CommunityConfig type validation and mutual exclusion', () => {
  const kp = genKeypair();

  it('Step 1: valid relayUrl config creates default community', () => {
    const net = new CC4MeNetwork({
      ...baseOpts(kp),
      relayUrl: 'https://relay.bmobot.ai',
    } as CC4MeNetworkInternalOptions);
    assert.equal(net.communities.length, 1);
    assert.equal(net.communities[0].name, 'default');
    assert.equal(net.communities[0].primary, 'https://relay.bmobot.ai');
  });

  it('Step 2: valid communities array (2 communities, one with failover)', () => {
    const net = new CC4MeNetwork({
      ...baseOpts(kp),
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai', failover: 'https://backup.bmobot.ai' },
        { name: 'company', primary: 'https://relay.acme.com' },
      ],
    } as CC4MeNetworkInternalOptions);
    assert.equal(net.communities.length, 2);
    assert.equal(net.communities[0].name, 'home');
    assert.equal(net.communities[1].name, 'company');
  });

  it('Step 3: BOTH relayUrl and communities throws', () => {
    assert.throws(() => {
      new CC4MeNetwork({
        ...baseOpts(kp),
        relayUrl: 'https://relay.bmobot.ai',
        communities: [{ name: 'home', primary: 'https://relay.bmobot.ai' }],
      } as CC4MeNetworkInternalOptions);
    }, /relayUrl and communities are mutually exclusive/);
  });

  it('Step 4: empty communities array throws', () => {
    assert.throws(() => {
      new CC4MeNetwork({
        ...baseOpts(kp),
        communities: [],
      } as CC4MeNetworkInternalOptions);
    }, /At least one community must be configured/);
  });

  it('Step 5: community missing name throws', () => {
    assert.throws(() => {
      new CC4MeNetwork({
        ...baseOpts(kp),
        communities: [{ name: '', primary: 'https://relay.bmobot.ai' }],
      } as CC4MeNetworkInternalOptions);
    }, /missing required field: name|Invalid community name/);
  });

  it('Step 6: community missing primary URL throws', () => {
    assert.throws(() => {
      new CC4MeNetwork({
        ...baseOpts(kp),
        communities: [{ name: 'home', primary: '' }],
      } as CC4MeNetworkInternalOptions);
    }, /missing required field: primary/);
  });

  it('Step 7: neither relayUrl nor communities throws', () => {
    assert.throws(() => {
      new CC4MeNetwork({
        ...baseOpts(kp),
      } as CC4MeNetworkInternalOptions);
    }, /Either relayUrl or communities must be provided/);
  });

  it('Step 8: community name with path traversal characters throws', () => {
    const badNames = ['../etc', 'my/community', 'a.b.c', 'has spaces', '-starts-with-hyphen'];
    for (const name of badNames) {
      assert.throws(() => {
        new CC4MeNetwork({
          ...baseOpts(kp),
          communities: [{ name, primary: 'https://relay.example.com' }],
        } as CC4MeNetworkInternalOptions);
      }, /Invalid community name|must be alphanumeric/, `Should reject name: '${name}'`);
    }
  });
});

// ─── t-101: CommunityRelayManager construction and API routing ───────────────

describe('t-101: CommunityRelayManager construction and API routing', () => {
  const kp = genKeypair();

  // Shared test fixtures
  const homePrimaryMock = createMockRelayAPI();
  const homeFailoverMock = createMockRelayAPI();
  const companyPrimaryMock = createMockRelayAPI();

  const communities: CommunityConfig[] = [
    { name: 'home', primary: 'https://relay.bmobot.ai', failover: 'https://backup.bmobot.ai' },
    { name: 'company', primary: 'https://relay.acme.com' },
  ];

  const relayAPIs: Record<string, IRelayAPI> = {
    'home:primary': homePrimaryMock,
    'home:failover': homeFailoverMock,
    'company:primary': companyPrimaryMock,
  };

  function createManager(overrideAPIs?: Record<string, IRelayAPI>): CommunityRelayManager {
    return new CommunityRelayManager(
      communities,
      'test-agent',
      kp.privateKey,
      3, // failoverThreshold
      overrideAPIs ?? relayAPIs,
    );
  }

  it('Step 1: creates manager with 2 communities (3 API instances)', () => {
    const manager = createManager();
    // 2 communities configured
    assert.equal(manager.getCommunityNames().length, 2);
    // All 3 APIs accessible (home primary, home failover via state, company primary)
    assert.ok(manager.getActiveApi('home'));
    assert.ok(manager.getActiveApi('company'));
    assert.equal(manager.getActiveRelayType('home'), 'primary');
    assert.equal(manager.getActiveRelayType('company'), 'primary');
  });

  it('Step 2: getActiveApi("home") returns primary API', () => {
    const manager = createManager();
    assert.equal(manager.getActiveApi('home'), homePrimaryMock);
  });

  it('Step 3: getActiveApi("company") returns primary API', () => {
    const manager = createManager();
    assert.equal(manager.getActiveApi('company'), companyPrimaryMock);
  });

  it('Step 4: getActiveApi("nonexistent") throws', () => {
    const manager = createManager();
    assert.throws(
      () => manager.getActiveApi('nonexistent'),
      /Community not found/,
    );
  });

  it('Step 5: getCommunityNames() returns names in config order', () => {
    const manager = createManager();
    assert.deepEqual(manager.getCommunityNames(), ['home', 'company']);
  });

  it('Step 6: getCommunityByHostname resolves known relay hostname', () => {
    const manager = createManager();
    assert.equal(manager.getCommunityByHostname('relay.bmobot.ai'), 'home');
    assert.equal(manager.getCommunityByHostname('backup.bmobot.ai'), 'home');
    assert.equal(manager.getCommunityByHostname('relay.acme.com'), 'company');
  });

  it('Step 7: getCommunityByHostname returns undefined for unknown hostname', () => {
    const manager = createManager();
    assert.equal(manager.getCommunityByHostname('unknown.host.com'), undefined);
  });

  it('Step 8: injected relayAPIs override HttpRelayAPI creation', () => {
    const customPrimary = createMockRelayAPI();
    const customFailover = createMockRelayAPI();
    const manager = new CommunityRelayManager(
      [{ name: 'test', primary: 'https://test.example.com', failover: 'https://backup.example.com' }],
      'test-agent',
      kp.privateKey,
      3,
      { 'test:primary': customPrimary, 'test:failover': customFailover },
    );
    // Verify the injected mocks are used, not HttpRelayAPI instances
    assert.equal(manager.getActiveApi('test'), customPrimary);
  });
});
