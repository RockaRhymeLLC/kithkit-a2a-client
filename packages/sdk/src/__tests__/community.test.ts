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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CC4MeNetwork, type CC4MeNetworkInternalOptions } from '../client.js';
import { CommunityRelayManager } from '../community-manager.js';
import type { CommunityConfig } from '../types.js';
import type { IRelayAPI, RelayResponse, RelayContact, RelayPendingRequest, RelayBroadcast, RelayGroup, RelayGroupMember, RelayGroupInvitation, RelayGroupChange } from '../relay-api.js';
import { getCommunityCachePath, loadCache, migrateOldCache } from '../cache.js';

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

// ─── t-102: Per-community independent heartbeat ──────────────────────────────

/** Create a mock relay API that tracks heartbeat calls. */
function createTrackingMockRelayAPI(): { api: IRelayAPI; heartbeatCalls: string[] } {
  const heartbeatCalls: string[] = [];
  const base = createMockRelayAPI();
  const api: IRelayAPI = {
    ...base,
    heartbeat: async (endpoint: string) => {
      heartbeatCalls.push(endpoint);
      return { ok: true, status: 200 };
    },
  };
  return { api, heartbeatCalls };
}

describe('t-102: Per-community independent heartbeat', () => {
  const kp = genKeypair();
  const endpoint = 'https://test.example.com/inbox';

  const communities: CommunityConfig[] = [
    { name: 'home', primary: 'https://relay.bmobot.ai', failover: 'https://backup.bmobot.ai' },
    { name: 'company', primary: 'https://relay.acme.com' },
  ];

  it('Step 1: initial heartbeats sent to both communities\' active relays', async () => {
    const homePrimary = createTrackingMockRelayAPI();
    const homeFailover = createTrackingMockRelayAPI();
    const companyPrimary = createTrackingMockRelayAPI();

    const manager = new CommunityRelayManager(
      communities, 'test-agent', kp.privateKey, 3,
      { 'home:primary': homePrimary.api, 'home:failover': homeFailover.api, 'company:primary': companyPrimary.api },
    );

    await manager.sendAllHeartbeats(endpoint);

    assert.equal(homePrimary.heartbeatCalls.length, 1);
    assert.equal(homeFailover.heartbeatCalls.length, 0); // not active
    assert.equal(companyPrimary.heartbeatCalls.length, 1);
  });

  it('Step 2: second heartbeat round hits both communities again', async () => {
    const homePrimary = createTrackingMockRelayAPI();
    const homeFailover = createTrackingMockRelayAPI();
    const companyPrimary = createTrackingMockRelayAPI();

    const manager = new CommunityRelayManager(
      communities, 'test-agent', kp.privateKey, 3,
      { 'home:primary': homePrimary.api, 'home:failover': homeFailover.api, 'company:primary': companyPrimary.api },
    );

    await manager.sendAllHeartbeats(endpoint);
    await manager.sendAllHeartbeats(endpoint);

    assert.equal(homePrimary.heartbeatCalls.length, 2);
    assert.equal(companyPrimary.heartbeatCalls.length, 2);
  });

  it('Step 3: stopHeartbeats clears all timers', () => {
    const homePrimary = createTrackingMockRelayAPI();
    const companyPrimary = createTrackingMockRelayAPI();

    const manager = new CommunityRelayManager(
      communities, 'test-agent', kp.privateKey, 3,
      { 'home:primary': homePrimary.api, 'company:primary': companyPrimary.api },
    );

    manager.startHeartbeats(endpoint, 60000);
    // Timers are running
    const homeState = manager.getCommunityState('home')!;
    const companyState = manager.getCommunityState('company')!;
    assert.ok(homeState.heartbeatTimer !== null);
    assert.ok(companyState.heartbeatTimer !== null);

    manager.stopHeartbeats();
    assert.equal(homeState.heartbeatTimer, null);
    assert.equal(companyState.heartbeatTimer, null);
  });

  it('Step 4-5: failover switches heartbeat to failover relay', async () => {
    const homePrimary = createTrackingMockRelayAPI();
    const homeFailover = createTrackingMockRelayAPI();
    const companyPrimary = createTrackingMockRelayAPI();

    const manager = new CommunityRelayManager(
      communities, 'test-agent', kp.privateKey, 3,
      { 'home:primary': homePrimary.api, 'home:failover': homeFailover.api, 'company:primary': companyPrimary.api },
    );

    // Simulate failover on 'home' (this will be done by failover logic in s-m04)
    const homeState = manager.getCommunityState('home')!;
    homeState.activeRelay = 'failover';

    // Reset tracking
    homePrimary.heartbeatCalls.length = 0;
    homeFailover.heartbeatCalls.length = 0;
    companyPrimary.heartbeatCalls.length = 0;

    await manager.sendAllHeartbeats(endpoint);

    // Home's heartbeat goes to failover, not primary
    assert.equal(homePrimary.heartbeatCalls.length, 0);
    assert.equal(homeFailover.heartbeatCalls.length, 1);
    // Company unchanged
    assert.equal(companyPrimary.heartbeatCalls.length, 1);
  });
});

