// Collection of the tabs / groups of a window and construction of the classification request.
import { buildExistingGroups, toTabPayload } from '../shared/tabs.js';

export async function collectWindow(windowId) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
  return { tabs, groups };
}

/** Request body sent to the classifier (POST /classify or direct Gemini). */
export function buildRequest(payloadTabs, groups, allTabs, settings) {
  return {
    tabs: payloadTabs.map(toTabPayload),
    existingGroups: buildExistingGroups(groups, allTabs, settings),
    language: settings.language,
    maxGroups: settings.maxGroups,
  };
}
