// Integration tests of the service worker against an in-memory fake of the chrome.* APIs.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import { createFakeChrome } from './helpers/fakeChrome.js';

const fake = createFakeChrome();
globalThis.chrome = fake.chrome;
const bg = await import('../src/background/index.js');

const CARS = [
  ['peugeot 208 occasion - Recherche Google', 'https://www.google.com/search?q=peugeot+208+occasion'],
  ['Comparatif SUV électriques 2026 - Caradisiac', 'https://www.caradisiac.com/comparatif-suv-electriques'],
  ['Peugeot 208 occasion - La Centrale', 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PEUGEOT%3A208'],
  ['Essai Renault 5 E-Tech : notre avis - Autoplus', 'https://www.autoplus.fr/renault/r5/essai-renault-5-e-tech'],
];
const RESTAURANTS = [
  ['meilleur restaurant italien paris - Recherche Google', 'https://www.google.com/search?q=meilleur+restaurant+italien+paris'],
  ['TheFork - Réservez les meilleurs restaurants à Paris', 'https://www.thefork.fr/restaurants/paris-c415144'],
  ['restaurant italien paris - Google Maps', 'https://www.google.com/maps/search/restaurant+italien+paris/@48.85,2.35,13z'],
  ['Il Gigolo, Paris - Avis sur les restaurants - Tripadvisor', 'https://www.tripadvisor.fr/Restaurant_Review-g187147-d1234567-Reviews-Il_Gigolo-Paris.html'],
  ['Les 15 meilleures pizzerias de Paris - Le Fooding', 'https://lefooding.com/articles/meilleures-pizzerias-paris'],
  ['Big Mamma - East Mamma', 'https://www.bigmammagroup.com/fr/trattorias/east-mamma'],
];
const TRAVEL = [
  ['Vols Paris - Rome | Skyscanner', 'https://www.skyscanner.fr/transport/vols/pari/rome/'],
  ['Hôtels à Rome - Booking.com', 'https://www.booking.com/city/it/rome.fr.html'],
];
const CAR_EXTRA = ['Tesla Model Y prix 2026 - Caradisiac', 'https://www.caradisiac.com/tesla-model-y-prix'];

const BASE_SETTINGS = { provider: 'heuristic', threshold: 10, incrementalThreshold: 3, minDelaySeconds: 30, notify: true, cacheEnabled: false };

async function setSettings(partial = {}) {
  await chrome.storage.local.set({ settings: { ...BASE_SETTINGS, ...partial } });
}

function open(windowId, list) {
  return list.map(([title, url]) => fake.addTab(windowId, { title, url }).id);
}

async function windowGroups(windowId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return Object.fromEntries(groups.map((group) => [group.title, group.id]));
}

async function membersOf(windowId, groupId) {
  return (await chrome.tabs.query({ windowId })).filter((tab) => tab.groupId === groupId).map((tab) => tab.id);
}

async function waitFor(condition, attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

/** Signs in through the service worker, as the popup / options button does. */
async function signInWithGoogle() {
  fake.identity.approve = true;
  const result = await bg.handleMessage({ type: 'signIn' });
  assert.equal(result.mode, 'google');
}

const CAR_TITLE = '\u{1F697} Voitures';
const RESTAURANT_TITLE = '\u{1F37D}\u{FE0F} Restaurants';
const TRAVEL_TITLE = '\u{2708}\u{FE0F} Voyage';

before(() => mock.timers.enable({ apis: ['setTimeout'] })); // badge / debounce timers never block the run
after(() => mock.timers.reset());
beforeEach(async () => {
  delete globalThis.fetch;
  await setSettings();
});

describe('automatic grouping', () => {
  const win = fake.addWindow();
  let carIds;
  let restaurantIds;

  test('nothing happens below the threshold', async () => {
    carIds = open(win, CARS);
    restaurantIds = open(win, RESTAURANTS.slice(0, 5));
    await bg.autoCheck(win);
    assert.deepEqual(await windowGroups(win), {});
  });

  test('the 10th tab triggers the grouping (4 cars + 6 restaurants -> 2 groups)', async () => {
    restaurantIds.push(...open(win, RESTAURANTS.slice(5)));
    await bg.autoCheck(win);
    const groups = await windowGroups(win);
    assert.deepEqual(Object.keys(groups).sort(), [CAR_TITLE, RESTAURANT_TITLE].sort());
    assert.deepEqual((await membersOf(win, groups[CAR_TITLE])).sort(), [...carIds].sort());
    assert.deepEqual((await membersOf(win, groups[RESTAURANT_TITLE])).sort(), [...restaurantIds].sort());

    const [notificationId, notification] = [...fake.notifications].at(-1);
    assert.match(notificationId, /^run:/);
    assert.equal(notification.title, '2 groupes créés');
    assert.deepEqual(notification.buttons, [{ title: 'Annuler' }]);
    assert.equal(fake.badge.text, '2');

    const state = await bg.getPopupState(win);
    assert.equal(state.status.lastRun.summary, '2 groupes créés');
    assert.equal(state.canUndo, true);
    assert.equal(state.counts.ungrouped, 0);
  });

  test('the minimum delay between two automatic runs is respected (alarm)', async () => {
    const travelIds = open(win, [...TRAVEL, CAR_EXTRA]);
    await bg.autoCheck(win);
    assert.ok(fake.alarms.has(`recheck:${win}`));
    assert.equal(fake.groupOf(travelIds[0]), -1);
  });

  test('incremental run: a car tab joins "Voitures", a new topic creates a group', async () => {
    const result = await bg.runGrouping(win, 'auto'); // what the alarm does once the delay is over
    assert.equal(result.message, '1 groupe créé · 1 onglet rangé');
    const groups = await windowGroups(win);
    assert.equal(Object.keys(groups).length, 3);
    assert.equal((await membersOf(win, groups[CAR_TITLE])).length, 5);
    assert.equal((await membersOf(win, groups[TRAVEL_TITLE])).length, 2);
  });
});

describe('undo and user choices', () => {
  test('undo restores memberships and the original order, and auto mode leaves these tabs alone', async () => {
    const win = fake.addWindow();
    // Interleave topics so that grouping really moves tabs around.
    for (let i = 0; i < 6; i += 1) {
      if (CARS[i]) open(win, [CARS[i]]);
      open(win, [RESTAURANTS[i]]);
    }
    const originalOrder = fake.order(win);
    await bg.runGrouping(win, 'auto');
    assert.equal(Object.keys(await windowGroups(win)).length, 2);
    assert.notDeepEqual(fake.order(win), originalOrder);

    const undo = await bg.undoLast(win);
    assert.equal(undo.ok, true);
    assert.deepEqual(await windowGroups(win), {});
    assert.deepEqual(fake.order(win), originalOrder);

    const again = await bg.runGrouping(win, 'auto');
    assert.equal(again.message, 'Seuil non atteint.');
    assert.deepEqual(await windowGroups(win), {});
    assert.equal((await bg.undoLast(win)).ok, false);

    // An explicit request still works.
    await bg.runGrouping(win, 'manual');
    assert.equal(Object.keys(await windowGroups(win)).length, 2);
  });

  test('the "Annuler" notification button undoes the run', async () => {
    const win = fake.addWindow();
    open(win, [...CARS, ...RESTAURANTS]);
    await bg.runGrouping(win, 'auto');
    const notificationId = [...fake.notifications.keys()].at(-1);
    chrome.notifications.onButtonClicked.dispatch(notificationId, 0);
    await waitFor(async () => Object.keys(await windowGroups(win)).length === 0);
    assert.ok(!fake.notifications.has(notificationId));
  });

  test('a tab the user takes out of a group is not regrouped automatically', async () => {
    const win = fake.addWindow();
    const [firstCar] = open(win, [...CARS, ...RESTAURANTS]);
    await bg.runGrouping(win, 'auto');
    await chrome.tabs.ungroup(firstCar);
    open(win, [...TRAVEL, CAR_EXTRA]);
    await bg.runGrouping(win, 'auto');
    assert.equal(fake.groupOf(firstCar), -1);
    assert.ok(TRAVEL_TITLE in (await windowGroups(win)));
  });

  test('"Dégrouper tout" ungroups the window and disables undo', async () => {
    const win = fake.addWindow();
    open(win, [...CARS, ...RESTAURANTS]);
    await bg.runGrouping(win, 'auto');
    const result = await bg.ungroupAll(win);
    assert.equal(result.message, '10 onglets dégroupés.');
    assert.deepEqual(await windowGroups(win), {});
    assert.equal((await bg.getPopupState(win)).canUndo, false);
    assert.equal((await bg.runGrouping(win, 'auto')).message, 'Seuil non atteint.');
  });

  test('private and special windows are ignored', async () => {
    const win = fake.addWindow({ incognito: true });
    open(win, [...CARS, ...RESTAURANTS]);
    const result = await bg.runGrouping(win, 'manual');
    assert.equal(result.ok, false);
    assert.deepEqual(await windowGroups(win), {});
  });
});

describe('backend provider', () => {
  function backendReply(build) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      const reply = await build(body);
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return calls;
  }

  test('sends only eligible, data-minimised tabs and applies the answer', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example', backendToken: 'tok', excludedDomains: ['mabanque.fr'] });
    const win = fake.addWindow();
    const carIds = open(win, CARS);
    const restaurantIds = open(win, RESTAURANTS);
    fake.addTab(win, { title: 'Mes comptes', url: 'https://secure.mabanque.fr/comptes?session=abc' });
    fake.addTab(win, { title: 'Épinglé', url: 'https://mail.example.com/', pinned: true });
    fake.addTab(win, { title: 'Nouvel onglet', url: 'chrome://newtab/' });
    const calls = backendReply(() => ({
      groups: [
        { name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: carIds },
        { name: 'Restaurants', emoji: '\u{1F37D}\u{FE0F}', color: 'orange', existingGroupId: null, tabIds: restaurantIds },
      ],
      ungrouped: [],
      source: 'gemini',
      model: 'gemini-3.8-flash',
    }));

    await bg.runGrouping(win, 'manual');
    assert.equal(calls.length, 1);
    const [{ url, init, body }] = calls;
    assert.equal(url, 'https://backend.example/classify');
    assert.equal(init.headers['X-Extension-Token'], 'tok');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(body.tabs.length, 10);
    assert.ok(body.tabs.every((tab) => !tab.url.includes('?') && !tab.domain.includes('mabanque')));
    assert.deepEqual(body.tabs[0], {
      id: carIds[0],
      title: 'peugeot 208 occasion - Recherche Google',
      domain: 'google.com',
      query: 'peugeot 208 occasion',
      url: 'google.com/search',
    });
    assert.equal(Object.keys(await windowGroups(win)).length, 2);
    const state = await bg.getPopupState(win);
    assert.equal(state.status.lastRun.source, 'Gemini (gemini-3.8-flash)');
  });

  test('a tab closed during the analysis is skipped', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example', backendToken: 'tok' });
    const win = fake.addWindow();
    const carIds = open(win, CARS);
    open(win, RESTAURANTS);
    backendReply(() => {
      fake.removeTabNow(carIds[0]); // user closes a tab while Gemini is thinking
      return {
        groups: [{ name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: carIds }],
        ungrouped: [],
        source: 'gemini',
      };
    });
    const result = await bg.runGrouping(win, 'manual');
    assert.equal(result.ok, true);
    assert.equal(result.warning, undefined);
    const groups = await windowGroups(win);
    assert.deepEqual((await membersOf(win, groups[CAR_TITLE])).sort(), carIds.slice(1).sort());
  });

  test('unreachable backend: local heuristic fallback with a warning', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    const win = fake.addWindow();
    open(win, [...CARS, ...RESTAURANTS]);
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await bg.runGrouping(win, 'manual');
    assert.match(result.warning, /Backend injoignable/);
    assert.equal(Object.keys(await windowGroups(win)).length, 2);
    assert.equal((await bg.getPopupState(win)).status.state, 'warning');
  });

  test('cache: regrouping the same tabs does not call the backend again', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example', backendToken: 'tok', cacheEnabled: true });
    const win = fake.addWindow();
    const carIds = open(win, CARS);
    const restaurantIds = open(win, RESTAURANTS);
    const calls = backendReply(() => ({
      groups: [
        { name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: carIds },
        { name: 'Restaurants', emoji: '\u{1F37D}\u{FE0F}', color: 'orange', existingGroupId: null, tabIds: restaurantIds },
      ],
      ungrouped: [],
      source: 'gemini',
    }));
    await bg.runGrouping(win, 'manual');
    await bg.undoLast(win);
    await bg.runGrouping(win, 'manual');
    assert.equal(calls.length, 1);
    assert.equal(Object.keys(await windowGroups(win)).length, 2);
    assert.equal((await bg.getPopupState(win)).status.lastRun.source, 'cache local');
  });
});

