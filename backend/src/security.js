// CORS, authentication (owner token or Google sign-in) and per-client rate limiting (Express middlewares).
import { createHash, timingSafeEqual } from 'node:crypto';
import { userKeyFor } from './googleAuth.js';
import { logger } from './logger.js';

function isAllowedOrigin(origin, config) {
  if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
  return origin.startsWith('chrome-extension://');
}

/** Only the extension (or the origins listed in ALLOWED_ORIGINS) may call the API from a browser. */
export function cors(config) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next(); // curl, server-to-server
    if (!isAllowedOrigin(origin, config)) return res.status(403).json({ error: 'Origine non autorisée.' });
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Extension-Token, X-User-Token, Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Two ways in, checked in this order:
 * - the owner token (Secret Manager -> EXTENSION_TOKEN), compared in constant time: no daily limit;
 * - Google sign-in (`X-User-Token`, see googleAuth.js): req.auth.userKey, daily limit.
 * Tokens travel in custom headers: on Cloud Run, an `Authorization: Bearer` header is intercepted by
 * the Google front end, which tries to validate it as a Google identity token (401). The Bearer
 * form of the owner token is still accepted (local development, curl).
 * Sets req.auth = {kind: 'owner'} | {kind: 'google', userKey}.
 */
export function authenticate(config, { verifyGoogleToken }) {
  const expected = config.extensionToken ? digest(config.extensionToken) : null;
  const googleEnabled = config.oauthClientIds.length > 0;
  let warned = false;
  const openForDevelopment = (req, next) => {
    if (!warned) {
      logger.warn('EXTENSION_TOKEN non défini : authentification désactivée (développement local uniquement).');
      warned = true;
    }
    req.auth = { kind: 'owner' };
    return next();
  };
  const refuse = (res, status, code, error) => res.status(status).json({ error, code });

  return async (req, res, next) => {
    const provided = req.get('x-extension-token') ?? /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (provided) {
      if (!expected) {
        // Fail closed in production; allow unauthenticated calls only for local development.
        if (config.onCloudRun) return refuse(res, 503, 'token_not_configured', 'EXTENSION_TOKEN non configuré sur le serveur.');
        return openForDevelopment(req, next);
      }
      if (!timingSafeEqual(digest(provided.trim()), expected)) return refuse(res, 401, 'invalid_token', 'Jeton invalide ou manquant.');
      req.auth = { kind: 'owner' };
      return next();
    }

    const googleToken = req.get('x-user-token');
    if (googleToken) {
      if (!googleEnabled) return refuse(res, 401, 'google_signin_disabled', 'Connexion Google non activée sur ce serveur.');
      try {
        const { subject } = await verifyGoogleToken(googleToken.trim());
        req.auth = { kind: 'google', userKey: userKeyFor(subject) };
        return next();
      } catch (error) {
        if (error?.code === 'auth_unavailable') {
          logger.warn('Vérification Google indisponible', { error: error.message });
          return refuse(res, 503, 'auth_unavailable', 'Vérification Google momentanément indisponible.');
        }
        return refuse(res, 401, 'invalid_google_token', error?.message ?? 'Session Google invalide ou expirée.');
      }
    }

    if (!expected && !googleEnabled) {
      if (config.onCloudRun) return refuse(res, 503, 'auth_not_configured', 'Authentification non configurée sur le serveur.');
      return openForDevelopment(req, next);
    }
    return refuse(res, 401, 'auth_required', 'Connexion requise : connectez-vous avec Google dans les options de l’extension.');
  };
}

/** Fixed one-minute window per client IP (per instance; Cloud Run max-instances bounds the total). */
export function rateLimit(config, { now = Date.now } = {}) {
  const WINDOW_MS = 60_000;
  const windows = new Map();
  const sweeper = setInterval(() => {
    const time = now();
    for (const [key, window] of windows) if (time - window.start >= WINDOW_MS) windows.delete(key);
  }, WINDOW_MS);
  sweeper.unref?.();

  return (req, res, next) => {
    if (!config.rateLimitPerMinute) return next();
    const key = req.ip ?? 'unknown';
    const time = now();
    let window = windows.get(key);
    if (!window || time - window.start >= WINDOW_MS) {
      window = { start: time, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > config.rateLimitPerMinute) {
      res.set('Retry-After', String(Math.ceil((window.start + WINDOW_MS - time) / 1000)));
      return res.status(429).json({ error: 'Trop de requêtes, réessayez dans une minute.' });
    }
    next();
  };
}
