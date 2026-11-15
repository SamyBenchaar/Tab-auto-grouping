// Service worker: event wiring, debounce, threshold, grouping runs, undo, popup/options messages.
import { errorMessage } from '../core/pipeline.js';
import { getGoogleToken, signOutGoogle } from '../shared/auth.js';
import { describeApplied, formatQuota, formatSeconds, sourceLabel, summarizeRun } from '../shared/format.js';
import { isSettingsChange, loadSettings, sanitizeSettings, saveSettings } from '../shared/settings.js';
import { groupTitle, isGrouped, tabUrl, toTabPayload } from '../shared/tabs.js';
import { selectTabs } from '../shared/trigger.js';
import { clearCache } from './cache.js';
import { classifyTabs, describeAccount } from './classifier.js';
import { buildRequest, collectWindow } from './collector.js';
import { applyClassification } from './grouper.js';
import { undoRun, ungroupWindow } from './history.js';
import { clearRunNotification, notifyRun, showBadge } from './notify.js';
import { getStatus, readState, setStatus, withState } from './state.js';

const DEBOUNCE_MS = 2500; // wait for the user to finish opening tabs
const STARTUP_DELAY_MS = 5000; // let session restore finish
const RECHECK_ALARM = /^recheck:(\d+)$/;

const timers = new Map(); // windowId -> debounce timer
const running = new Set(); // windowIds with a run in progress
const recheckAfterRun = new Set();
let pendingRemovals = new Set();
let removalTimer = null;

function reportError(error) {
  console.error('[Tab Context Grouper]', error);
}

// ---------------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------------

export function scheduleCheck(windowId, delay = DEBOUNCE_MS) {
  if (typeof windowId !== 'number' || windowId < 0) return;
  clearTimeout(timers.get(windowId));
  timers.set(
    windowId,
    setTimeout(() => {
      timers.delete(windowId);
      autoCheck(windowId).catch(reportError);
    }, delay),
  );
}

async function checkAllWindows(delay = DEBOUNCE_MS) {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const win of windows) if (!win.incognito) scheduleCheck(win.id, delay);
}

