import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.LOG_LEVEL = 'silent';
const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { createGeminiGenerator } = await import('../src/gemini.js');
const { GoogleAuthError, createGoogleTokenVerifier, userKeyFor } = await import('../src/googleAuth.js');
const { createFirestoreStore, createMemoryStore, createQuota, nextResetAt, utcDay } = await import('../src/quota.js');

const TOKEN = 'test-token';
const TABS = [
  { id: 1201, title: 'Peugeot 208 occasion - La Centrale', domain: 'lacentrale.fr', url: 'lacentrale.fr/listing' },
  { id: 1202, title: 'Comparatif SUV électriques', domain: 'caradisiac.com' },
  { id: 1203, title: 'TheFork - restaurants Paris', domain: 'thefork.fr' },
  { id: 1204, title: 'meilleur restaurant italien paris', domain: 'google.com', query: 'meilleur restaurant italien paris' },
];

const CLIENT_ID = '123456789012-testclient.apps.googleusercontent.com';

// Fake Google verification: "google:<name>" is a valid token for the account <name>.
async function fakeVerify(token) {
  if (token === 'google:down') throw new GoogleAuthError('tokeninfo HTTP 503', 'auth_unavailable');
  if (!token.startsWith('google:')) throw new GoogleAuthError('Session Google invalide ou expirée.');
  return { subject: token.slice('google:'.length) };
}

