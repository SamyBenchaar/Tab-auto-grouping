// Popup: counts for the current window, status, actions, groups (inline rename).
import { splitLeadingEmoji } from '../core/text.js';
import { groupTitle } from '../shared/tabs.js';

const $ = (id) => document.getElementById(id);
let windowId = null;
let lastState = null;
let refreshTimer = null;
let renaming = false;

const ENGINE_LABELS = {
  backend: (state) => `Backend · ${safeHost(state.backendUrl)}`,
  gemini: (state) => `Gemini direct · ${state.model}`,
  heuristic: () => 'Heuristique locale (sans IA)',
};

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function send(message) {
  return chrome.runtime.sendMessage({ ...message, windowId });
}

function setText(id, text) {
  $(id).textContent = text;
}

function showStatus(status, lastRun) {
  const box = $('status');
  box.dataset.state = status.state ?? 'idle';
  const idleMessage = lastState?.mode === 'manual' ? 'Mode manuel : cliquez sur « Regrouper maintenant ».' : 'En attente du seuil.';
  setText('status-message', status.message || idleMessage);
  const detail = $('status-detail');
  const engine = lastRun ? [lastRun.source, lastRun.latency, lastRun.quota].filter(Boolean).join(' · ') : '';
  const details = lastRun && status.state !== 'analyzing' ? [lastRun.details, engine].filter(Boolean).join(' — ') : '';
  detail.hidden = !details;
  detail.textContent = details;
  const warning = $('status-warning');
  warning.hidden = !status.warning;
  warning.textContent = status.warning ?? '';
}

function renderGroups(groups) {
  if (renaming) return; // do not destroy an input being edited
  const list = $('group-list');
  list.replaceChildren();
  $('groups-empty').hidden = groups.length > 0;
  const template = $('group-item');
  for (const group of groups) {
    const item = template.content.firstElementChild.cloneNode(true);
    item.querySelector('.group-dot').style.background = `var(--g-${group.color})`;
    const name = item.querySelector('.group-name');
    name.textContent = group.title || 'Sans nom';
    name.addEventListener('click', () => startRename(item, group));
    item.querySelector('.group-count').textContent = `${group.count} onglet${group.count > 1 ? 's' : ''}`;
    list.append(item);
  }
}

function startRename(item, group) {
  renaming = true;
  const name = item.querySelector('.group-name');
  const { emoji, name: currentName } = splitLeadingEmoji(group.title);
  const input = document.createElement('input');
  input.className = 'group-rename';
  input.value = currentName;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Nouveau nom du groupe');
  name.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renaming = false;
    const value = input.value.trim();
    if (save && value && value !== currentName) {
      // Keep the emoji unless the user typed a new one.
      const title = splitLeadingEmoji(value).emoji ? value : groupTitle(emoji, value);
      try {
        await chrome.tabGroups.update(group.id, { title });
      } catch (error) {
        showStatus({ state: 'error', message: `Renommage impossible : ${error.message}` });
      }
    }
    refresh();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function render(state) {
  lastState = state;
  const { counts } = state;
  setText('count-total', String(counts.total));
  setText('count-ungrouped', String(counts.ungrouped));
  const progress = Math.min(counts.newCount, counts.required);
  setText('count-threshold', state.mode === 'auto' ? `${progress}/${counts.required}` : '–');
  setText(
    'threshold-label',
    state.mode === 'auto' ? (state.groups.length ? 'nouveaux (incrémental)' : 'avant regroupement') : 'mode manuel',
  );
  $('threshold-meter').style.width = state.mode === 'auto' ? `${(progress / counts.required) * 100}%` : '0';

  for (const button of document.querySelectorAll('.segmented button')) {
    button.setAttribute('aria-checked', String(button.dataset.mode === state.mode));
  }

  const analyzing = state.running || state.status.state === 'analyzing';
  $('group-now').disabled = analyzing || counts.total === 0;
  $('undo').disabled = analyzing || !state.canUndo;
  $('ungroup-all').disabled = analyzing || state.groups.length === 0;

  showStatus(state.status, state.status.lastRun);
  $('signin').hidden = !(state.provider === 'backend' && state.account === 'signed-out');
  renderGroups(state.groups);
  setText('engine', (ENGINE_LABELS[state.provider] ?? ENGINE_LABELS.heuristic)(state));
}

async function refresh() {
  try {
    const state = await send({ type: 'getState' });
    if (state?.ok) render(state);
    else showStatus({ state: 'error', message: state?.message ?? 'Service indisponible.' });
  } catch (error) {
    showStatus({ state: 'error', message: `Service indisponible : ${error.message}` });
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
}

async function action(type, button) {
  button.disabled = true;
  try {
    const result = await send({ type });
    if (result && !result.ok) showStatus({ state: 'error', message: result.message });
  } catch (error) {
    showStatus({ state: 'error', message: error.message });
  } finally {
    refresh();
  }
}

async function init() {
  windowId = (await chrome.windows.getCurrent()).id;

  $('group-now').addEventListener('click', (event) => action('groupNow', event.currentTarget));
  $('undo').addEventListener('click', (event) => action('undo', event.currentTarget));
  $('ungroup-all').addEventListener('click', (event) => action('ungroupAll', event.currentTarget));
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  // Handled by the service worker: the popup closes as soon as Google's window takes the focus.
  $('sign-in').addEventListener('click', (event) => action('signIn', event.currentTarget));
  for (const button of document.querySelectorAll('.segmented button')) {
    button.addEventListener('click', async () => {
      await send({ type: 'setMode', mode: button.dataset.mode });
      refresh();
    });
  }

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((command) => command.name === 'group-now')?.shortcut;
  $('shortcut').hidden = !shortcut;
  $('shortcut').textContent = shortcut ?? '';

  // Live updates while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'session' && changes.status) || (area === 'local' && changes.settings)) scheduleRefresh();
  });
  chrome.tabs.onCreated.addListener(scheduleRefresh);
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onUpdated.addListener(scheduleRefresh);
  chrome.tabGroups.onCreated.addListener(scheduleRefresh);
  chrome.tabGroups.onUpdated.addListener(scheduleRefresh);
  chrome.tabGroups.onRemoved.addListener(scheduleRefresh);

  chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
  await refresh();
}

init();
