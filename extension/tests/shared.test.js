import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeApplied, summarizeRun } from '../src/shared/format.js';
import { extractSearchQuery } from '../src/shared/searchQuery.js';
import { DEFAULT_SETTINGS, normalizeBackendUrl, normalizeDomain, sanitizeSettings } from '../src/shared/settings.js';
import { buildExistingGroups, isEligibleTab, toTabPayload } from '../src/shared/tabs.js';
import { selectTabs } from '../src/shared/trigger.js';

describe('extractSearchQuery', () => {
  const cases = [
    ['https://www.google.fr/search?q=peugeot+208+occasion&sca_esv=1', 'peugeot 208 occasion'],
    ['https://www.google.com/maps/search/restaurant+italien+paris/@48.85,2.35,13z', 'restaurant italien paris'],
    ['https://www.bing.com/search?q=hotel%20rome', 'hotel rome'],
    ['https://duckduckgo.com/?q=vols+rome&t=h_', 'vols rome'],
    ['https://search.yahoo.com/search?p=recette+tiramisu', 'recette tiramisu'],
    ['https://www.youtube.com/results?search_query=guitare+debutant', 'guitare debutant'],
    ['https://www.amazon.fr/s?k=casque+bluetooth', 'casque bluetooth'],
    ['https://www.thefork.fr/search?q=italien', 'italien'],
    ['https://www.google.com/url?q=https://example.com/page', null],
    ['https://www.lacentrale.fr/listing?makesModelsCommercialNames=PEUGEOT%3A208', null],
    ['chrome://newtab/', null],
  ];
  for (const [url, expected] of cases) {
    test(url, () => assert.equal(extractSearchQuery(url), expected));
  }
});

describe('settings', () => {
  test('defaults are valid', () => {
    assert.deepEqual(sanitizeSettings(undefined), { ...DEFAULT_SETTINGS, excludedDomains: [] });
  });

  test('clamps and normalises user input', () => {
    const settings = sanitizeSettings({
      mode: 'weird',
      threshold: 2,
      incrementalThreshold: '7',
      maxGroups: 50,
      language: 'xx',
      provider: 'openai',
      backendUrl: 'http://evil.example.com',
      excludedDomains: 'https://www.MaBanque.fr/compte\nmail.google.com, mail.google.com ;  not a domain',
      geminiModel: 'gemini-3.8-flash; rm -rf',
    });
    assert.equal(settings.mode, 'auto');
    assert.equal(settings.threshold, 5);
    assert.equal(settings.incrementalThreshold, 7);
    assert.equal(settings.maxGroups, 10);
    assert.equal(settings.language, 'fr');
    assert.equal(settings.provider, 'backend');
    assert.equal(settings.backendUrl, DEFAULT_SETTINGS.backendUrl);
    assert.deepEqual(settings.excludedDomains, ['mabanque.fr', 'mail.google.com']);
    assert.equal(settings.geminiModel, DEFAULT_SETTINGS.geminiModel);
  });

  test('backend URL: HTTPS anywhere, HTTP only on localhost', () => {
    assert.equal(normalizeBackendUrl('https://tab-classifier-abc.europe-west1.run.app/'), 'https://tab-classifier-abc.europe-west1.run.app');
    assert.equal(normalizeBackendUrl('http://localhost:8080'), 'http://localhost:8080');
    assert.equal(normalizeBackendUrl('http://example.com'), null);
    assert.equal(normalizeBackendUrl('pas une url'), null);
    assert.equal(normalizeDomain('*.example.org'), 'example.org');
  });
});

const settings = sanitizeSettings({ threshold: 5, incrementalThreshold: 2, excludedDomains: ['mabanque.fr'] });
let nextId = 1;
const tab = (url, extra = {}) => ({ id: nextId++, windowId: 1, index: nextId, url, title: `Title ${nextId}`, pinned: false, incognito: false, groupId: -1, ...extra });

