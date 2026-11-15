// Undo of a grouping run and "ungroup everything".
import { TAB_GROUP_ID_NONE } from '../shared/tabs.js';
import { withEditRetry } from './grouper.js';

/**
 * Put every tab moved by `run` back into its previous group (or ungrouped) and, best effort, at its
 * previous position. Tabs closed or moved by the user since the run are left alone.
 * @returns {Promise<number[]>} ids of the restored tabs
 */
export async function undoRun(run) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId: run.windowId }),
    chrome.tabGroups.query({ windowId: run.windowId }),
  ]);
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const liveGroups = new Set(groups.map((group) => group.id));

  const restored = [];
  const expectedGroup = new Map(); // tabId -> group it must end up in
  for (const move of run.moves) {
    const tab = tabsById.get(move.tabId);
    if (!tab || tab.groupId !== move.toGroupId) continue;
    const back = move.fromGroupId !== TAB_GROUP_ID_NONE && liveGroups.has(move.fromGroupId) ? move.fromGroupId : TAB_GROUP_ID_NONE;
    expectedGroup.set(move.tabId, back);
    restored.push(move);
  }
  if (restored.length === 0) return [];

  await applyMemberships(expectedGroup);

  // Restore positions in ascending order so that earlier moves do not shift later targets.
  for (const move of [...restored].sort((a, b) => a.fromIndex - b.fromIndex)) {
    try {
      await withEditRetry(() => chrome.tabs.move(move.tabId, { index: move.fromIndex }));
    } catch {
      // the tab was closed meanwhile
    }
  }

  // Moving a tab inside another group's span can make it join that group: fix memberships again.
  const after = await chrome.tabs.query({ windowId: run.windowId });
  const drifted = new Map();
  for (const tab of after) {
    if (expectedGroup.has(tab.id) && tab.groupId !== expectedGroup.get(tab.id)) drifted.set(tab.id, expectedGroup.get(tab.id));
  }
  if (drifted.size) await applyMemberships(drifted);

  return restored.map((move) => move.tabId);
}

async function applyMemberships(expectedGroup) {
  const toUngroup = [];
  const toRegroup = new Map();
  for (const [tabId, groupId] of expectedGroup) {
    if (groupId === TAB_GROUP_ID_NONE) toUngroup.push(tabId);
    else toRegroup.set(groupId, [...(toRegroup.get(groupId) ?? []), tabId]);
  }
  if (toUngroup.length) await withEditRetry(() => chrome.tabs.ungroup(toUngroup));
  for (const [groupId, tabIds] of toRegroup) {
    await withEditRetry(() => chrome.tabs.group({ groupId, tabIds }));
  }
}

/** Ungroup every tab of the window. @returns {Promise<chrome.tabs.Tab[]>} the tabs that were grouped */
export async function ungroupWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const grouped = tabs.filter((tab) => tab.groupId !== TAB_GROUP_ID_NONE);
  if (grouped.length) await withEditRetry(() => chrome.tabs.ungroup(grouped.map((tab) => tab.id)));
  return grouped;
}
