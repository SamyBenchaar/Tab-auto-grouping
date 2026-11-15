import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildGenerateContentBody,
  callGeminiApi,
  categorize,
  classifyHeuristically,
  extractResponseText,
  GeminiApiError,
  normalizeClassifyRequest,
  RequestError,
  runClassification,
} from '../src/core/index.js';
import { toTabPayload } from '../src/shared/tabs.js';

const demoTabs = [
  ['peugeot 208 occasion - Recherche Google', 'https://www.google.com/search?q=peugeot+208+occasion'],
  ['Comparatif SUV électriques 2026 - Caradisiac', 'https://www.caradisiac.com/comparatif-suv-electriques'],
  ['Peugeot 208 occasion - La Centrale', 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PEUGEOT%3A208'],
  ['Essai Renault 5 E-Tech : notre avis - Autoplus', 'https://www.autoplus.fr/renault/r5/essai-renault-5-e-tech'],
  ['meilleur restaurant italien paris - Recherche Google', 'https://www.google.com/search?q=meilleur+restaurant+italien+paris'],
  ['TheFork - Réservez les meilleurs restaurants à Paris', 'https://www.thefork.fr/restaurants/paris-c415144'],
  ['restaurant italien paris - Google Maps', 'https://www.google.com/maps/search/restaurant+italien+paris/@48.8566,2.3522,13z'],
  ['Il Gigolo, Paris - Avis sur les restaurants - Tripadvisor', 'https://www.tripadvisor.fr/Restaurant_Review-g187147-d1234567-Reviews-Il_Gigolo-Paris.html'],
  ['Les 15 meilleures pizzerias de Paris - Le Fooding', 'https://lefooding.com/articles/meilleures-pizzerias-paris'],
  ['Big Mamma - East Mamma', 'https://www.bigmammagroup.com/fr/trattorias/east-mamma'],
].map(([title, url], index) => toTabPayload({ id: index + 1, title, url }));

describe('heuristic', () => {
  test('demo scenario: 4 car tabs + 6 restaurant tabs -> 2 groups', () => {
    const result = classifyHeuristically(normalizeClassifyRequest({ tabs: demoTabs, language: 'fr' }));
    const byName = Object.fromEntries(result.groups.map((group) => [group.name, group.tabIds]));
    assert.deepEqual(byName, { Voitures: [1, 2, 3, 4], Restaurants: [5, 6, 7, 8, 9, 10] });
    assert.deepEqual(result.ungrouped, []);
  });

  test('generic platforms are weak signals: a TripAdvisor restaurant page is about restaurants', () => {
    assert.equal(categorize(demoTabs[7]).key, 'restaurants');
    assert.equal(categorize({ title: 'Hôtel Colosseo - Tripadvisor', domain: 'tripadvisor.fr', url: null }).key, 'travel');
  });

  test('attaches to an existing group of the same category and localises names', () => {
    const request = normalizeClassifyRequest({
      tabs: [
        { id: 1, title: 'Tesla Model Y prix 2026', domain: 'caradisiac.com' },
        { id: 2, title: 'Vols Paris Rome', domain: 'skyscanner.fr' },
        { id: 3, title: 'Hotels in Rome', domain: 'booking.com' },
      ],
      existingGroups: [{ id: 77, name: 'Achat auto', color: 'blue', examples: ['Peugeot 208 occasion'] }],
      language: 'en',
    });
    const result = classifyHeuristically(request);
    assert.deepEqual(result.groups, [
      { name: 'Achat auto', emoji: '', color: 'blue', existingGroupId: 77, tabIds: [1] },
      { name: 'Travel', emoji: '\u{2708}\u{FE0F}', color: 'cyan', existingGroupId: null, tabIds: [2, 3] },
    ]);
  });

  test('uncategorised tabs are grouped by site only when a site has several tabs', () => {
    const request = normalizeClassifyRequest({
      tabs: [
        { id: 1, title: 'Zorglub alpha', domain: 'zorglub.example' },
        { id: 2, title: 'Zorglub beta', domain: 'zorglub.example' },
        { id: 3, title: 'Quelque chose', domain: 'autre.example' },
      ],
    });
    const result = classifyHeuristically(request);
    assert.deepEqual(result.groups.map((group) => [group.name, group.tabIds]), [['Zorglub', [1, 2]]]);
    assert.deepEqual(result.ungrouped, [3]);
  });
});

describe('runClassification', () => {
  const request = { tabs: demoTabs.slice(0, 4), language: 'fr' };
  const goodAnswer = JSON.stringify({
    groups: [{ name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: [1, 2, 3, 4] }],
    ungrouped: [],
  });

  test('returns the validated model answer', async () => {
    let seenInput;
    const result = await runClassification(request, {
      generate: async (input) => {
        seenInput = input;
        return goodAnswer;
      },
    });
    assert.equal(result.source, 'gemini');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.groups[0].tabIds, [1, 2, 3, 4]);
    assert.match(seenInput.userContent, /<onglets>/);
  });

  test('retries once, then succeeds', async () => {
    let calls = 0;
    const result = await runClassification(request, {
      retryDelayMs: 1,
      generate: async () => {
        calls += 1;
        if (calls === 1) return 'not json';
        return goodAnswer;
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.source, 'gemini');
    assert.equal(result.attempts, 2);
  });

  test('falls back to the heuristic after two failures', async () => {
    let calls = 0;
    const result = await runClassification(request, {
      retryDelayMs: 1,
      generate: async () => {
        calls += 1;
        throw new Error('timeout');
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.source, 'heuristic');
    assert.equal(result.error, 'timeout');
    assert.deepEqual(result.groups[0].tabIds, [1, 2, 3, 4]);
  });

  test('does not retry non-retryable errors and can surface them', async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      throw new GeminiApiError('Gemini API 403 : permission denied', { status: 403, retryable: false });
    };
    await assert.rejects(runClassification(request, { generate, fallback: false }), /403/);
    assert.equal(calls, 1);
  });

  test('invalid requests are rejected before calling the model', async () => {
    await assert.rejects(runClassification({ tabs: [] }, { generate: async () => goodAnswer }), RequestError);
  });
});

describe('Gemini REST client', () => {
  test('request body layout', () => {
    const body = buildGenerateContentBody({
      systemInstruction: 'sys',
      userContent: 'user',
      schema: { type: 'object' },
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    assert.deepEqual(body, {
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'user' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    });
  });

  test('extractResponseText skips thoughts and reports blocks', () => {
    assert.equal(
      extractResponseText({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":' }, { text: '1}' }] } }] }),
      '{"a":1}',
    );
    assert.throws(() => extractResponseText({ promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
    assert.throws(() => extractResponseText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }), /MAX_TOKENS/);
  });

  test('callGeminiApi sends the key in a header and maps HTTP errors', async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
    };
    await assert.rejects(
      callGeminiApi({ apiKey: 'k-123', model: 'gemini-3.8-flash', input: { systemInstruction: 's', userContent: 'u', schema: {} }, fetchImpl }),
      (error) => error instanceof GeminiApiError && error.status === 400 && error.retryable === false,
    );
    assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    assert.equal(captured.init.headers['x-goog-api-key'], 'k-123');
    assert.ok(!captured.url.includes('k-123'));
    assert.deepEqual(JSON.parse(captured.init.body).generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
  });

  test('callGeminiApi times out', async () => {
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    await assert.rejects(
      callGeminiApi({ apiKey: 'k', model: 'm', input: { systemInstruction: 's', userContent: 'u', schema: {} }, fetchImpl, timeoutMs: 20 }),
      (error) => error.status === 408 && error.retryable === true,
    );
  });

  test('missing key is a non-retryable error', async () => {
    await assert.rejects(
      callGeminiApi({ apiKey: '', model: 'm', input: {} }),
      (error) => error instanceof GeminiApiError && error.retryable === false,
    );
  });
});
