// Pure helpers about Chrome tabs: eligibility, data-minimised payload, group titles.
import { LIMITS } from '../core/constants.js';
import { cleanText, splitLeadingEmoji } from '../core/text.js';
import { getDomain, parseHttpUrl, toModelUrl } from '../core/url.js';
import { extractSearchQuery } from './searchQuery.js';

/** Same value as chrome.tabGroups.TAB_GROUP_ID_NONE (usable outside Chrome, e.g. in tests). */
export const TAB_GROUP_ID_NONE = -1;

export function tabUrl(tab) {
  return tab?.url || tab?.pendingUrl || '';
}

export function isGrouped(tab) {
  return typeof tab.groupId === 'number' && tab.groupId !== TAB_GROUP_ID_NONE;
}

export function isExcludedDomain(domain, excludedDomains = []) {
  return excludedDomains.some((excluded) => domain === excluded || domain.endsWith(`.${excluded}`));
}

/** Pinned tabs, private windows, non-http(s) pages (chrome://, about:, file:…) and excluded domains are never sent. */
export function isEligibleTab(tab, settings) {
  if (!tab || tab.pinned || tab.incognito || typeof tab.id !== 'number') return false;
  const url = parseHttpUrl(tabUrl(tab));
  if (!url) return false;
  return !isExcludedDomain(getDomain(url.href), settings.excludedDomains);
}

/** What is sent for a tab: title, domain, search query, host + path (no query string). */
export function toTabPayload(tab) {
  const raw = tabUrl(tab);
  const domain = getDomain(raw);
  return {
    id: tab.id,
    title: cleanText(tab.title ?? '', LIMITS.titleLength) || domain,
    domain,
    query: extractSearchQuery(raw),
    url: toModelUrl(raw),
  };
}

export function groupTitle(emoji, name) {
  return [emoji, name].filter(Boolean).join(' ');
}

/** Existing groups of a window as sent to the classifier (emoji stripped, a few example titles). */
export function buildExistingGroups(groups, tabs, settings) {
  return groups.map((group) => {
    const examples = tabs
      .filter((tab) => tab.groupId === group.id && isEligibleTab(tab, settings))
      .slice(0, LIMITS.maxExamplesPerGroup)
      .map((tab) => cleanText(tab.title ?? '', LIMITS.exampleLength))
      .filter(Boolean);
    return { id: group.id, name: splitLeadingEmoji(group.title ?? '').name, color: group.color, examples };
  });
}
