import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.LOG_LEVEL = 'silent';
const { createApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { createGeminiGenerator } = await import('../src/gemini.js');

const TOKEN = 'test-token';
const TABS = [
  { id: 1201, title: 'Peugeot 208 occasion - La Centrale', domain: 'lacentrale.fr', url: 'lacentrale.fr/listing' },
  { id: 1202, title: 'Comparatif SUV électriques', domain: 'caradisiac.com' },
  { id: 1203, title: 'TheFork - restaurants Paris', domain: 'thefork.fr' },
  { id: 1204, title: 'meilleur restaurant italien paris', domain: 'google.com', query: 'meilleur restaurant italien paris' },
];

async function startServer(env, generate) {
  const config = loadConfig({ EXTENSION_TOKEN: TOKEN, GOOGLE_CLOUD_PROJECT: 'demo', ...env });
  const app = createApp({ config, generate });
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
