/**
 * Local cache — persists contacts, keys, and endpoints to disk as JSON.
 *
 * Survives relay outages. Cache corruption triggers graceful regeneration.
 *
 * Note: No file locking — assumes single-process access per dataDir.
 * If multiple processes share a dataDir, use separate cache paths or
 * add proper-lockfile for advisory locking.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CachedContact {
  username: string;
  publicKey: string;
  endpoint: string | null;
  addedAt: string;
  online: boolean;
  lastSeen: string | null;
  /** Which community this contact belongs to (undefined for legacy caches) */
  community?: string;
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
 * For backward compatibility, delegates to getCommunityCachePath with 'default'.
 */
export function getCachePath(dataDir: string): string {
  return getCommunityCachePath(dataDir, 'default');
}

/**
 * Get the cache file path for a specific community.
 * Returns: {dataDir}/contacts-cache-{communityName}.json
 */
export function getCommunityCachePath(dataDir: string, communityName: string): string {
  return join(dataDir, `contacts-cache-${communityName}.json`);
}

/** The legacy single-file cache path (pre-multi-community). */
function getLegacyCachePath(dataDir: string): string {
  return join(dataDir, 'contacts-cache.json');
}

/**
 * Migrate old single-file cache to per-community format.
 *
 * Detects contacts-cache.json (legacy), adds community field to all contacts,
 * writes to contacts-cache-{firstCommunityName}.json, and renames the old file
 * to contacts-cache.json.migrated (non-destructive).
 *
 * Returns true if migration was performed.
 * Skips if: no legacy file exists, or the target community cache already exists.
 * Handles corrupt JSON gracefully (logs warning, creates fresh cache).
 */
export function migrateOldCache(dataDir: string, firstCommunityName: string): boolean {
  const oldPath = getLegacyCachePath(dataDir);
  const newPath = getCommunityCachePath(dataDir, firstCommunityName);

  // No legacy file — nothing to migrate
  if (!existsSync(oldPath)) return false;

  // Target already exists — migration already done (or user configured fresh)
  if (existsSync(newPath)) return false;

  try {
    const raw = readFileSync(oldPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.contacts)) {
      // Stamp each contact with the community name
      for (const c of data.contacts) {
        c.community = firstCommunityName;
      }
      mkdirSync(dirname(newPath), { recursive: true });
      writeFileSync(newPath, JSON.stringify(data, null, 2));
    } else {
      // Valid JSON but wrong shape — write fresh cache
      mkdirSync(dirname(newPath), { recursive: true });
      saveCache(newPath, { contacts: [], lastUpdated: new Date().toISOString() });
    }
  } catch {
    // Corrupt JSON — create fresh cache, don't crash
    try {
      mkdirSync(dirname(newPath), { recursive: true });
      saveCache(newPath, { contacts: [], lastUpdated: new Date().toISOString() });
    } catch { /* dataDir creation failed — caller will handle */ }
  }

  // Rename old file (non-destructive)
  try {
    renameSync(oldPath, oldPath + '.migrated');
  } catch { /* rename failed — not critical */ }

  return true;
}
