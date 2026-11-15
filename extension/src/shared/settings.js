// User settings: defaults, validation (pure) and persistence in chrome.storage.local.
import { DEFAULT_GEMINI_MODEL, DEFAULT_MAX_GROUPS, LIMITS } from '../core/constants.js';

export const PROVIDERS = Object.freeze(['backend', 'gemini', 'heuristic']);

export const LANGUAGES = Object.freeze([
  ['fr', 'Français'],
  ['en', 'English'],
  ['es', 'Español'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['nl', 'Nederlands'],
]);

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'auto', // 'auto' | 'manual'
  threshold: 10, // ungrouped tabs needed for the first automatic grouping (5–50)
  incrementalThreshold: 3, // new ungrouped tabs needed once the window has groups
  minDelaySeconds: 30, // minimum delay between two automatic groupings
  maxGroups: DEFAULT_MAX_GROUPS,
  language: 'fr',
  includeGroupedTabs: false, // "tout regrouper": already grouped tabs may be reorganised
  collapseInactive: false,
  notify: true,
  excludedDomains: [],
  provider: 'backend', // 'backend' (Cloud Run) | 'gemini' (AI Studio key, prototype) | 'heuristic'
  backendUrl: 'https://tab-classifier-11839059749.europe-west1.run.app',
  backendToken: '',
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  cacheEnabled: true,
});

const SETTINGS_KEY = 'settings';

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

/** "https://www.Banque.fr/compte" -> "banque.fr"; invalid input -> ''. */
export function normalizeDomain(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/^\*\./, '');
  if (!text) return '';
  try {
    const host = new URL(text.includes('://') ? text : `http://${text}`).hostname.replace(/^www\d?\./, '');
    return host === 'localhost' || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
  } catch {
    return '';
  }
}

/** Only HTTPS, or plain HTTP on localhost (the token must never travel in clear text). */
export function normalizeBackendUrl(value) {
  const text = String(value ?? '').trim();
  try {
    const url = new URL(text);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) {
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }
  } catch {
    // fall through
  }
  return null;
}

export function sanitizeSettings(raw) {
  const source = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const domains = Array.isArray(source.excludedDomains)
    ? source.excludedDomains
    : String(source.excludedDomains ?? '').split(/[\s,;]+/);
  const model = String(source.geminiModel ?? '').trim();
  return {
    mode: source.mode === 'manual' ? 'manual' : 'auto',
    threshold: clampInt(source.threshold, 5, 50, DEFAULT_SETTINGS.threshold),
    incrementalThreshold: clampInt(source.incrementalThreshold, 1, 20, DEFAULT_SETTINGS.incrementalThreshold),
    minDelaySeconds: clampInt(source.minDelaySeconds, 10, 600, DEFAULT_SETTINGS.minDelaySeconds),
    maxGroups: clampInt(source.maxGroups, 1, LIMITS.maxGroupsCap, DEFAULT_SETTINGS.maxGroups),
    language: LANGUAGES.some(([code]) => code === source.language) ? source.language : DEFAULT_SETTINGS.language,
    includeGroupedTabs: Boolean(source.includeGroupedTabs),
    collapseInactive: Boolean(source.collapseInactive),
    notify: source.notify !== false,
    excludedDomains: [...new Set(domains.map(normalizeDomain).filter(Boolean))].slice(0, 200),
    provider: PROVIDERS.includes(source.provider) ? source.provider : DEFAULT_SETTINGS.provider,
    backendUrl: normalizeBackendUrl(source.backendUrl) ?? DEFAULT_SETTINGS.backendUrl,
    backendToken: String(source.backendToken ?? '').trim().slice(0, 500),
    geminiApiKey: String(source.geminiApiKey ?? '').trim().slice(0, 200),
    geminiModel: /^[a-z0-9][a-z0-9.-]{2,60}$/i.test(model) ? model : DEFAULT_GEMINI_MODEL,
    cacheEnabled: source.cacheEnabled !== false,
  };
}

export async function loadSettings() {
  const { [SETTINGS_KEY]: raw } = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(raw);
}

export async function saveSettings(partial) {
  const next = sanitizeSettings({ ...(await loadSettings()), ...partial });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function isSettingsChange(changes, areaName) {
  return areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, SETTINGS_KEY);
}
