/**
 * Wire format encoding/decoding — canonical JSON serialization for signatures.
 */

import type { WireEnvelope } from './types.js';

/**
 * Canonical JSON serialization — keys sorted alphabetically, no whitespace.
 * Used for computing signatures over message envelopes.
 */
export function canonicalize(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, sortKeys);
}

/**
 * JSON replacer that recursively sorts object keys alphabetically.
 */
function sortKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Buffer)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Extract the signable portion of an envelope (everything except `signature`).
 */
export function signablePayload(envelope: WireEnvelope): string {
  const { signature: _, ...rest } = envelope;
  return canonicalize(rest as Record<string, unknown>);
}

/**
 * Validate that an envelope has all required fields and correct types.
 *
 * Group envelopes require groupId. Direct envelopes must not have groupId.
 */
export function validateEnvelope(data: unknown): data is WireEnvelope {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;

  // Base field checks
  if (
    typeof obj.version !== 'string' ||
    typeof obj.type !== 'string' ||
    typeof obj.messageId !== 'string' ||
    typeof obj.sender !== 'string' ||
    typeof obj.recipient !== 'string' ||
    typeof obj.timestamp !== 'string' ||
    typeof obj.payload !== 'object' ||
    obj.payload === null ||
    typeof obj.signature !== 'string'
  ) {
    return false;
  }

  // Group envelope: groupId required
  if (obj.type === 'group') {
    if (typeof obj.groupId !== 'string' || obj.groupId === '') return false;
  }

  // Direct envelope: groupId must not be present
  if (obj.type === 'direct') {
    if (obj.groupId !== undefined) return false;
  }

  return true;
}

/**
 * Check if the major version is compatible.
 */
export function isVersionCompatible(version: string): boolean {
  const major = parseInt(version.split('.')[0]!, 10);
  return major === 2;
}
