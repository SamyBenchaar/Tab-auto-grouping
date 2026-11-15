// Application of a validated classification to Chrome tab groups.
import { groupTitle, tabUrl } from '../shared/tabs.js';

const EDIT_RETRIES = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome refuses tab edits while the user is dragging a tab: retry a few times. */
export async function withEditRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (attempt >= EDIT_RETRIES || !/cannot be edited|dragging/i.test(message)) throw error;
      await sleep(200 * (attempt + 1));
    }
  }
}

function recordMoves(moves, tabIds, tabsById, toGroupId) {
  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    moves.push({ tabId, fromGroupId: tab.groupId, fromIndex: tab.index, toGroupId });
  }
}

export async function collapseInactiveGroups(windowId) {
  const [[active], groups] = await Promise.all([
    chrome.tabs.query({ windowId, active: true }),
    chrome.tabGroups.query({ windowId }),
  ]);
  for (const group of groups) {
    if (group.id !== active?.groupId && !group.collapsed) {
      await withEditRetry(() => chrome.tabGroups.update(group.id, { collapsed: true }));
    }
  }
}

/**
 * @param {{windowId: number, result: {groups: object[]}, snapshot: Map<number, {url: string, groupId: number}>,
 *          settings: object}} params snapshot = state of each tab when it was sent for analysis
 * @returns {Promise<{windowId: number, at: number, moves: object[], created: number[], applied: object[], errors: string[]}>}
 */
export async function applyClassification({ windowId, result, snapshot, settings }) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const moves = [];
  const created = [];
  const applied = [];
  const errors = [];

  // Only touch a tab that still exists in this window (never move tabs across windows), is not
  // pinned, and has kept its URL and group since it was analysed (the user may have acted meanwhile).
  const isUnchanged = (tabId) => {
    const tab = tabsById.get(tabId);
    const before = snapshot.get(tabId);
    return Boolean(
      tab && before && tab.windowId === windowId && !tab.pinned && tabUrl(tab) === before.url && tab.groupId === before.groupId,
    );
  };

  for (const group of result.groups) {
    const tabIds = group.tabIds.filter(isUnchanged);
    const target = group.existingGroupId !== null ? groupsById.get(group.existingGroupId) : undefined;
    try {
      if (target) {
        const toMove = tabIds.filter((tabId) => tabsById.get(tabId).groupId !== target.id);
        if (toMove.length === 0) continue;
        await withEditRetry(() => chrome.tabs.group({ groupId: target.id, tabIds: toMove }));
        recordMoves(moves, toMove, tabsById, target.id);
        applied.push({ groupId: target.id, title: target.title ?? '', color: target.color, count: toMove.length, existing: true });
        continue;
      }
      // New group (or an existing group that disappeared during the analysis).
      if (tabIds.length < 2) continue;
      const groupId = await withEditRetry(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }));
      recordMoves(moves, tabIds, tabsById, groupId);
      const title = groupTitle(group.emoji, group.name);
      await withEditRetry(() => chrome.tabGroups.update(groupId, { title, color: group.color, collapsed: false }));
      created.push(groupId);
      applied.push({ groupId, title, color: group.color, count: tabIds.length, existing: false });
    } catch (error) {
      errors.push(`${group.name} : ${error?.message ?? error}`);
    }
  }

  if (settings.collapseInactive && applied.length) {
    await collapseInactiveGroups(windowId).catch((error) => errors.push(String(error?.message ?? error)));
  }
  return { windowId, at: Date.now(), moves, created, applied, errors };
}