async function startServer(env, generate, { verifyGoogleToken = fakeVerify, store = createMemoryStore() } = {}) {
  const config = loadConfig({ EXTENSION_TOKEN: TOKEN, GOOGLE_CLOUD_PROJECT: 'demo', ...env });
  const app = createApp({ config, generate, verifyGoogleToken, quota: createQuota(config, store) });
  const server = await new Promise((resolveServer) => {
    const instance = app.listen(0, () => resolveServer(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, config };
}

function post(base, body, headers = {}) {
  return fetch(`${base}/classify`, {
    method: 'POST',
    headers: Object.fromEntries(
      Object.entries({ 'Content-Type': 'application/json', 'X-Extension-Token': TOKEN, ...headers }).filter(([, value]) => value !== undefined),
    ),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /classify', () => {
  let ctx;
  let lastInput;
  let mode = 'ok';
  const generate = async (input) => {
    lastInput = input;
    if (mode === 'fail') throw Object.assign(new Error('Gemini 503 : overloaded'), { status: 503, retryable: true });
    // The model only ever sees local ids (1..n).
    return JSON.stringify({
      groups: [
        { name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: [1, 2] },
        { name: 'Restaurants', emoji: '\u{1F37D}\u{FE0F}', color: 'orange', existingGroupId: null, tabIds: [3, 4] },
      ],
      ungrouped: [],
    });
  };

  before(async () => {
    ctx = await startServer({ RATE_LIMIT_PER_MINUTE: '5' }, generate);
  });
  after(() => ctx.server.close());

  test('GET /health', async () => {
    const response = await fetch(`${ctx.base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', provider: 'vertex', model: 'gemini-3.8-flash', location: 'eu', version: 'local' });
  });

  test('classifies and maps local ids back to Chrome tab ids', async () => {
    mode = 'ok';
    const response = await post(ctx.base, { tabs: TABS, language: 'fr', maxGroups: 6 });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'gemini');
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.deepEqual(body.groups.map((group) => [group.name, group.tabIds]), [
      ['Voitures', [1201, 1202]],
      ['Restaurants', [1203, 1204]],
    ]);
    assert.ok(!lastInput.userContent.includes('1201'), 'Chrome ids must not reach the model');
  });

  test('falls back to the heuristic when Gemini fails (after one retry)', async () => {
    mode = 'fail';
    const response = await post(ctx.base, { tabs: TABS });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, 'heuristic');
    assert.equal(body.model, null);
    assert.match(body.error, /503/);
    assert.equal(body.groups.length, 2);
  });

  test('rejects bad input', async () => {
    assert.equal((await post(ctx.base, { tabs: 'nope' })).status, 400);
    assert.equal((await post(ctx.base, '{"tabs": [')).status, 400);
    const huge = { tabs: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: 'x'.repeat(100) })) };
    assert.equal((await post(ctx.base, huge)).status, 413);
  });

  test('rate limit per client', async () => {
    let limited = null;
    for (let i = 0; i < 6 && !limited; i += 1) {
      const response = await post(ctx.base, { tabs: TABS });
      if (response.status === 429) limited = response;
    }
    assert.ok(limited, 'expected a 429');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  });
});

describe('security', () => {
  let ctx;
  const generate = async () => '{"groups": [], "ungrouped": []}';
  before(async () => {
    ctx = await startServer({ ALLOWED_ORIGINS: 'chrome-extension://abc' }, generate);
  });
  after(() => ctx.server.close());

  test('token is required', async () => {
    const noToken = { 'X-Extension-Token': undefined };
    assert.equal((await post(ctx.base, { tabs: TABS }, { 'X-Extension-Token': 'wrong' })).status, 401);
    assert.equal((await post(ctx.base, { tabs: TABS }, { ...noToken, Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(ctx.base, { tabs: TABS })).status, 200);
    // Bearer form still accepted (local development / curl).
    assert.equal((await post(ctx.base, { tabs: TABS }, { ...noToken, Authorization: `Bearer ${TOKEN}` })).status, 200);
  });

  test('CORS: only the configured extension origin', async () => {
    const preflight = await fetch(`${ctx.base}/classify`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

    const other = await post(ctx.base, { tabs: TABS }, { Origin: 'chrome-extension://other' });
    assert.equal(other.status, 403);
    const website = await post(ctx.base, { tabs: TABS }, { Origin: 'https://evil.example' });
    assert.equal(website.status, 403);
  });

  test('fails closed on Cloud Run when no token is configured', async () => {
    const cloudRun = await startServer({ EXTENSION_TOKEN: '', K_SERVICE: 'tab-classifier' }, generate);
    try {
      assert.equal((await post(cloudRun.base, { tabs: TABS })).status, 503);
    } finally {
      cloudRun.server.close();
    }
  });

  test('unknown route', async () => {
    assert.equal((await fetch(`${ctx.base}/nope`)).status, 404);
  });
});

describe('Google sign-in and daily limits', () => {
  let ctx;
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return JSON.stringify({
      groups: [{ name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: [1, 2] }],
      ungrouped: [3, 4],
    });
  };
  const google = (name) => ({ 'X-Extension-Token': undefined, 'X-User-Token': `google:${name}` });
  const me = async (headers) => {
    const response = await fetch(`${ctx.base}/me`, {
      headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
    });
    return { status: response.status, body: await response.json() };
  };

  before(async () => {
    ctx = await startServer({ GOOGLE_OAUTH_CLIENT_IDS: CLIENT_ID, DAILY_LIMIT_PER_USER: '2', GLOBAL_DAILY_LIMIT: '3' }, generate);
  });
  after(() => ctx.server.close());

  test('credentials are required, and checked', async () => {
    const none = await post(ctx.base, { tabs: TABS }, { 'X-Extension-Token': undefined });
    assert.equal(none.status, 401);
    assert.equal((await none.json()).code, 'auth_required');
    const expired = await post(ctx.base, { tabs: TABS }, { 'X-Extension-Token': undefined, 'X-User-Token': 'expired' });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).code, 'invalid_google_token');
    const down = await post(ctx.base, { tabs: TABS }, google('down'));
    assert.equal(down.status, 503);
    assert.equal((await down.json()).code, 'auth_unavailable');
    assert.equal(calls, 0);
  });

  test('per-user limit, then the global ceiling', async () => {
    const start = calls;
    assert.deepEqual((await me(google('alice'))).body, {
      auth: 'google',
      quota: { used: 0, limit: 2, remaining: 2, resetAt: nextResetAt(Date.now()) },
    });

    for (const used of [1, 2]) {
      const response = await post(ctx.base, { tabs: TABS }, google('alice'));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.source, 'gemini');
      assert.deepEqual({ used: body.quota.used, remaining: body.quota.remaining }, { used, remaining: 2 - used });
    }
    const limited = await post(ctx.base, { tabs: TABS }, google('alice'));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const refusal = await limited.json();
    assert.equal(refusal.code, 'daily_limit');
    assert.equal(refusal.scope, 'user');
    assert.match(refusal.error, /2 regroupements IA par jour/);
    assert.equal(calls - start, 2, 'Gemini is not called once the limit is reached');

    // Invalid input is refused before anything is counted.
    assert.equal((await post(ctx.base, { tabs: 'nope' }, google('bob'))).status, 400);
    assert.equal((await me(google('bob'))).body.quota.used, 0);

    // Global ceiling (3): alice used 2, bob gets the last one; his next call is refused and not counted.
    assert.equal((await post(ctx.base, { tabs: TABS }, google('bob'))).status, 200);
    const full = await post(ctx.base, { tabs: TABS }, google('bob'));
    assert.equal(full.status, 429);
    assert.equal((await full.json()).scope, 'global');
    assert.equal((await me(google('bob'))).body.quota.used, 1);
  });

  test('the owner token is never limited', async () => {
    for (let i = 0; i < 3; i += 1) {
      const response = await post(ctx.base, { tabs: TABS });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).quota, undefined);
    }
    assert.deepEqual((await me({ 'X-Extension-Token': TOKEN })).body, { auth: 'owner', quota: null });
  });

  test('Google tokens are refused when sign-in is not configured', async () => {
    const other = await startServer({}, generate);
    try {
      const response = await post(other.base, { tabs: TABS }, google('alice'));
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'google_signin_disabled');
    } finally {
      other.server.close();
    }
  });

  test('a failing quota store does not call Gemini (503)', async () => {
    const failing = async () => {
      throw new Error('Firestore 503');
    };
    const other = await startServer({ GOOGLE_OAUTH_CLIENT_IDS: CLIENT_ID }, generate, { store: { increment: failing, get: failing } });
    const start = calls;
    try {
      const response = await post(other.base, { tabs: TABS }, google('alice'));
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'quota_unavailable');
      assert.equal(calls, start);
    } finally {
      other.server.close();
    }
  });

  test('CORS lets the Google token header through', async () => {
    const preflight = await fetch(`${ctx.base}/me`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://abc', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-User-Token/);
  });
});

describe('Google token verification', () => {
  const config = { oauthClientIds: [CLIENT_ID] };
  const GOOGLE_TOKEN = 'ya29.a0AfB_valid-token-0123456789';
  function fakeGoogle(routes) {
    const requests = [];
    const fetch = async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const { status = 200, body } = routes(String(url), init);
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { fetch, requests };
  }
  const rejectsWith = (code) => (error) => error.code === code;

  test('accepts a token issued to the extension, and caches the answer', async () => {
    const google = fakeGoogle(() => ({ body: { aud: CLIENT_ID, azp: CLIENT_ID, sub: '1234567890', expires_in: '3599', scope: 'openid' } }));
    const verify = createGoogleTokenVerifier(config, { fetch: google.fetch });
    assert.deepEqual(await verify(GOOGLE_TOKEN), { subject: '1234567890' });
    assert.deepEqual(await verify(GOOGLE_TOKEN), { subject: '1234567890' });
    assert.equal(google.requests.length, 1);
    assert.equal(google.requests[0].url, `https://oauth2.googleapis.com/tokeninfo?access_token=${GOOGLE_TOKEN}`);
  });

  test('refuses tokens issued to another application, expired or malformed', async () => {
    const other = fakeGoogle(() => ({ body: { aud: 'someone-else.apps.googleusercontent.com', sub: '1', expires_in: '3599' } }));
    await assert.rejects(createGoogleTokenVerifier(config, { fetch: other.fetch })(GOOGLE_TOKEN), rejectsWith('invalid_google_token'));
    const expired = fakeGoogle(() => ({ status: 400, body: { error: 'invalid_token' } }));
    await assert.rejects(createGoogleTokenVerifier(config, { fetch: expired.fetch })(GOOGLE_TOKEN), rejectsWith('invalid_google_token'));
    const unused = fakeGoogle(() => ({ body: {} }));
    await assert.rejects(createGoogleTokenVerifier(config, { fetch: unused.fetch })('bad token!'), rejectsWith('invalid_google_token'));
    assert.equal(unused.requests.length, 0);
  });

  test('Google unavailable is not a bad token', async () => {
    const down = fakeGoogle(() => ({ status: 503, body: {} }));
    await assert.rejects(createGoogleTokenVerifier(config, { fetch: down.fetch })(GOOGLE_TOKEN), rejectsWith('auth_unavailable'));
  });

  test('falls back to userinfo when tokeninfo has no subject', async () => {
    const google = fakeGoogle((url) =>
      url.startsWith('https://openidconnect.googleapis.com/') ? { body: { sub: '42' } } : { body: { aud: CLIENT_ID, expires_in: '100' } },
    );
    assert.deepEqual(await createGoogleTokenVerifier(config, { fetch: google.fetch })(GOOGLE_TOKEN), { subject: '42' });
    assert.equal(google.requests[1].init.headers.Authorization, `Bearer ${GOOGLE_TOKEN}`);
  });

  test('user keys are pseudonymous and stable', () => {
    assert.equal(userKeyFor('1234567890'), userKeyFor('1234567890'));
    assert.notEqual(userKeyFor('1234567890'), userKeyFor('1234567891'));
    assert.ok(!userKeyFor('1234567890').includes('1234567890'));
    assert.match(userKeyFor('1234567890'), /^[\w-]{32}$/);
  });
});

describe('quota counters', () => {
  test('UTC days and reset time', () => {
    const time = Date.parse('2026-11-15T23:59:00Z');
    assert.equal(utcDay(time), '2026-11-15');
    assert.equal(nextResetAt(time), '2026-11-16T00:00:00.000Z');
  });

  test('a new day starts from zero', async () => {
    let time = Date.parse('2026-11-15T12:00:00Z');
    const quota = createQuota({ dailyLimitPerUser: 1, globalDailyLimit: 0 }, createMemoryStore(), { now: () => time });
    assert.equal((await quota.consume('u')).allowed, true);
    assert.equal((await quota.consume('u')).allowed, false);
    time += 86_400_000;
    assert.equal((await quota.consume('u')).allowed, true);
  });

  test('Firestore: one atomic commit per increment, missing document = 0', async () => {
    const requests = [];
    const fetch = async (url, init) => {
      requests.push({ url, init });
      if (init.method === 'GET') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ writeResults: [{ transformResults: [{ integerValue: '7' }] }] }), { status: 200 });
    };
    const store = createFirestoreStore({ project: 'demo', getAccessToken: async () => 'sa-token', fetch });
    assert.equal(await store.increment('2026-11-15_user_abc', '2026-11-15'), 7);
    assert.equal(await store.get('2026-11-15_user_abc'), 0);

    const [commit, read] = requests;
    assert.equal(commit.url, 'https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents:commit');
    assert.equal(commit.init.headers.Authorization, 'Bearer sa-token');
    const [write] = JSON.parse(commit.init.body).writes;
    assert.equal(write.update.name, 'projects/demo/databases/(default)/documents/usage/2026-11-15_user_abc');
    assert.deepEqual(write.update.fields.expireAt, { timestampValue: '2026-11-17T00:00:00.000Z' });
    assert.deepEqual(write.updateTransforms, [{ fieldPath: 'count', increment: { integerValue: '1' } }]);
    assert.equal(read.url, 'https://firestore.googleapis.com/v1/projects/demo/databases/(default)/documents/usage/2026-11-15_user_abc');
  });

  test('Firestore errors are reported', async () => {
    const fetch = async () => new Response(JSON.stringify({ error: { message: 'Missing permissions' } }), { status: 403 });
    const store = createFirestoreStore({ project: 'demo', getAccessToken: async () => 't', fetch });
    await assert.rejects(store.increment('x', '2026-11-15'), /Firestore 403 : Missing permissions/);
  });
});

describe('privacy page', () => {
  test('public HTML page, with the configured contact', async () => {
    const ctx = await startServer({ PRIVACY_CONTACT: 'privacy@example.com' }, async () => '{}');
    try {
      const response = await fetch(`${ctx.base}/privacy`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
      const html = await response.text();
      assert.match(html, /Politique de confidentialité/);
      assert.match(html, /Privacy policy/);
      assert.match(html, /<a href="mailto:privacy@example.com">privacy@example.com<\/a>/);
      assert.ok(!html.includes('{{'), 'no placeholder left');
    } finally {
      ctx.server.close();
    }
  });

  test('the contact is escaped; without one, the page points to the store listing', async () => {
    const hostile = await startServer({ PRIVACY_CONTACT: '<script>' }, async () => '{}');
    try {
      const html = await (await fetch(`${hostile.base}/privacy`)).text();
      assert.ok(!html.includes('<script>'));
      assert.match(html, /&#60;script&#62;/);
    } finally {
      hostile.server.close();
    }
    const plain = await startServer({}, async () => '{}');
    try {
      assert.match(await (await fetch(`${plain.base}/privacy`)).text(), /fiche Chrome Web Store/);
    } finally {
      plain.server.close();
    }
  });
});

describe('configuration', () => {
  test('provider selection', () => {
    assert.equal(loadConfig({}).provider, 'vertex');
    assert.equal(loadConfig({ GEMINI_API_KEY: 'k' }).provider, 'gemini-api');
    assert.equal(loadConfig({ GEMINI_API_KEY: 'k', GOOGLE_GENAI_USE_VERTEXAI: 'true' }).provider, 'vertex');
    assert.equal(loadConfig({}).location, 'eu');
    assert.deepEqual(loadConfig({ ALLOWED_ORIGINS: 'chrome-extension://a, chrome-extension://b' }).allowedOrigins, [
      'chrome-extension://a',
      'chrome-extension://b',
    ]);
  });

  test('sign-in and quota settings', () => {
    const defaults = loadConfig({});
    assert.deepEqual(defaults.oauthClientIds, []);
    assert.equal(defaults.dailyLimitPerUser, 50);
    assert.equal(defaults.globalDailyLimit, 300);
    assert.equal(defaults.quotaStore, 'memory');
    assert.equal(loadConfig({ K_SERVICE: 'tab-classifier' }).quotaStore, 'firestore');
    const custom = loadConfig({
      GOOGLE_OAUTH_CLIENT_IDS: 'a.apps.googleusercontent.com,b.apps.googleusercontent.com',
      DAILY_LIMIT_PER_USER: '0',
      GLOBAL_DAILY_LIMIT: '-5',
    });
    assert.deepEqual(custom.oauthClientIds, ['a.apps.googleusercontent.com', 'b.apps.googleusercontent.com']);
    assert.equal(custom.dailyLimitPerUser, 0);
    assert.equal(custom.globalDailyLimit, 0);
  });

  test('Vertex mode without a project is a non-retryable error', async () => {
    const generate = createGeminiGenerator(loadConfig({ GOOGLE_CLOUD_PROJECT: '' }));
    await assert.rejects(generate({ systemInstruction: 's', userContent: 'u', schema: {} }), (error) => error.retryable === false);
  });
});

describe('shared core', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = resolve(here, '../../extension/src/core');
  const copy = resolve(here, '../src/core');

  test('backend/src/core is an up-to-date copy of extension/src/core', { skip: !existsSync(source) }, () => {
    const files = readdirSync(source).filter((file) => file.endsWith('.js'));
    assert.deepEqual(readdirSync(copy).filter((file) => file.endsWith('.js')).sort(), files.sort());
    for (const file of files) {
      const copied = readFileSync(join(copy, file), 'utf8').split('\n').slice(1).join('\n');
      assert.equal(copied, readFileSync(join(source, file), 'utf8'), `${file} is stale: run npm run sync-core`);
    }
  });
});
