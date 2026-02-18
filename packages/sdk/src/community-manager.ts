/**
 * CommunityRelayManager — manages per-community HttpRelayAPI instances.
 *
 * Each community has a primary relay (and optional failover).
 * The manager tracks active relay, consecutive failures, and provides
 * hostname-based community resolution.
 *
 * Failure tracking via callApi():
 * - Success (ok: true): resets consecutive failure counter
 * - Network/server error (status 0 or >= 500): increments counter (after first success)
 * - Client error (4xx): no counter change (application-level response)
 * - Thrown error: increments counter (after first success)
 */

import { createPrivateKey, type KeyObject } from 'node:crypto';
import { HttpRelayAPI, type IRelayAPI, type RelayResponse } from './relay-api.js';
import type { CommunityConfig } from './types.js';

export interface CommunityState {
  name: string;
  config: CommunityConfig;
  primaryApi: IRelayAPI;
  failoverApi: IRelayAPI | null;
  activeRelay: 'primary' | 'failover';
  consecutiveFailures: number;
  firstSuccessSeen: boolean;
}

export class CommunityRelayManager {
  private communities: Map<string, CommunityState> = new Map();
  private communityOrder: string[];
  private hostnameMap: Map<string, string> = new Map();
  readonly failoverThreshold: number;

  constructor(
    communities: CommunityConfig[],
    username: string,
    defaultPrivateKey: KeyObject,
    failoverThreshold: number,
    relayAPIs?: Record<string, IRelayAPI>,
  ) {
    this.failoverThreshold = failoverThreshold;
    this.communityOrder = communities.map(c => c.name);

    for (const config of communities) {
      // Resolve private key: community-specific or default
      const privateKey = config.privateKey
        ? createPrivateKey({ key: Buffer.from(config.privateKey), format: 'der', type: 'pkcs8' })
        : defaultPrivateKey;

      // Create or inject primary API
      const primaryKey = `${config.name}:primary`;
      const primaryApi = relayAPIs?.[primaryKey] ?? new HttpRelayAPI(config.primary, username, privateKey);

      // Create or inject failover API (if configured)
      let failoverApi: IRelayAPI | null = null;
      if (config.failover) {
        const failoverKey = `${config.name}:failover`;
        failoverApi = relayAPIs?.[failoverKey] ?? new HttpRelayAPI(config.failover, username, privateKey);
      }

      this.communities.set(config.name, {
        name: config.name,
        config,
        primaryApi,
        failoverApi,
        activeRelay: 'primary',
        consecutiveFailures: 0,
        firstSuccessSeen: false,
      });

      // Map hostnames for reverse lookup (getCommunityByHostname)
      try {
        this.hostnameMap.set(new URL(config.primary).hostname, config.name);
      } catch { /* invalid URL — skip */ }

      if (config.failover) {
        try {
          this.hostnameMap.set(new URL(config.failover).hostname, config.name);
        } catch { /* invalid URL — skip */ }
      }
    }
  }

  /** Get the active relay API for a community. Throws if community not found. */
  getActiveApi(communityName: string): IRelayAPI {
    const state = this.communities.get(communityName);
    if (!state) {
      throw new Error(`Community not found: '${communityName}'`);
    }
    if (state.activeRelay === 'failover' && state.failoverApi) {
      return state.failoverApi;
    }
    return state.primaryApi;
  }

  /** Get all configured community names in config order. */
  getCommunityNames(): string[] {
    return [...this.communityOrder];
  }

  /** Resolve a relay hostname to a community name. Returns undefined if no match. */
  getCommunityByHostname(hostname: string): string | undefined {
    return this.hostnameMap.get(hostname);
  }

  /**
   * Call a relay API function with failure tracking.
   *
   * Wraps the callback, inspects the result, and updates the failure counter:
   * - ok: true → reset counter, mark first success
   * - status 0 or >= 500 → increment counter (network/server error)
   * - status 4xx → no change (client error, not a relay health issue)
   * - thrown error → increment counter
   *
   * Startup transient grace: counter doesn't increment until first successful call.
   */
  async callApi<T>(
    communityName: string,
    fn: (api: IRelayAPI) => Promise<RelayResponse<T>>,
  ): Promise<RelayResponse<T>> {
    const state = this.communities.get(communityName);
    if (!state) {
      throw new Error(`Community not found: '${communityName}'`);
    }

    const api = this.getActiveApi(communityName);
    try {
      const result = await fn(api);
      if (result.ok) {
        state.consecutiveFailures = 0;
        state.firstSuccessSeen = true;
      } else if (result.status === 0 || result.status >= 500) {
        if (state.firstSuccessSeen) {
          state.consecutiveFailures++;
        }
      }
      // 4xx: no counter change
      return result;
    } catch (err) {
      if (state.firstSuccessSeen) {
        state.consecutiveFailures++;
      }
      throw err;
    }
  }

  /** Get the consecutive failure count for a community (for failover logic and testing). */
  getFailureCount(communityName: string): number {
    const state = this.communities.get(communityName);
    if (!state) throw new Error(`Community not found: '${communityName}'`);
    return state.consecutiveFailures;
  }

  /** Get the active relay type for a community ('primary' or 'failover'). */
  getActiveRelayType(communityName: string): 'primary' | 'failover' {
    const state = this.communities.get(communityName);
    if (!state) throw new Error(`Community not found: '${communityName}'`);
    return state.activeRelay;
  }

  /** Get the internal state for a community (for failover logic in s-m04). */
  getCommunityState(communityName: string): CommunityState | undefined {
    return this.communities.get(communityName);
  }
}
