/**
 * Local cache — persists contacts, keys, and endpoints to disk as JSON.
 *
 * Survives relay outages. Cache corruption triggers graceful regeneration.
 *
 * Note: No file locking — assumes single-process access per dataDir.
 * If multiple processes share a dataDir, use separate cache paths or
 * add proper-lockfile for advisory locking.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CachedContact {
  username: string;
  publicKey: string;
  endpoint: string | null;
  addedAt: string;
}

export interface CacheData {
  contacts: CachedContact[];
  lastUpdated: string;
}

/**
 * Load cache from disk. Returns null on corruption or missing file.
 */
export function loadCache(filePath: string): CacheData | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.contacts)) return null;
    return data as CacheData;
  } catch {
    return null; // Corrupt file — will regenerate
  }
}

/**
 * Save cache to disk.
 */
export function saveCache(filePath: string, data: CacheData): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Get the default cache file path for a data directory.
 */
export function getCachePath(dataDir: string): string {
  return join(dataDir, 'contacts-cache.json');
}