describe('Google sign-in', () => {
  const RESET_AT = '2026-11-16T00:00:00.000Z';

  /** Fake backend: handler(path, init) -> {status, body}; also records the revocation calls. */
  function backendRoutes(handler) {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://oauth2.googleapis.com/revoke')) {
        fake.identity.granted = false; // Google forgets the consent
        return new Response(null, { status: 200 });
      }
      const { status = 200, body } = await handler(new URL(url).pathname, init);
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return calls;
  }
  const classifyCalls = (calls) => calls.filter((call) => call.url.endsWith('/classify'));
  const googleAnswer = (carIds, restaurantIds, quota) => ({
    groups: [
      { name: 'Voitures', emoji: '\u{1F697}', color: 'blue', existingGroupId: null, tabIds: carIds },
      { name: 'Restaurants', emoji: '\u{1F37D}\u{FE0F}', color: 'orange', existingGroupId: null, tabIds: restaurantIds },
    ],
    ungrouped: [],
    source: 'gemini',
    model: 'gemini-3.8-flash',
    ...(quota ? { quota } : {}),
  });

  test('signed in: the Google token is sent and the day\'s usage is shown', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    const win = fake.addWindow();
    const carIds = open(win, CARS);
    const restaurantIds = open(win, RESTAURANTS);
    const calls = backendRoutes(() => ({ body: googleAnswer(carIds, restaurantIds, { used: 3, limit: 50, remaining: 47, resetAt: RESET_AT }) }));

    const result = await bg.runGrouping(win, 'manual');
    assert.equal(result.warning, undefined);
    const [call] = classifyCalls(calls);
    assert.equal(call.init.headers['X-User-Token'], fake.identity.cached);
    assert.equal(call.init.headers['X-Extension-Token'], undefined);
    const state = await bg.getPopupState(win);
    assert.equal(state.account, 'google');
    assert.equal(state.status.lastRun.quota, "3/50 aujourd'hui");
    assert.equal(Object.keys(await windowGroups(win)).length, 2);
  });

  test('a token refused by the backend is replaced once, silently', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    const stale = fake.identity.cached;
    const win = fake.addWindow();
    const carIds = open(win, CARS);
    const restaurantIds = open(win, RESTAURANTS);
    const calls = backendRoutes((path, init) =>
      init.headers['X-User-Token'] === stale
        ? { status: 401, body: { error: 'Session Google expirée.', code: 'invalid_google_token' } }
        : { body: googleAnswer(carIds, restaurantIds) },
    );

    const result = await bg.runGrouping(win, 'manual');
    assert.equal(result.warning, undefined);
    assert.equal(classifyCalls(calls).length, 2);
    assert.ok(fake.identity.removed.includes(stale));
    assert.notEqual(classifyCalls(calls)[1].init.headers['X-User-Token'], stale);
  });

  test('daily limit reached: keyword grouping with the reset time', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    const win = fake.addWindow();
    open(win, [...CARS, ...RESTAURANTS]);
    backendRoutes(() => ({
      status: 429,
      body: { error: 'Limite quotidienne atteinte.', code: 'daily_limit', scope: 'user', quota: { used: 50, limit: 50, remaining: 0, resetAt: RESET_AT } },
    }));

    const result = await bg.runGrouping(win, 'manual');
    assert.match(result.warning, /^Limite quotidienne atteinte \(50 regroupements IA par jour\) : mots-clés jusqu'à \d\d:\d\d\.$/);
    assert.equal(Object.keys(await windowGroups(win)).length, 2, 'the heuristic still groups the tabs');
  });

  test('the owner token takes precedence over Google sign-in', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example', backendToken: 'tok' });
    const win = fake.addWindow();
    const carIds = open(win, CARS);
    const restaurantIds = open(win, RESTAURANTS);
    const calls = backendRoutes(() => ({ body: googleAnswer(carIds, restaurantIds) }));
    await bg.runGrouping(win, 'manual');
    const [call] = classifyCalls(calls);
    assert.equal(call.init.headers['X-Extension-Token'], 'tok');
    assert.equal(call.init.headers['X-User-Token'], undefined);
    assert.equal((await bg.getPopupState(win)).account, 'owner');
  });

  test('account: today\'s usage comes from /me without counting anything', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    const calls = backendRoutes((path) => ({ body: { auth: 'google', quota: { used: 7, limit: 50, remaining: 43, resetAt: RESET_AT } } }));
    const account = await bg.handleMessage({ type: 'getAccount' });
    assert.deepEqual(account, { ok: true, mode: 'google', quota: { used: 7, limit: 50, remaining: 43, resetAt: RESET_AT } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.example/me');
    assert.equal(calls[0].init.method, 'GET');
  });

  test('sign-out revokes the access; afterwards nothing is sent to the backend', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await signInWithGoogle();
    const token = fake.identity.cached;
    const calls = backendRoutes(() => ({ body: {} }));

    const signedOut = await bg.handleMessage({ type: 'signOut' });
    assert.equal(signedOut.mode, 'signed-out');
    const [revoke] = calls;
    assert.equal(revoke.url, 'https://oauth2.googleapis.com/revoke');
    assert.equal(revoke.init.body, `token=${token}`);
    assert.equal(fake.identity.cached, null);

    const win = fake.addWindow();
    open(win, [...CARS, ...RESTAURANTS]);
    const result = await bg.runGrouping(win, 'manual');
    assert.match(result.warning, /^Non connecté : regroupement par mots-clés/);
    assert.equal(classifyCalls(calls).length, 0, 'no credentials: the backend is not called');
    assert.equal((await bg.getPopupState(win)).account, 'signed-out');
    await assert.rejects(
      bg.handleMessage({ type: 'testProvider', settings: { ...BASE_SETTINGS, provider: 'backend', backendUrl: 'https://backend.example' } }),
      /non connecté à Google/,
    );
  });

  test('a cancelled consent is reported', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    await bg.handleMessage({ type: 'signOut' }).catch(() => undefined);
    fake.identity.approve = false;
    const result = await bg.handleMessage({ type: 'signIn' });
    assert.deepEqual(result, { ok: false, mode: 'signed-out', message: 'Connexion annulée.' });
    fake.identity.approve = true;
  });

  test('no OAuth client in the manifest: sign-in is unavailable', async () => {
    await setSettings({ provider: 'backend', backendUrl: 'https://backend.example' });
    const saved = fake.manifest.oauth2;
    delete fake.manifest.oauth2;
    try {
      assert.equal((await bg.handleMessage({ type: 'getAccount' })).mode, 'unavailable');
      const win = fake.addWindow();
      open(win, [...CARS, ...RESTAURANTS]);
      const result = await bg.runGrouping(win, 'manual');
      assert.match(result.warning, /^Connexion Google indisponible dans cette version/);
    } finally {
      fake.manifest.oauth2 = saved;
    }
  });
});

