// Google sign-in: verifies the OAuth access token the extension obtains with chrome.identity.getAuthToken
// and derives a pseudonymous user key for the daily limit. The token travels in `X-User-Token`: an
// `Authorization: Bearer` header would be intercepted by Cloud Run's front end, and headers starting with
// `X-Google-` are stripped by it before reaching the service. The extension only asks for the `openid`
// scope: the backend never sees an e-mail address or a name.
import { createHash } from 'node:crypto';

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const TIMEOUT_MS = 5000;
const CACHE_TTL_S = 600; // a revoked token stays accepted for at most 10 minutes per instance
const MAX_CACHE_ENTRIES = 1000;
const TOKEN_PATTERN = /^[\w.~+/=-]{16,4096}$/;

export class GoogleAuthError extends Error {
  /** @param {'invalid_google_token'|'auth_unavailable'} code */
  constructor(message, code = 'invalid_google_token') {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('base64url');

/** Stable and pseudonymous: the Google account ID itself is never stored. */
export function userKeyFor(subject) {
  return sha256(`tab-classifier:user:${subject}`).slice(0, 32);
}

/**
 * @param {{oauthClientIds: string[]}} config
 * @returns {(token: string) => Promise<{subject: string}>}
 */
export function createGoogleTokenVerifier(config, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(); // sha256(token) -> {subject, expiresAt}

  async function getJson(url, init = {}) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new GoogleAuthError(`Vérification Google impossible : ${error?.message ?? error}`, 'auth_unavailable');
    }
    if (response.status >= 500) throw new GoogleAuthError(`Vérification Google impossible (HTTP ${response.status}).`, 'auth_unavailable');
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data !== 'object') throw new GoogleAuthError('Session Google invalide ou expirée.');
    return data;
  }

  return async function verifyGoogleToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new GoogleAuthError('Session Google invalide ou expirée.');
    const key = sha256(token);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { subject: cached.subject };
    cache.delete(key);

    const info = await getJson(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
    // The token must have been issued to *this* extension: any other Google token is refused.
    const audiences = [info.aud, info.azp, info.issued_to].filter(Boolean);
    if (!audiences.some((audience) => config.oauthClientIds.includes(audience))) {
      throw new GoogleAuthError('Jeton Google émis pour une autre application.');
    }
    const expiresIn = Number(info.expires_in);
    if (!(expiresIn > 0)) throw new GoogleAuthError('Session Google expirée.');
    let subject = info.sub ?? info.user_id;
    if (!subject) subject = (await getJson(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } })).sub;
    if (!subject) throw new GoogleAuthError('Jeton Google sans identifiant de compte.');

    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { subject: String(subject), expiresAt: now() + Math.min(expiresIn, CACHE_TTL_S) * 1000 });
    return { subject: String(subject) };
  };
}
