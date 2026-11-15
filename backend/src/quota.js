// Daily limits for Google-signed-in users (each Gemini call costs money): N classifications per user
// and per UTC day, plus an optional ceiling for all users together. Counters live in Firestore on
// Cloud Run (shared by every instance, deleted by a TTL policy on `expireAt`) and in memory locally.
// Stored per document: a counter, the day and the expiry date. No tab data, no e-mail, no Google ID.
const DAY_MS = 86_400_000;
const KEEP_DAYS = 2;
const FIRESTORE_URL = 'https://firestore.googleapis.com/v1';
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const TIMEOUT_MS = 5000;

export const utcDay = (time) => new Date(time).toISOString().slice(0, 10);
export const nextResetAt = (time) => new Date((Math.floor(time / DAY_MS) + 1) * DAY_MS).toISOString();

/**
 * @typedef {{increment(id: string, day: string, by?: number): Promise<number>, get(id: string): Promise<number>}} CounterStore
 * @param {{dailyLimitPerUser: number, globalDailyLimit: number}} config 0 = no limit
 * @param {CounterStore} store
 */
export function createQuota(config, store, { now = Date.now } = {}) {
  const userLimit = config.dailyLimitPerUser;
  const globalLimit = config.globalDailyLimit;
  const describe = (used, time) => ({
    used: userLimit ? Math.min(Math.max(used, 0), userLimit) : Math.max(used, 0),
    limit: userLimit || null,
    remaining: userLimit ? Math.max(userLimit - used, 0) : null,
    resetAt: nextResetAt(time),
  });

  return {
    /**
     * Counts one Gemini classification for this user, or refuses it.
     * @returns {Promise<{allowed: boolean, scope?: 'user'|'global', quota: ReturnType<typeof describe>}>}
     */
    async consume(userKey) {
      const time = now();
      const day = utcDay(time);
      const userId = `${day}_user_${userKey}`;
      const used = await store.increment(userId, day);
      if (userLimit && used > userLimit) return { allowed: false, scope: 'user', quota: describe(used, time) };
      if (globalLimit) {
        const total = await store.increment(`${day}_all`, day);
        if (total > globalLimit) {
          await store.increment(userId, day, -1).catch(() => undefined); // not this user's fault
          return { allowed: false, scope: 'global', quota: describe(used - 1, time) };
        }
      }
      return { allowed: true, quota: describe(used, time) };
    },

    /** Today's usage, without counting anything. */
    async peek(userKey) {
      const time = now();
      return describe(await store.get(`${utcDay(time)}_user_${userKey}`), time);
    },
  };
}

/** @returns {CounterStore} per instance: local development and tests only. */
export function createMemoryStore() {
  let currentDay = '';
  const counts = new Map();
  return {
    async increment(id, day, by = 1) {
      if (day !== currentDay) {
        counts.clear();
        currentDay = day;
      }
      const count = (counts.get(id) ?? 0) + by;
      counts.set(id, count);
      return count;
    },
    async get(id) {
      return counts.get(id) ?? 0;
    },
  };
}

/** Access token of the Cloud Run service account (metadata server), cached until a minute before expiry. */
export function metadataAccessToken({ fetch = globalThis.fetch, now = Date.now } = {}) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt > now()) return cached.token;
    const response = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Serveur de métadonnées : HTTP ${response.status}`);
    const { access_token: token, expires_in: expiresIn } = await response.json();
    cached = { token, expiresAt: now() + (Number(expiresIn) - 60) * 1000 };
    return token;
  };
}

/**
 * Firestore through its REST API (no client library: lighter image, faster cold starts). An increment
 * is a single atomic commit (upsert + field transform) that returns the new value.
 * @returns {CounterStore}
 */
export function createFirestoreStore({ project, database = '(default)', collection = 'usage', getAccessToken, fetch = globalThis.fetch }) {
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT est requis pour les quotas Firestore.');
  const root = `projects/${project}/databases/${database}/documents`;

  async function call(method, path, body) {
    const response = await fetch(`${FIRESTORE_URL}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await getAccessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (method === 'GET' && response.status === 404) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Firestore ${response.status} : ${data?.error?.message ?? 'erreur inconnue'}`);
    return data;
  }

  return {
    async increment(id, day, by = 1) {
      const expireAt = new Date(Date.parse(`${day}T00:00:00Z`) + KEEP_DAYS * DAY_MS).toISOString();
      const data = await call('POST', `${root}:commit`, {
        writes: [
          {
            update: { name: `${root}/${collection}/${id}`, fields: { day: { stringValue: day }, expireAt: { timestampValue: expireAt } } },
            updateMask: { fieldPaths: ['day', 'expireAt'] },
            updateTransforms: [{ fieldPath: 'count', increment: { integerValue: String(by) } }],
          },
        ],
      });
      const count = Number(data?.writeResults?.[0]?.transformResults?.[0]?.integerValue);
      if (!Number.isFinite(count)) throw new Error('Firestore : réponse inattendue.');
      return count;
    },
    async get(id) {
      const document = await call('GET', `${root}/${collection}/${id}`);
      return Number(document?.fields?.count?.integerValue ?? 0);
    },
  };
}
