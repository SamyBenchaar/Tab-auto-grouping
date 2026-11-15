// Trigger logic (pure): which tabs take part in a run, and should an automatic run start?
//
// `seen` remembers, per tab id, the URL that was last analysed and its outcome:
//   - 'analyzed': sent to the classifier and left ungrouped -> still sent, but not counted as new;
//   - 'grouped' : grouped by us; if it is ungrouped now, the user took it out -> never auto-regrouped;
//   - 'rejected': the user undid the grouping / ungrouped everything -> never auto-regrouped.
// A tab that navigates to another URL becomes new again.
import { isEligibleTab, isGrouped, tabUrl } from './tabs.js';

/**
 * @param {{tabs: chrome.tabs.Tab[], groups: chrome.tabGroups.TabGroup[],
 *          seen?: Record<string, {u: string, s: string}>, settings: object, trigger?: 'auto'|'manual'}} params
 */
export function selectTabs({ tabs, groups, seen = {}, settings, trigger = 'auto' }) {
  const ungrouped = [];
  const grouped = [];
  const rejected = [];
  let newCount = 0;
  let ungroupedTotal = 0;

  for (const tab of tabs) {
    if (!isEligibleTab(tab, settings)) continue;
    if (isGrouped(tab)) {
      grouped.push(tab);
      continue;
    }
    ungroupedTotal += 1;
    const entry = seen[tab.id];
    const known = Boolean(entry) && entry.u === tabUrl(tab);
    if (known && (entry.s === 'grouped' || entry.s === 'rejected')) {
      rejected.push(tab.id);
      if (trigger === 'manual') ungrouped.push(tab); // an explicit request includes everything
      continue;
    }
    if (!known) newCount += 1;
    ungrouped.push(tab);
  }

  // The threshold only counts ungrouped tabs; it is lower once the window already has groups.
  const required = groups.length > 0 ? settings.incrementalThreshold : settings.threshold;
  const payload = settings.includeGroupedTabs ? [...ungrouped, ...grouped] : ungrouped;
  const shouldRun =
    trigger === 'manual' ? payload.length > 0 : settings.mode === 'auto' && newCount >= required;

  return { payload, ungroupedTotal, groupedCount: grouped.length, newCount, required, rejected, shouldRun };
}
