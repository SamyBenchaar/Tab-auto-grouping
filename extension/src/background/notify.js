// Discreet feedback: toolbar badge + optional notification with an "Annuler" button.
import { describeApplied, summarizeRun } from '../shared/format.js';

const BADGE_COLORS = { ok: '#188038', warning: '#e37400', error: '#d93025', busy: '#1a73e8' };
let badgeTimer = null;

export async function showBadge(text, kind = 'ok', clearAfterMs = 10000) {
  clearTimeout(badgeTimer);
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[kind] ?? BADGE_COLORS.ok });
  await chrome.action.setBadgeText({ text });
  if (clearAfterMs) {
    badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => undefined), clearAfterMs);
  }
}

export function runNotificationId(runId) {
  return `run:${runId}`;
}

export async function notifyRun(run, settings) {
  if (!settings.notify || run.applied.length === 0) return;
  await chrome.notifications.create(runNotificationId(run.id), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: summarizeRun(run.applied),
    message: describeApplied(run.applied),
    buttons: [{ title: 'Annuler' }],
    priority: 0,
    silent: true,
  });
}

export async function clearRunNotification(runId) {
  await chrome.notifications.clear(runNotificationId(runId)).catch(() => undefined);
}