// ─── t-105: Per-community contact cache files and migration ──────────────────

/** Create a mock relay API that returns specific contacts. */
function createContactsMockRelayAPI(contacts: RelayContact[]): IRelayAPI {
  const base = createMockRelayAPI();
  return {
    ...base,
    getContacts: async () => ({ ok: true, status: 200, data: contacts }),
  };
}

describe('t-105: Per-community contact cache files and migration', () => {
  const kp = genKeypair();
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

  function track(dir: string, ...networks: CC4MeNetwork[]) {
    cleanups.push({ dir, networks });
  }

  // Steps 1-3: Two communities produce two separate cache files
  it('steps 1-3: per-community cache files with correct contacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-cache-'));
    const dataDir = join(dir, 'data');

    const homeContacts: RelayContact[] = [
      { agent: 'alice', publicKey: 'pk-alice', endpoint: 'https://alice.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
      { agent: 'bob', publicKey: 'pk-bob', endpoint: 'https://bob.example.com/inbox', since: '2025-01-01', online: false, lastSeen: '2025-06-01', keyUpdatedAt: null, recoveryInProgress: false },
    ];
    const companyContacts: RelayContact[] = [
      { agent: 'charlie', publicKey: 'pk-charlie', endpoint: 'https://charlie.acme.com/inbox', since: '2025-03-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
    ];

    const net = new CC4MeNetwork({
      username: 'test-agent',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://test.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
        { name: 'company', primary: 'https://relay.acme.com' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI(homeContacts),
        'company:primary': createContactsMockRelayAPI(companyContacts),
      },
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();

    // Step 1: Two cache files created
    const homePath = getCommunityCachePath(dataDir, 'home');
    const companyPath = getCommunityCachePath(dataDir, 'company');
    assert.equal(existsSync(homePath), true, 'home cache file should exist');
    assert.equal(existsSync(companyPath), true, 'company cache file should exist');

    // Step 2: Home cache has only home contacts with community field
    const homeCache = loadCache(homePath);
    assert.ok(homeCache, 'home cache should load');
    assert.equal(homeCache.contacts.length, 2);
    assert.equal(homeCache.contacts[0]!.username, 'alice');
    assert.equal(homeCache.contacts[0]!.community, 'home');
    assert.equal(homeCache.contacts[1]!.username, 'bob');
    assert.equal(homeCache.contacts[1]!.community, 'home');

    // Step 3: Company cache has only company contacts with community field
    const companyCache = loadCache(companyPath);
    assert.ok(companyCache, 'company cache should load');
    assert.equal(companyCache.contacts.length, 1);
    assert.equal(companyCache.contacts[0]!.username, 'charlie');
    assert.equal(companyCache.contacts[0]!.community, 'company');
  });

  // Steps 4-5: Migration from old single-file cache
  it('steps 4-5: old contacts-cache.json migrated to first community', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-migrate-'));
    const dataDir = join(dir, 'data');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });

    // Create old-format cache file (no community field)
    const oldCachePath = join(dataDir, 'contacts-cache.json');
    const oldCache = {
      contacts: [
        { username: 'alice', publicKey: 'pk-alice', endpoint: 'https://alice.example.com/inbox', addedAt: '2025-01-01', online: true, lastSeen: null },
        { username: 'bob', publicKey: 'pk-bob', endpoint: 'https://bob.example.com/inbox', addedAt: '2025-02-01', online: false, lastSeen: '2025-06-01' },
      ],
      lastUpdated: '2025-06-01T00:00:00Z',
    };
    writeFileSync(oldCachePath, JSON.stringify(oldCache, null, 2));

    const net = new CC4MeNetwork({
      username: 'test-agent',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://test.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
        { name: 'company', primary: 'https://relay.acme.com' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([]),
        'company:primary': createContactsMockRelayAPI([]),
      },
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();

    // Step 4: Old contacts migrated to first community ('home')
    const homePath = getCommunityCachePath(dataDir, 'home');
    const homeCache = loadCache(homePath);
    assert.ok(homeCache, 'migrated home cache should load');
    assert.equal(homeCache.contacts.length, 2);
    assert.equal(homeCache.contacts[0]!.username, 'alice');
    assert.equal(homeCache.contacts[0]!.community, 'home');
    assert.equal(homeCache.contacts[1]!.username, 'bob');
    assert.equal(homeCache.contacts[1]!.community, 'home');

    // Step 5: Old file no longer exists (renamed, not deleted)
    assert.equal(existsSync(oldCachePath), false, 'old cache file should not exist');
    assert.equal(existsSync(oldCachePath + '.migrated'), true, 'old cache should be renamed to .migrated');
  });

  // Step 6: No re-migration if community cache already exists
  it('step 6: no re-migration when community cache already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-nomigrate-'));
    const dataDir = join(dir, 'data');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });

    // Create existing community cache
    const homePath = getCommunityCachePath(dataDir, 'home');
    const existingCache = {
      contacts: [
        { username: 'existing', publicKey: 'pk-existing', endpoint: 'https://existing.example.com/inbox', addedAt: '2025-01-01', online: true, lastSeen: null, community: 'home' },
      ],
      lastUpdated: '2025-06-01T00:00:00Z',
    };
    writeFileSync(homePath, JSON.stringify(existingCache, null, 2));

    // Also create an old-format file (shouldn't be migrated since community file exists)
    const oldCachePath = join(dataDir, 'contacts-cache.json');
    writeFileSync(oldCachePath, JSON.stringify({ contacts: [{ username: 'old-contact' }], lastUpdated: '' }));

    const net = new CC4MeNetwork({
      username: 'test-agent',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://test.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([]),
      },
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();

    // Existing community cache preserved (not overwritten by migration)
    const homeCache = loadCache(homePath);
    assert.ok(homeCache);
    assert.equal(homeCache.contacts.length, 1);
    assert.equal(homeCache.contacts[0]!.username, 'existing');

    // Old file still there (migration was skipped)
    assert.equal(existsSync(oldCachePath), true);
  });

  // Step 7: Corrupt old cache handled gracefully
  it('step 7: corrupt old cache creates fresh community cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-corrupt-'));
    const dataDir = join(dir, 'data');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });

    // Create corrupt old cache
    const oldCachePath = join(dataDir, 'contacts-cache.json');
    writeFileSync(oldCachePath, '{corrupt json!!!');

    const net = new CC4MeNetwork({
      username: 'test-agent',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://test.example.com/inbox',
      communities: [
        { name: 'home', primary: 'https://relay.bmobot.ai' },
      ],
      relayAPIs: {
        'home:primary': createContactsMockRelayAPI([]),
      },
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    // Should not crash
    await net.start();
    assert.equal(net.isStarted, true);

    // Old file renamed
    assert.equal(existsSync(oldCachePath), false);
    assert.equal(existsSync(oldCachePath + '.migrated'), true);
  });
});

