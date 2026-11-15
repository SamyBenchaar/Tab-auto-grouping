// Local cache of tab contexts (24 h) in chrome.storage.local. Key = SHA-256(domain + title).
// When every tab of a run is cached, the classification is rebuilt locally (no network call).
import { nameKey } from '../core/text.js';

const CACHE_KEY = 'contextCache';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

async function hashKey(tab) {
  const data = new TextEncoder().encode(`${tab.domain}\n${tab.title}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readCache() {
  const { [CACHE_KEY]: cache } = await chrome.storage.local.get(CACHE_KEY);
  return cache && typeof cache === 'object' ? cache : {};
}

/**
 * @returns {Promise<{groups: object[], ungrouped: number[]} | null>} raw classification (to be
 *   validated with normalizeClassification), or null if at least one tab is unknown.
 */
export async function lookupCachedClassification(request) {
  const cache = await readCache();
  const now = Date.now();
  const raw = { groups: [], ungrouped: [] };
  const byName = new Map();
  for (const tab of request.tabs) {
    const entry = cache[await hashKey(tab)];
    if (!entry || now - entry.t > TTL_MS) return null;
    if (!entry.n) {
      raw.ungrouped.push(tab.id);
      continue;
    }
    const key = nameKey(entry.n);
    if (!byName.has(key)) {
      const group = { name: entry.n, emoji: entry.e ?? '', color: entry.c ?? null, existingGroupId: null, tabIds: [] };
      byName.set(key, group);
      raw.groups.push(group);
    }
    byName.get(key).tabIds.push(tab.id);
  }
  return raw;
}

export async function storeClassification(request, result) {
  const cache = await readCache();
  const now = Date.now();
  const tabsById = new Map(request.tabs.map((tab) => [tab.id, tab]));
  const put = async (tabId, entry) => {
    const tab = tabsById.get(tabId);
    if (tab) cache[await hashKey(tab)] = entry;
  };
  for (const group of result.groups) {
    for (const tabId of group.tabIds) await put(tabId, { n: group.name, e: group.emoji, c: group.color, t: now });
  }
  for (const tabId of result.ungrouped) await put(tabId, { n: '', t: now });

  const fresh = Object.entries(cache)
    .filter(([, entry]) => entry && now - entry.t <= TTL_MS)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, MAX_ENTRIES);
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(fresh) });
}

export async function clearCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}
