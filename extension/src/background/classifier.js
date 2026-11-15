// Classification providers: Cloud Run backend (production), direct Gemini API (prototype),
// local heuristic (offline). Network failures fall back to the heuristic so grouping still works.
import {
  callGeminiApi,
  classifyHeuristically,
  contextFromRequest,
  errorMessage,
  normalizeClassification,
  normalizeClassifyRequest,
  runClassification,
} from '../core/index.js';
import { lookupCachedClassification, storeClassification } from './cache.js';

// The backend allows 8 s per Gemini attempt plus one retry.
const BACKEND_TIMEOUT_MS = 20000;
const GEMINI_TIMEOUT_MS = 8000;

async function postJson(url, body, { token, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      // Not "Authorization: Bearer": Cloud Run's front end would try to validate it as a Google token.
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Extension-Token': token } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`jeton refusé (HTTP ${response.status})`);
      if (response.status === 429) throw new Error('trop de requêtes, réessayez dans une minute');
      throw new Error(`HTTP ${response.status}${data?.error ? ` : ${data.error}` : ''}`);
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

async function viaBackend(request, settings, fallback) {
  try {
    const data = await postJson(`${settings.backendUrl}/classify`, request, {
      token: settings.backendToken,
      timeoutMs: BACKEND_TIMEOUT_MS,
    });
    // Never trust the network blindly: same validation as for a raw model answer.
    const validated = normalizeClassification(data, contextFromRequest(request));
    const serverFallback = data.source === 'heuristic';
    return {
      ...validated,
      source: serverFallback ? 'heuristic' : 'gemini',
      model: typeof data.model === 'string' ? data.model : undefined,
      warning: serverFallback && data.error ? `Gemini indisponible côté serveur (${data.error}) : repli heuristique.` : undefined,
    };
  } catch (error) {
    if (!fallback) throw error;
    return {
      ...classifyHeuristically(request),
      source: 'heuristic',
      warning: `Backend injoignable (${errorMessage(error)}) : repli heuristique local.`,
    };
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
 * @param {object} rawRequest {tabs, existingGroups, language, maxGroups}
 * @param {object} settings sanitised settings
 * @param {{useCache?: boolean, fallback?: boolean}} [options]
 * @returns {Promise<{groups: object[], ungrouped: number[], source: 'gemini'|'heuristic'|'cache',
 *                    model?: string, latencyMs: number, warning?: string}>}
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