// ─── t-109: Backward compatibility with single relayUrl ──────────────────────

describe('t-109: Backward compatibility with single relayUrl', () => {
  const kp = genKeypair();
  const kp2 = genKeypair();
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

  function track(dir: string, ...networks: CC4MeNetwork[]) {
    cleanups.push({ dir, networks });
  }

  // Step 1: relayUrl creates 'default' community (already tested in t-100, but verify cache behavior)
  it('step 1: relayUrl creates default community with working cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-compat-'));
    const dataDir = join(dir, 'data');

    const contacts: RelayContact[] = [
      { agent: 'r2', publicKey: kp2.publicKeyBase64, endpoint: 'https://r2.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
    ];

    const net = new CC4MeNetwork({
      username: 'bmo',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      relayUrl: 'https://relay.bmobot.ai',
      relayAPI: createContactsMockRelayAPI(contacts),
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();
    assert.equal(net.communities.length, 1);
    assert.equal(net.communities[0].name, 'default');
  });

  // Step 2: getContacts returns contacts with community: 'default'
  it('step 2: contacts have community: default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-compat2-'));
    const dataDir = join(dir, 'data');

    const contacts: RelayContact[] = [
      { agent: 'r2', publicKey: kp2.publicKeyBase64, endpoint: 'https://r2.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
    ];

    const net = new CC4MeNetwork({
      username: 'bmo',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      relayUrl: 'https://relay.bmobot.ai',
      relayAPI: createContactsMockRelayAPI(contacts),
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();

    // getCachedContact should have community: 'default'
    const cached = net.getCachedContact('r2');
    assert.ok(cached);
    assert.equal(cached.community, 'default');
  });

  // Step 3: send works via single relay (already tested extensively in client.test.ts, quick sanity)
  it('step 3: send works via single relay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-compat3-'));
    const dataDir = join(dir, 'data');

    let delivered = false;
    const contacts: RelayContact[] = [
      { agent: 'r2', publicKey: kp2.publicKeyBase64, endpoint: 'https://r2.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
    ];

    const net = new CC4MeNetwork({
      username: 'bmo',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      relayUrl: 'https://relay.bmobot.ai',
      relayAPI: createContactsMockRelayAPI(contacts),
      deliverFn: async () => { delivered = true; return true; },
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();
    const result = await net.send('r2', { text: 'hello' });
    assert.equal(result.status, 'delivered');
    assert.equal(delivered, true);
  });

  // Step 4: cache file uses contacts-cache-default.json
  it('step 4: cache file is contacts-cache-default.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-compat4-'));
    const dataDir = join(dir, 'data');

    const contacts: RelayContact[] = [
      { agent: 'r2', publicKey: kp2.publicKeyBase64, endpoint: 'https://r2.example.com/inbox', since: '2025-01-01', online: true, lastSeen: null, keyUpdatedAt: null, recoveryInProgress: false },
    ];

    const net = new CC4MeNetwork({
      username: 'bmo',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://bmo.example.com/inbox',
      relayUrl: 'https://relay.bmobot.ai',
      relayAPI: createContactsMockRelayAPI(contacts),
      deliverFn: async () => true,
      dataDir,
    } as CC4MeNetworkInternalOptions);
    track(dir, net);

    await net.start();

    // Cache file should be per-community with 'default' name
    const expectedPath = getCommunityCachePath(dataDir, 'default');
    assert.equal(existsSync(expectedPath), true, 'contacts-cache-default.json should exist');

    const cache = loadCache(expectedPath);
    assert.ok(cache);
    assert.equal(cache.contacts.length, 1);
    assert.equal(cache.contacts[0]!.username, 'r2');
    assert.equal(cache.contacts[0]!.community, 'default');
  });

  // Step 5: existing tests pass (verified by running full test suite — this is a meta-test)
  it('step 5: relayAPI injection still works as before', () => {
    // This verifies the injected relay API path still works (constructor doesn't throw)
    const dir = mkdtempSync(join(tmpdir(), 'cc4me-compat5-'));
    const mock = createMockRelayAPI();
    const net = new CC4MeNetwork({
      username: 'test',
      privateKey: kp.privateKeyDer,
      endpoint: 'https://test.example.com/inbox',
      relayUrl: 'https://relay.example.com',
      relayAPI: mock,
      deliverFn: async () => true,
      dataDir: join(dir, 'data'),
    } as CC4MeNetworkInternalOptions);
    cleanups.push({ dir, networks: [net] });

    assert.ok(net);
    assert.equal(net.communities[0].name, 'default');
  });
});
