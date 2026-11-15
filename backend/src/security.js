// CORS, bearer-token authentication and per-client rate limiting (Express middlewares).
import { createHash, timingSafeEqual } from 'node:crypto';
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
      'Access-Control-Allow-Headers': 'X-Extension-Token, Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Shared application token (Secret Manager -> EXTENSION_TOKEN), compared in constant time.
 * Sent in `X-Extension-Token`: on Cloud Run, an `Authorization: Bearer` header is intercepted by
 * the Google front end, which tries to validate it as a Google identity token (401). The Bearer
 * form is still accepted (local development, curl).
 */
export function requireToken(config) {
  const expected = config.extensionToken ? digest(config.extensionToken) : null;
  let warned = false;
  return (req, res, next) => {
    if (!expected) {
      // Fail closed in production; allow unauthenticated calls only for local development.
      if (config.onCloudRun) return res.status(503).json({ error: 'EXTENSION_TOKEN non configuré sur le serveur.' });
      if (!warned) {
        logger.warn('EXTENSION_TOKEN non défini : authentification désactivée (développement local uniquement).');
        warned = true;
      }
      return next();
    }
    const provided = req.get('x-extension-token') ?? /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!provided || !timingSafeEqual(digest(provided.trim()), expected)) {
      return res.status(401).json({ error: 'Jeton invalide ou manquant.' });
    }
    next();
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
