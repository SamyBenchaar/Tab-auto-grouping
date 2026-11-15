// Validation of a classification (model output, cache or heuristic) against the request.
// Guarantees: every tab id appears at most once, unknown ids are dropped, missing ids end up in
// "ungrouped", new groups have >= 2 tabs, at most `maxGroups` new groups, valid colors.
import { LIMITS, TAB_GROUP_COLORS } from './constants.js';
import { capitalize, cleanText, nameKey, sanitizeEmoji, splitLeadingEmoji, stripEmojis } from './text.js';
import { siteLabel } from './url.js';

/** Order in which free colors are handed out (vivid colors first). */
const COLOR_PICK_ORDER = ['blue', 'orange', 'green', 'purple', 'cyan', 'pink', 'red', 'yellow', 'grey'];

export class ClassificationError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.name = 'ClassificationError';
    this.retryable = retryable;
  }
}

/** Parse the model text answer (tolerates ```json fences and surrounding prose). */
export function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ClassificationError('Réponse du modèle vide.');
  }
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ClassificationError('Réponse du modèle sans JSON.');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ClassificationError('JSON du modèle invalide.');
  }
}

/** Validation context for results that already use real (Chrome) ids. */
export function contextFromRequest(request) {
  return {
    tabIds: request.tabs.map((tab) => tab.id),
    tabs: request.tabs,
    existingGroups: request.existingGroups,
    maxGroups: request.maxGroups,
    language: request.language,
  };
}

function cleanGroupName(rawName, rawEmoji) {
  const text = cleanText(typeof rawName === 'string' ? rawName : '', 80);
  const { emoji: leadingEmoji, name } = splitLeadingEmoji(text);
  return {
    name: capitalize(cleanText(stripEmojis(name), LIMITS.groupNameLength)),
    emoji: sanitizeEmoji(rawEmoji) || leadingEmoji,
  };
}

function fallbackName(tabIds, tabsById, language) {
  const counts = new Map();
  for (const id of tabIds) {
    const label = siteLabel(tabsById.get(id)?.domain);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) [best, bestCount] = [label, count];
  }
  return best ? capitalize(best) : language === 'fr' ? 'Groupe' : 'Group';
}

function assignColors(groups, existingGroups) {
  const used = new Set(existingGroups.map((group) => group.color).filter(Boolean));
  const pending = [];
  for (const group of groups) {
    if (group.existingGroupId !== null) continue;
    if (group.color && !used.has(group.color)) used.add(group.color);
    else pending.push(group);
  }
  pending.forEach((group, index) => {
    const free = COLOR_PICK_ORDER.find((color) => !used.has(color));
    group.color = free ?? group.color ?? COLOR_PICK_ORDER[index % COLOR_PICK_ORDER.length];
    used.add(group.color);
  });
}

/**
 * @param {string|object} raw model text, or an already-parsed object
 * @param {{tabIds:number[], tabs?:object[], existingGroups:object[], maxGroups:number, language?:string,
 *          tabIdByLocal?:Map<number,number>, groupIdByLocal?:Map<number,number>}} ctx
 * @returns {{groups: Array<{name:string, emoji:string, color:string, existingGroupId:number|null, tabIds:number[]}>,
 *            ungrouped: number[]}}
 */
export function normalizeClassification(raw, ctx) {
  const data = typeof raw === 'string' ? parseModelJson(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.groups)) {
    throw new ClassificationError('Réponse invalide : tableau « groups » manquant.');
  }

  const validTabIds = new Set(ctx.tabIds);
  const tabsById = new Map((ctx.tabs ?? []).map((tab) => [tab.id, tab]));
  const existingById = new Map(ctx.existingGroups.map((group) => [group.id, group]));
  const existingByKey = new Map();
  for (const group of ctx.existingGroups) {
    const key = nameKey(group.name);
    if (key && !existingByKey.has(key)) existingByKey.set(key, group);
  }
  const toRealTab = ctx.tabIdByLocal ? (id) => ctx.tabIdByLocal.get(id) : (id) => id;
  const toRealGroup = ctx.groupIdByLocal ? (id) => ctx.groupIdByLocal.get(id) : (id) => id;

  const assigned = new Set();
  const merged = new Map();
  for (const rawGroup of data.groups) {
    if (!rawGroup || typeof rawGroup !== 'object' || !Array.isArray(rawGroup.tabIds)) continue;

    const tabIds = [];
    for (const rawId of rawGroup.tabIds) {
      const realId = toRealTab(Number(rawId));
      if (realId === undefined || !validTabIds.has(realId) || assigned.has(realId)) continue;
      assigned.add(realId);
      tabIds.push(realId);
    }
    if (tabIds.length === 0) continue;

    const { name, emoji } = cleanGroupName(rawGroup.name, rawGroup.emoji);
    let existing = null;
    const rawExistingId = rawGroup.existingGroupId;
    if (rawExistingId !== null && rawExistingId !== undefined && rawExistingId !== '') {
      existing = existingById.get(toRealGroup(Number(rawExistingId))) ?? null;
    }
    // The model sometimes recreates an existing group instead of reusing it: match by name.
    if (!existing && name) existing = existingByKey.get(nameKey(name)) ?? null;

    const key = existing ? `existing:${existing.id}` : `new:${nameKey(name) || `#${merged.size}`}`;
    let group = merged.get(key);
    if (!group) {
      group = existing
        ? { name: existing.name || name, emoji: '', color: existing.color ?? null, existingGroupId: existing.id, tabIds: [] }
        : {
            name,
            emoji,
            color: TAB_GROUP_COLORS.includes(rawGroup.color) ? rawGroup.color : null,
            existingGroupId: null,
            tabIds: [],
          };
      merged.set(key, group);
    }
    group.tabIds.push(...tabIds);
  }

  // New groups need at least 2 tabs; a single tab may still join an existing group.
  let groups = [...merged.values()].filter((group) => group.existingGroupId !== null || group.tabIds.length >= 2);
  const kept = new Set(
    groups
      .filter((group) => group.existingGroupId === null)
      .sort((a, b) => b.tabIds.length - a.tabIds.length)
      .slice(0, ctx.maxGroups),
  );
  groups = groups.filter((group) => group.existingGroupId !== null || kept.has(group));

  for (const group of groups) {
    if (group.existingGroupId === null && !group.name) {
      group.name = fallbackName(group.tabIds, tabsById, ctx.language);
    }
  }
  assignColors(groups, ctx.existingGroups);

  const grouped = new Set(groups.flatMap((group) => group.tabIds));
  return { groups, ungrouped: ctx.tabIds.filter((id) => !grouped.has(id)) };
}