describe('messages and housekeeping', () => {
  test('popup state and messages', async () => {
    const win = fake.addWindow();
    open(win, CARS.slice(0, 3));
    let state = await bg.handleMessage({ type: 'getState', windowId: win });
    assert.deepEqual(state.counts, { total: 3, ungrouped: 3, newCount: 3, required: 10 });
    assert.equal(state.mode, 'auto');
    await bg.handleMessage({ type: 'setMode', mode: 'manual' });
    state = await bg.handleMessage({ type: 'getState', windowId: win });
    assert.equal(state.mode, 'manual');
    const result = await bg.handleMessage({ type: 'groupNow', windowId: win });
    assert.equal(result.message, '1 groupe créé');
    assert.equal((await bg.handleMessage({ type: 'nope' })).ok, false);
  });

  test('connection test reports the provider result', async () => {
    const result = await bg.handleMessage({ type: 'testProvider', settings: { ...BASE_SETTINGS, provider: 'heuristic' } });
    assert.equal(result.ok, true);
    assert.match(result.message, /^OK : 2 groupe\(s\)/);
  });

  test('closed tabs are forgotten (batched)', async () => {
    const win = fake.addWindow();
    const [first] = open(win, [...CARS, ...RESTAURANTS]);
    await bg.runGrouping(win, 'auto');
    assert.ok((await chrome.storage.session.get('seen')).seen[first]);
    chrome.tabs.onRemoved.dispatch(first, { windowId: win, isWindowClosing: false });
    mock.timers.tick(1000);
    await waitFor(async () => !(await chrome.storage.session.get('seen')).seen[first]);
  });
});
