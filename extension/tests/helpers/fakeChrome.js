// In-memory fake of the chrome.* APIs used by the extension, with realistic tab-group semantics:
// grouped tabs are contiguous, empty groups disappear, moving a tab inside a group's span makes it
// join that group, ungrouping moves the tab right after its former group.

const NONE = -1;

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (listener) => listeners.push(listener),
    removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
    hasListener: (listener) => listeners.includes(listener),
    dispatch: (...args) => listeners.map((listener) => listener(...args)),
  };
}

export function createFakeChrome() {
  let nextTabId = 100;
  let nextGroupId = 5000;
  let nextWindowId = 1;
  const windows = new Map();
  const tabs = []; // all tabs, kept ordered by (windowId, index)
  const groups = new Map();
  const alarms = new Map();
  const notifications = new Map();
  const badge = { text: '', color: null };
  const calls = { group: 0, ungroup: 0, move: 0 };
  const onChanged = createEvent();
  let dispatchStorageEvents = false;

  const clone = (value) => (value === undefined ? undefined : structuredClone(value));

  function storageArea(areaName) {
    let data = {};
    return {
      async get(keys) {
        if (keys === null || keys === undefined) return clone(data);
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const result = {};
        for (const key of list) {
          if (key in data) result[key] = clone(data[key]);
          else if (keys && typeof keys === 'object' && !Array.isArray(keys)) result[key] = clone(keys[key]);
        }
        return result;
      },
      async set(items) {
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: clone(data[key]), newValue: clone(value) };
          data[key] = clone(value);
        }
        if (dispatchStorageEvents) onChanged.dispatch(changes, areaName);
      },
      async remove(keys) {
        for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
      },
      async clear() {
        data = {};
      },
    };
  }

  const windowTabs = (windowId) => tabs.filter((tab) => tab.windowId === windowId).sort((a, b) => a.index - b.index);

  function reorder(windowId, ordered) {
    ordered.forEach((tab, index) => {
      tab.index = index;
    });
    const others = tabs.filter((tab) => tab.windowId !== windowId);
    tabs.length = 0;
    tabs.push(...others, ...ordered);
  }

  function dropEmptyGroups() {
    for (const id of [...groups.keys()]) {
      if (!tabs.some((tab) => tab.groupId === id)) groups.delete(id);
    }
  }

  function findTab(tabId) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  }

  /** Re-establish contiguity: a tab sandwiched inside another group's span joins that group. */
  function enforceContiguity(windowId) {
    const ordered = windowTabs(windowId);
    for (let i = 1; i < ordered.length - 1; i += 1) {
      const [left, tab, right] = [ordered[i - 1], ordered[i], ordered[i + 1]];
      if (left.groupId !== NONE && left.groupId === right.groupId && tab.groupId !== left.groupId) tab.groupId = left.groupId;
    }
  }

  const chrome = {
    runtime: {
      id: 'fake-extension-id',
      lastError: undefined,
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent(),
      openOptionsPage: async () => undefined,
      getURL: (path) => `chrome-extension://fake-extension-id/${path}`,
      sendMessage: async () => undefined,
    },
    windows: {
      WINDOW_ID_NONE: NONE,
      async get(windowId) {
        const win = windows.get(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}.`);
        return { ...win };
      },
      async getAll() {
        return [...windows.values()].map((win) => ({ ...win }));
      },
      async getLastFocused() {
        return { ...[...windows.values()][0] };
      },
      async getCurrent() {
        return { ...[...windows.values()][0] };
      },
      onRemoved: createEvent(),
    },
    tabs: {
      TAB_ID_NONE: NONE,
      async query({ windowId, active } = {}) {
        return tabs
          .filter((tab) => (windowId === undefined || tab.windowId === windowId) && (active === undefined || tab.active === active))
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
          .map((tab) => ({ ...tab }));
      },
      async get(tabId) {
        return { ...findTab(tabId) };
      },
      async group({ tabIds, groupId, createProperties }) {
        calls.group += 1;
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        const moving = ids.map(findTab);
        let group;
        if (groupId !== undefined) {
          group = groups.get(groupId);
          if (!group) throw new Error(`No group with id: ${groupId}.`);
        } else {
          const windowId = createProperties?.windowId ?? moving[0].windowId;
          group = { id: nextGroupId++, windowId, title: '', color: 'grey', collapsed: false };
          groups.set(group.id, group);
        }
        const windowId = group.windowId;
        const remaining = windowTabs(windowId).filter((tab) => !ids.includes(tab.id));
        for (const tab of moving) {
          tab.windowId = windowId; // Chrome moves tabs into the group's window
          tab.groupId = group.id;
        }
        const members = remaining.filter((tab) => tab.groupId === group.id);
        let insertAt;
        if (members.length) insertAt = remaining.indexOf(members[members.length - 1]) + 1;
        else {
          const firstIndex = Math.min(...moving.map((tab) => tab.index));
          insertAt = remaining.filter((tab) => tab.index < firstIndex).length;
        }
        remaining.splice(insertAt, 0, ...moving.sort((a, b) => a.index - b.index));
        reorder(windowId, remaining);
        dropEmptyGroups();
        return group.id;
      },
      async ungroup(tabIds) {
        calls.ungroup += 1;
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = findTab(tabId);
          if (tab.groupId === NONE) continue;
          const formerGroup = tab.groupId;
          tab.groupId = NONE;
          const ordered = windowTabs(tab.windowId).filter((item) => item !== tab);
          const lastMember = ordered.filter((item) => item.groupId === formerGroup).pop();
          const insertAt = lastMember ? ordered.indexOf(lastMember) + 1 : Math.min(tab.index, ordered.length);
          ordered.splice(insertAt, 0, tab);
          reorder(tab.windowId, ordered);
        }
        dropEmptyGroups();
      },
      async move(tabId, { index }) {
        calls.move += 1;
        const tab = findTab(tabId);
        const ordered = windowTabs(tab.windowId).filter((item) => item !== tab);
        const target = index < 0 ? ordered.length : Math.min(index, ordered.length);
        ordered.splice(target, 0, tab);
        reorder(tab.windowId, ordered);
        // A grouped tab moved away from its group leaves it; a tab moved inside a group joins it.
        if (tab.groupId !== NONE) {
          const neighbours = [ordered[target - 1], ordered[target + 1]].filter(Boolean);
          if (!neighbours.some((item) => item.groupId === tab.groupId) && ordered.some((item) => item !== tab && item.groupId === tab.groupId)) {
            tab.groupId = NONE;
          }
        }
        enforceContiguity(tab.windowId);
        dropEmptyGroups();
        return { ...tab };
      },
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = findTab(tabId);
          tabs.splice(tabs.indexOf(tab), 1);
          reorder(tab.windowId, windowTabs(tab.windowId));
        }
        dropEmptyGroups();
      },
      async create({ url, windowId }) {
        return api.addTab(windowId ?? [...windows.keys()][0], { url, title: url });
      },
      onCreated: createEvent(),
      onUpdated: createEvent(),
      onRemoved: createEvent(),
      onAttached: createEvent(),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: NONE,
      async query({ windowId } = {}) {
        return [...groups.values()].filter((group) => windowId === undefined || group.windowId === windowId).map((group) => ({ ...group }));
      },
      async get(groupId) {
        const group = groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        return { ...group };
      },
      async update(groupId, properties) {
        const group = groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        Object.assign(group, properties);
        return { ...group };
      },
      onCreated: createEvent(),
      onUpdated: createEvent(),
      onRemoved: createEvent(),
    },
    storage: { local: storageArea('local'), session: storageArea('session'), onChanged },
    alarms: {
      async create(name, info) {
        alarms.set(name, info);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: createEvent(),
    },
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badge.color = color;
      },
    },
    notifications: {
      async create(id, options) {
        notifications.set(id, options);
        return id;
      },
      async clear(id) {
        return notifications.delete(id);
      },
      onButtonClicked: createEvent(),
      onClicked: createEvent(),
    },
    commands: { onCommand: createEvent(), getAll: async () => [{ name: 'group-now', shortcut: 'Alt+G' }] },
  };

  const api = {
    chrome,
    tabs,
    groups,
    alarms,
    notifications,
    badge,
    calls,
    setDispatchStorageEvents(value) {
      dispatchStorageEvents = value;
    },
    addWindow({ incognito = false, type = 'normal' } = {}) {
      const id = nextWindowId++;
      windows.set(id, { id, incognito, type, focused: windows.size === 0 });
      return id;
    },
    addTab(windowId, { url, title = '', pinned = false, active = false }) {
      const tab = {
        id: nextTabId++,
        windowId,
        index: windowTabs(windowId).length,
        url,
        title,
        pinned,
        active,
        incognito: windows.get(windowId)?.incognito ?? false,
        groupId: NONE,
        status: 'complete',
      };
      tabs.push(tab);
      return { ...tab };
    },
    removeTabNow(tabId) {
      const tab = findTab(tabId);
      tabs.splice(tabs.indexOf(tab), 1);
      reorder(tab.windowId, windowTabs(tab.windowId));
      dropEmptyGroups();
    },
    order(windowId) {
      return windowTabs(windowId).map((tab) => tab.id);
    },
    groupOf(tabId) {
      return findTab(tabId).groupId;
    },
    titleOf(groupId) {
      return groups.get(groupId)?.title;
    },
  };
  return api;
}