async function isSupportedWindow(windowId) {
  try {
    const win = await chrome.windows.get(windowId);
    return win.type === 'normal' && !win.incognito;
  } catch {
    return false; // window closed
  }
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

export async function autoCheck(windowId) {
  const settings = await loadSettings();
  if (settings.mode !== 'auto') return;
  if (running.has(windowId)) {
    recheckAfterRun.add(windowId);
    return;
  }
  if (!(await isSupportedWindow(windowId))) return;

  const [{ tabs, groups }, state] = await Promise.all([collectWindow(windowId), readState()]);
  const selection = selectTabs({ tabs, groups, seen: state.seen, settings, trigger: 'auto' });
  if (!selection.shouldRun) return;

  const wait = (state.lastRunAt[windowId] ?? 0) + settings.minDelaySeconds * 1000 - Date.now();
  if (wait > 0) {
    // Minimum delay between two automatic groupings: check again later (survives SW shutdown).
    await chrome.alarms.create(`recheck:${windowId}`, { when: Date.now() + wait + 250 });
    return;
  }
  await runGrouping(windowId, 'auto');
}

/** @param {'auto'|'manual'} trigger */
export async function runGrouping(windowId, trigger = 'manual') {
  if (running.has(windowId)) return { ok: false, message: 'Un regroupement est déjà en cours.' };
  running.add(windowId);
  try {
    if (!(await isSupportedWindow(windowId))) {
      return { ok: false, message: 'Fenêtre non prise en charge (navigation privée ou fenêtre spéciale).' };
    }
    const settings = await loadSettings();
    const [{ tabs, groups }, state] = await Promise.all([collectWindow(windowId), readState()]);
    const selection = selectTabs({ tabs, groups, seen: state.seen, settings, trigger });
    if (trigger === 'auto' && !selection.shouldRun) return { ok: true, message: 'Seuil non atteint.' };
    if (selection.payload.length === 0 || (selection.payload.length < 2 && groups.length === 0)) {
      const message = "Pas assez d'onglets à regrouper dans cette fenêtre.";
      await setStatus({ state: 'idle', message, windowId });
      return { ok: true, message };
    }

    await setStatus({ state: 'analyzing', message: `Analyse de ${selection.payload.length} onglets…`, windowId });
    await showBadge('…', 'busy', 0);

    const request = buildRequest(selection.payload, groups, tabs, settings);
    const snapshot = new Map(selection.payload.map((tab) => [tab.id, { url: tabUrl(tab), groupId: tab.groupId }]));
    const result = await classifyTabs(request, settings);
    const applied = await applyClassification({ windowId, result, snapshot, settings });
    const run = {
      id: crypto.randomUUID(),
      trigger,
      ...applied,
      source: result.source,
      model: result.model ?? null,
      latencyMs: result.latencyMs,
      undone: false,
    };

    const sentIds = new Set(request.tabs.map((tab) => tab.id));
    const movedIds = new Set(run.moves.map((move) => move.tabId));
    await withState((draft) => {
      for (const tab of selection.payload) {
        if (!sentIds.has(tab.id)) continue; // beyond the per-request cap: still "new"
        draft.seen[tab.id] = { u: tabUrl(tab), s: movedIds.has(tab.id) || isGrouped(tab) ? 'grouped' : 'analyzed' };
      }
      draft.lastRunAt[windowId] = Date.now();
      if (run.moves.length) draft.history.push(run);
    });

    const summary = run.applied.length ? summarizeRun(run.applied) : 'Aucun regroupement pertinent trouvé.';
    const warning =
      [result.warning, run.errors.length ? `Groupe(s) non appliqué(s) : ${run.errors.join(' ; ')}` : '']
        .filter(Boolean)
        .join(' ') || undefined;
    await setStatus({
      state: warning ? 'warning' : 'idle',
      message: summary,
      warning,
      windowId,
      lastRun: {
        id: run.id,
        summary,
        details: describeApplied(run.applied),
        source: sourceLabel(result.source, result.model),
        latency: formatSeconds(result.latencyMs),
        quota: formatQuota(result.quota) || undefined,
        trigger,
        at: run.at,
      },
    });
    await showBadge(run.applied.length ? String(run.applied.length) : '', warning ? 'warning' : 'ok');
    await notifyRun(run, settings).catch(reportError);
    return { ok: true, message: summary, warning };
  } catch (error) {
    const message = errorMessage(error);
    reportError(error);
    await setStatus({ state: 'error', message, windowId }).catch(reportError);
    await showBadge('!', 'error', 15000).catch(reportError);
    return { ok: false, message };
  } finally {
    running.delete(windowId);
    if (recheckAfterRun.delete(windowId)) scheduleCheck(windowId);
  }
}

async function undoById(runId) {
  const state = await readState();
  const run = state.history.find((item) => item.id === runId);
  if (!run || run.undone) return { ok: false, message: 'Ce regroupement a déjà été annulé.' };

  const restoredIds = await undoRun(run);
  await withState((draft) => {
    const stored = draft.history.find((item) => item.id === runId);
    if (stored) stored.undone = true;
    // The user rejected this grouping: these tabs will not be regrouped automatically.
    for (const tabId of restoredIds) if (draft.seen[tabId]) draft.seen[tabId].s = 'rejected';
    draft.lastRunAt[run.windowId] = Date.now();
  });
  await clearRunNotification(runId);
  await showBadge('', 'ok', 0);
  const message = `Regroupement annulé (${restoredIds.length} onglet${restoredIds.length > 1 ? 's' : ''} restauré${restoredIds.length > 1 ? 's' : ''}).`;
  await setStatus({ state: 'idle', message, windowId: run.windowId });
  return { ok: true, message };
}

export async function undoLast(windowId) {
  const state = await readState();
  const run = [...state.history].reverse().find((item) => item.windowId === windowId && !item.undone);
  if (!run) return { ok: false, message: 'Rien à annuler dans cette fenêtre.' };
  return undoById(run.id);
}

export async function ungroupAll(windowId) {
  const tabs = await ungroupWindow(windowId);
  await withState((draft) => {
    for (const tab of tabs) draft.seen[tab.id] = { u: tabUrl(tab), s: 'rejected' };
    for (const run of draft.history) if (run.windowId === windowId) run.undone = true;
    draft.lastRunAt[windowId] = Date.now();
  });
  const message = tabs.length ? `${tabs.length} onglet${tabs.length > 1 ? 's' : ''} dégroupé${tabs.length > 1 ? 's' : ''}.` : 'Aucun onglet groupé.';
  await setStatus({ state: 'idle', message, windowId });
  return { ok: true, message };
}

// ---------------------------------------------------------------------------------------------
// Popup / options API
// ---------------------------------------------------------------------------------------------

export async function getPopupState(windowId) {
  const settings = await loadSettings();
  const [{ tabs, groups }, state, status, account] = await Promise.all([
    collectWindow(windowId),
    readState(),
    getStatus(),
    settings.provider === 'backend' ? describeAccount(settings, { checkBackend: false }) : null,
  ]);
  const selection = selectTabs({ tabs, groups, seen: state.seen, settings, trigger: 'auto' });
  const groupTabs = (groupId) => tabs.filter((tab) => tab.groupId === groupId);
  return {
    ok: true,
    mode: settings.mode,
    provider: settings.provider,
    model: settings.geminiModel,
    backendUrl: settings.backendUrl,
    account: account?.mode ?? null, // 'owner' | 'google' | 'signed-out' | 'unavailable' (backend only)
    counts: {
      total: tabs.length,
      ungrouped: selection.ungroupedTotal,
      newCount: selection.newCount,
      required: selection.required,
    },
    groups: groups
      .map((group) => ({
        id: group.id,
        title: group.title ?? '',
        color: group.color,
        count: groupTabs(group.id).length,
        index: Math.min(...groupTabs(group.id).map((tab) => tab.index)),
      }))
      .sort((a, b) => a.index - b.index),
    status: status.windowId === undefined || status.windowId === windowId ? status : { state: 'idle', message: '' },
    canUndo: state.history.some((run) => run.windowId === windowId && !run.undone),
    running: running.has(windowId),
  };
}

const SAMPLE_TABS = [
  { id: 1, title: 'Peugeot 208 occasion - La Centrale', url: 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PEUGEOT%3A208' },
  { id: 2, title: 'Comparatif SUV électriques 2026 - Caradisiac', url: 'https://www.caradisiac.com/comparatif-suv-electriques' },
  { id: 3, title: 'meilleur restaurant italien paris - Recherche Google', url: 'https://www.google.com/search?q=meilleur+restaurant+italien+paris' },
  { id: 4, title: 'TheFork - Réservez les meilleurs restaurants à Paris', url: 'https://www.thefork.fr/restaurants/paris-c415144' },
];

/** "Tester la connexion" (options page): sample request, no cache, no silent fallback. */
async function testProvider(rawSettings) {
  const settings = sanitizeSettings(rawSettings);
  const request = { tabs: SAMPLE_TABS.map(toTabPayload), existingGroups: [], language: settings.language, maxGroups: settings.maxGroups };
  const result = await classifyTabs(request, settings, { useCache: false, fallback: false });
  const names = result.groups.map((group) => groupTitle(group.emoji, group.name));
  const degraded = settings.provider !== 'heuristic' && result.source === 'heuristic';
  const quota = formatQuota(result.quota);
  return {
    ok: !degraded,
    message: `${degraded ? 'Attention' : 'OK'} : ${names.length} groupe(s) (${names.join(', ') || 'aucun'}) en ${formatSeconds(result.latencyMs)} via ${sourceLabel(result.source, result.model)}${quota ? ` · ${quota}` : ''}.${result.warning ? ` ${result.warning}` : ''}`,
  };
}

/** "Se connecter avec Google" (popup / options): Chrome shows Google's consent window once. */
async function signIn() {
  try {
    await getGoogleToken({ interactive: true });
  } catch (error) {
    const text = errorMessage(error);
    const message = /did not approve|cancel|closed/i.test(text) ? 'Connexion annulée.' : `Connexion Google impossible : ${text}`;
    return { ok: false, mode: 'signed-out', message };
  }
  const account = await describeAccount(await loadSettings());
  await setStatus({ state: 'idle', message: "Connecté avec Google : regroupement par IA activé." }).catch(reportError);
  return account;
}

async function signOut() {
  await signOutGoogle();
  return describeAccount(await loadSettings(), { checkBackend: false });
}

export async function handleMessage(message) {
  switch (message?.type) {
    case 'getState':
      return getPopupState(message.windowId);
    case 'groupNow':
      return runGrouping(message.windowId, 'manual');
    case 'undo':
      return undoLast(message.windowId);
    case 'ungroupAll':
      return ungroupAll(message.windowId);
    case 'setMode':
      await saveSettings({ mode: message.mode === 'manual' ? 'manual' : 'auto' });
      return { ok: true };
    case 'testProvider':
      return testProvider(message.settings);
    case 'getAccount':
      return describeAccount(message.settings ? sanitizeSettings(message.settings) : await loadSettings());
    case 'signIn':
      return signIn();
    case 'signOut':
      return signOut();
    case 'clearCache':
      await clearCache();
      return { ok: true, message: 'Cache vidé.' };
    default:
      return { ok: false, message: 'Message inconnu.' };
  }
}

// ---------------------------------------------------------------------------------------------
// Event listeners (registered synchronously at top level, as Manifest V3 requires)
// ---------------------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage().catch(reportError);
});

