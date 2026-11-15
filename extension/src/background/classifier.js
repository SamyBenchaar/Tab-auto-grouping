// Classification providers: Cloud Run backend (production), direct Gemini API (prototype),
// local heuristic (offline). Network failures fall back to the heuristic so grouping still works.
// Backend credentials: the owner token when one is set (no daily limit), otherwise Google sign-in.
import {
  callGeminiApi,
  classifyHeuristically,
  contextFromRequest,
  errorMessage,
  normalizeClassification,
  normalizeClassifyRequest,
  runClassification,
} from '../core/index.js';
import { dropGoogleToken, getGoogleToken, isGoogleSignInAvailable } from '../shared/auth.js';
import { formatTime } from '../shared/format.js';
import { lookupCachedClassification, storeClassification } from './cache.js';

// The backend allows 8 s per Gemini attempt plus one retry.
const BACKEND_TIMEOUT_MS = 20000;
const ACCOUNT_TIMEOUT_MS = 8000;
const GEMINI_TIMEOUT_MS = 8000;

class BackendError extends Error {
  constructor(message, { status = 0, code = '', data = null } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function describeFailure(status, code, data) {
  switch (code) {
    case 'auth_required':
      return 'non connecté à Google';
    case 'invalid_google_token':
      return 'session Google expirée, reconnectez-vous';
    case 'google_signin_disabled':
      return 'connexion Google non activée sur ce backend';
    case 'daily_limit':
      return data?.scope === 'global'
        ? `capacité quotidienne du service atteinte, jusqu'à ${formatTime(data?.quota?.resetAt)}`
        : `limite quotidienne atteinte (${data?.quota?.limit ?? '?'} regroupements IA par jour), jusqu'à ${formatTime(data?.quota?.resetAt)}`;
  }
  if (status === 401 || status === 403) return `jeton refusé (HTTP ${status})`;
  if (status === 429) return 'trop de requêtes, réessayez dans une minute';
  return `HTTP ${status}${data?.error ? ` : ${data.error}` : ''}`;
}

async function requestJson(url, { method = 'POST', body, headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      // Custom headers, not "Authorization: Bearer": Cloud Run's front end would try to validate it.
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof data?.code === 'string' ? data.code : '';
      throw new BackendError(describeFailure(response.status, code, data), { status: response.status, code, data });
    }
    if (!data || typeof data !== 'object') throw new Error('réponse JSON invalide');
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`délai de ${timeoutMs / 1000} s dépassé`);
    if (error instanceof TypeError) throw new Error('serveur injoignable (URL ? backend démarré ? CORS ?)');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function backendCredentials(settings) {
  if (settings.backendToken) return { kind: 'owner', headers: { 'X-Extension-Token': settings.backendToken } };
  const token = await getGoogleToken();
  return token ? { kind: 'google', token, headers: { 'X-User-Token': token } } : null;
}

/** Calls the backend with the best credentials; a Google token it refuses is replaced once, silently. */
async function callBackend(settings, path, init) {
  let credentials = await backendCredentials(settings);
  if (!credentials) {
    throw isGoogleSignInAvailable()
      ? new BackendError('non connecté à Google', { code: 'not_signed_in' })
      : new BackendError("connexion Google indisponible dans cette version (jeton propriétaire requis)", { code: 'signin_unavailable' });
  }
  const url = `${settings.backendUrl}${path}`;
  try {
    return { data: await requestJson(url, { ...init, headers: credentials.headers }), kind: credentials.kind };
  } catch (error) {
    if (credentials.kind !== 'google' || error?.code !== 'invalid_google_token') throw error;
    await dropGoogleToken(credentials.token);
    credentials = await backendCredentials(settings);
    if (credentials?.kind !== 'google') throw error;
    return { data: await requestJson(url, { ...init, headers: credentials.headers }), kind: credentials.kind };
  }
}

function sanitizeQuota(quota) {
  if (!quota || typeof quota !== 'object') return undefined;
  const { used, limit, remaining, resetAt } = quota;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return undefined;
  return { used, limit, remaining: Number.isFinite(remaining) ? remaining : Math.max(limit - used, 0), resetAt: String(resetAt ?? '') };
}

function fallbackWarning(error) {
  switch (error?.code) {
    case 'not_signed_in':
    case 'auth_required':
      return "Non connecté : regroupement par mots-clés. Connectez-vous avec Google pour activer l'IA.";
    case 'signin_unavailable':
      return 'Connexion Google indisponible dans cette version : regroupement par mots-clés.';
    case 'invalid_google_token':
      return 'Session Google expirée : reconnectez-vous dans les options. Regroupement par mots-clés en attendant.';
    case 'daily_limit':
      return error.data?.scope === 'global'
        ? `Capacité quotidienne du service atteinte : mots-clés jusqu'à ${formatTime(error.data?.quota?.resetAt)}.`
        : `Limite quotidienne atteinte (${error.data?.quota?.limit ?? '?'} regroupements IA par jour) : mots-clés jusqu'à ${formatTime(error.data?.quota?.resetAt)}.`;
    default:
      return `Backend injoignable (${errorMessage(error)}) : repli heuristique local.`;
  }
}

async function viaBackend(request, settings, fallback) {
  try {
    const { data } = await callBackend(settings, '/classify', { method: 'POST', body: request, timeoutMs: BACKEND_TIMEOUT_MS });
    // Never trust the network blindly: same validation as for a raw model answer.
    const validated = normalizeClassification(data, contextFromRequest(request));
    const serverFallback = data.source === 'heuristic';
    return {
      ...validated,
      source: serverFallback ? 'heuristic' : 'gemini',
      model: typeof data.model === 'string' ? data.model : undefined,
      quota: sanitizeQuota(data.quota),
      warning: serverFallback && data.error ? `Gemini indisponible côté serveur (${data.error}) : repli heuristique.` : undefined,
    };
  } catch (error) {
    if (!fallback) throw error;
    return { ...classifyHeuristically(request), source: 'heuristic', warning: fallbackWarning(error) };
  }
}

async function viaGemini(request, settings, fallback) {
  const result = await runClassification(request, {
    generate: (input) =>
      callGeminiApi({ apiKey: settings.geminiApiKey, model: settings.geminiModel, input, timeoutMs: GEMINI_TIMEOUT_MS }),
    retries: 1,
    fallback,
  });
  return {
    ...result,
    model: settings.geminiModel,
    warning: result.source === 'heuristic' ? `Gemini indisponible (${result.error}) : repli heuristique.` : undefined,
  };
}

/**
 * Who the backend sees.
 * @param {object} settings sanitised settings
 * @param {{checkBackend?: boolean}} [options] false: no network call (popup)
 * @returns {Promise<{ok: boolean, mode: 'owner'|'google'|'signed-out'|'unavailable', quota?: object, message?: string}>}
 */
export async function describeAccount(settings, { checkBackend = true } = {}) {
  const credentials = await backendCredentials(settings);
  if (!credentials) return { ok: true, mode: isGoogleSignInAvailable() ? 'signed-out' : 'unavailable' };
  if (!checkBackend) return { ok: true, mode: credentials.kind };
  try {
    const { data, kind } = await callBackend(settings, '/me', { method: 'GET', timeoutMs: ACCOUNT_TIMEOUT_MS });
    return { ok: true, mode: kind, quota: sanitizeQuota(data.quota) };
  } catch (error) {
    return { ok: false, mode: credentials.kind, message: errorMessage(error) };
  }
}

/**
 * @param {object} rawRequest {tabs, existingGroups, language, maxGroups}
 * @param {object} settings sanitised settings
 * @param {{useCache?: boolean, fallback?: boolean}} [options]
 * @returns {Promise<{groups: object[], ungrouped: number[], source: 'gemini'|'heuristic'|'cache',
 *                    model?: string, quota?: object, latencyMs: number, warning?: string}>}
 */
export async function classifyTabs(rawRequest, settings, { useCache = settings.cacheEnabled, fallback = true } = {}) {
  const started = Date.now();
  const request = normalizeClassifyRequest(rawRequest);

  if (useCache && settings.provider !== 'heuristic') {
    const cached = await lookupCachedClassification(request).catch(() => null);
    if (cached) {
      return { ...normalizeClassification(cached, contextFromRequest(request)), source: 'cache', latencyMs: Date.now() - started };
    }
  }

  let result;
  if (settings.provider === 'backend') result = await viaBackend(request, settings, fallback);
  else if (settings.provider === 'gemini') result = await viaGemini(request, settings, fallback);
  else result = { ...classifyHeuristically(request), source: 'heuristic' };

  if (useCache && result.source === 'gemini') await storeClassification(request, result).catch(() => undefined);
  return { ...result, latencyMs: Date.now() - started };
}