describe('eligibility and payload', () => {
  test('pinned, private, internal and excluded tabs are never eligible', () => {
    assert.equal(isEligibleTab(tab('https://example.com'), settings), true);
    assert.equal(isEligibleTab(tab('https://example.com', { pinned: true }), settings), false);
    assert.equal(isEligibleTab(tab('https://example.com', { incognito: true }), settings), false);
    assert.equal(isEligibleTab(tab('chrome://settings'), settings), false);
    assert.equal(isEligibleTab(tab('about:blank'), settings), false);
    assert.equal(isEligibleTab(tab('https://secure.mabanque.fr/comptes'), settings), false);
    assert.equal(isEligibleTab(tab('', { pendingUrl: 'https://example.com/loading' }), settings), true);
  });

  test('payload is data-minimised', () => {
    const payload = toTabPayload({ id: 3, title: '  Peugeot 208  ', url: 'https://www.google.com/search?q=peugeot+208&session=SECRET#frag' });
    assert.deepEqual(payload, { id: 3, title: 'Peugeot 208', domain: 'google.com', query: 'peugeot 208', url: 'google.com/search' });
  });

  test('existing groups: emoji stripped, examples from eligible tabs only', () => {
    const groups = [{ id: 9, title: '\u{1F697} Voitures', color: 'blue' }];
    const tabs = [
      tab('https://www.lacentrale.fr/a', { groupId: 9, title: 'Peugeot 208' }),
      tab('https://secure.mabanque.fr/credit-auto', { groupId: 9, title: 'Crédit auto - Ma Banque' }),
    ];
    assert.deepEqual(buildExistingGroups(groups, tabs, settings), [{ id: 9, name: 'Voitures', color: 'blue', examples: ['Peugeot 208'] }]);
  });
});

describe('selectTabs (trigger)', () => {
  const windowTabs = () => [
    tab('https://a.example/1'),
    tab('https://a.example/2'),
    tab('https://a.example/3'),
    tab('https://a.example/4'),
    tab('https://a.example/5'),
    tab('https://a.example/pinned', { pinned: true }),
    tab('chrome://newtab/'),
  ];

  test('first grouping needs `threshold` new ungrouped tabs', () => {
    const tabs = windowTabs();
    const selection = selectTabs({ tabs, groups: [], settings });
    assert.equal(selection.newCount, 5);
    assert.equal(selection.required, 5);
    assert.equal(selection.shouldRun, true);
    assert.equal(selection.payload.length, 5);
    assert.equal(selectTabs({ tabs: tabs.slice(1), groups: [], settings }).shouldRun, false);
  });

  test('analysed tabs are not counted again; a navigated tab is new again', () => {
    const tabs = windowTabs();
    const seen = Object.fromEntries(tabs.slice(0, 5).map((item) => [item.id, { u: item.url, s: 'analyzed' }]));
    let selection = selectTabs({ tabs, groups: [], seen, settings });
    assert.equal(selection.newCount, 0);
    assert.equal(selection.shouldRun, false);
    assert.equal(selection.payload.length, 5); // still sent when a run happens
    seen[tabs[0].id].u = 'https://a.example/old-url';
    selection = selectTabs({ tabs, groups: [], seen, settings });
    assert.equal(selection.newCount, 1);
  });

  test('incremental threshold once the window has groups', () => {
    const tabs = [tab('https://b.example/1'), tab('https://b.example/2'), tab('https://b.example/3', { groupId: 4 })];
    const selection = selectTabs({ tabs, groups: [{ id: 4 }], settings });
    assert.equal(selection.required, 2);
    assert.equal(selection.newCount, 2);
    assert.equal(selection.shouldRun, true);
    assert.equal(selection.payload.length, 2);
    assert.equal(selectTabs({ tabs, groups: [{ id: 4 }], settings: { ...settings, includeGroupedTabs: true } }).payload.length, 3);
  });

  test('tabs the user took out of a group, or whose grouping was undone, are left alone (except on manual runs)', () => {
    const tabs = [tab('https://c.example/1'), tab('https://c.example/2'), tab('https://c.example/3')];
    const seen = { [tabs[0].id]: { u: tabs[0].url, s: 'grouped' }, [tabs[1].id]: { u: tabs[1].url, s: 'rejected' } };
    const auto = selectTabs({ tabs, groups: [{ id: 1 }], seen, settings });
    assert.deepEqual(auto.payload.map((item) => item.id), [tabs[2].id]);
    assert.deepEqual(auto.rejected, [tabs[0].id, tabs[1].id]);
    const manual = selectTabs({ tabs, groups: [{ id: 1 }], seen, settings, trigger: 'manual' });
    assert.equal(manual.payload.length, 3);
    assert.equal(manual.shouldRun, true);
  });

  test('manual mode never triggers automatically', () => {
    const selection = selectTabs({ tabs: windowTabs(), groups: [], settings: { ...settings, mode: 'manual' } });
    assert.equal(selection.shouldRun, false);
  });
});

describe('format', () => {
  test('run summaries', () => {
    const applied = [
      { title: '\u{1F697} Voitures', count: 1, existing: true },
      { title: '\u{2708}\u{FE0F} Voyage Rome', count: 2, existing: false },
    ];
    assert.equal(summarizeRun(applied), '1 groupe créé · 1 onglet rangé');
    assert.equal(describeApplied(applied), '\u{1F697} Voitures (+1) · \u{2708}\u{FE0F} Voyage Rome (2)');
    assert.equal(summarizeRun([]), 'Aucun regroupement pertinent');
  });
});