chrome.runtime.onStartup.addListener(() => {
  checkAllWindows(STARTUP_DELAY_MS).catch(reportError);
});

chrome.tabs.onCreated.addListener((tab) => scheduleCheck(tab.windowId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) scheduleCheck(tab.windowId);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => scheduleCheck(attachInfo.newWindowId));

chrome.tabs.onRemoved.addListener((tabId) => {
  // Batched: closing a window removes many tabs at once.
  pendingRemovals.add(tabId);
  clearTimeout(removalTimer);
  removalTimer = setTimeout(() => {
    const ids = [...pendingRemovals];
    pendingRemovals = new Set();
    withState((draft) => {
      for (const id of ids) delete draft.seen[id];
    }).catch(reportError);
  }, 1000);
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearTimeout(timers.get(windowId));
  timers.delete(windowId);
  chrome.alarms.clear(`recheck:${windowId}`).catch(reportError);
  withState((draft) => {
    delete draft.lastRunAt[windowId];
    draft.history = draft.history.filter((run) => run.windowId !== windowId);
  }).catch(reportError);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  const match = RECHECK_ALARM.exec(alarm.name);
  if (match) autoCheck(Number(match[1])).catch(reportError);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'group-now') return;
  (async () => {
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
    await runGrouping(windowId, 'manual');
  })().catch(reportError);
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0 && notificationId.startsWith('run:')) undoById(notificationId.slice(4)).catch(reportError);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId).catch(reportError);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (isSettingsChange(changes, areaName)) checkAllWindows().catch(reportError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(message).then(sendResponse, (error) => sendResponse({ ok: false, message: errorMessage(error) }));
  return true; // asynchronous response
});
