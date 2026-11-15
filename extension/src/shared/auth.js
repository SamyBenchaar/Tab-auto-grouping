// Google sign-in through chrome.identity (Chrome): one consent screen, then silent tokens that Chrome
// refreshes itself. Only the "openid" scope is requested: the backend learns a stable account ID
// (stored pseudonymised for the daily limit), never the e-mail address or the name.

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CLIENT_ID = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const SIGNED_OUT_MEMO_MS = 60_000; // avoid asking Chrome again on every popup refresh

let signedOutUntil = 0;

/** False in a build whose manifest has no real OAuth client (development, first store upload). */
export function isGoogleSignInAvailable() {
  return Boolean(chrome.identity?.getAuthToken) && CLIENT_ID.test(chrome.runtime.getManifest().oauth2?.client_id ?? '');
}

/**
 * @param {{interactive?: boolean}} [options] interactive: may open Google's consent window (user action only)
 * @returns {Promise<string|null>} null when the user is not signed in (non-interactive call)
 */
export async function getGoogleToken({ interactive = false } = {}) {
  if (!isGoogleSignInAvailable()) {
    if (interactive) throw new Error("connexion Google non configurée dans cette version de l'extension");
    return null;
  }
  if (!interactive && Date.now() < signedOutUntil) return null;
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    const token = typeof result === 'string' ? result : result?.token; // object since Chrome 105
    if (!token) throw new Error('aucun jeton reçu');
    signedOutUntil = 0;
    return token;
  } catch (error) {
    if (interactive) throw error;
    signedOutUntil = Date.now() + SIGNED_OUT_MEMO_MS;
    return null;
  }
}

/** Forget a token the backend refused: the next call gets a fresh one, silently. */
export async function dropGoogleToken(token) {
  if (!token) return;
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    // already gone
  }
}

/** Revokes the extension's access at Google (the next sign-in shows the consent again). */
export async function signOutGoogle() {
  const token = await getGoogleToken();
  if (token) {
    try {
      // no-cors: the revocation happens even though the response is opaque (no host permission needed).
      await fetch(REVOKE_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
      });
    } catch {
      // offline: the cached token is still dropped below
    }
    await dropGoogleToken(token);
  }
  try {
    await chrome.identity.clearAllCachedAuthTokens?.();
  } catch {
    // older Chrome
  }
  signedOutUntil = Date.now() + SIGNED_OUT_MEMO_MS;
}
