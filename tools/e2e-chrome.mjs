// End-to-end smoke test in a real, headless Chrome: loads extension/ unpacked (temporary profile),
// opens tabs served by a local HTTP server, then checks automatic + incremental grouping, the popup
// (undo button) and the options page. Uses the "Heuristique locale" provider: no network, no key.
// Usage: node tools/e2e-chrome.mjs   (CHROME_PATH=... to use another Chrome / Chromium binary)
// Screenshots are written to tools/e2e-output/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const OUTPUT = join(ROOT, 'tools', 'e2e-output');
const CHROME_CANDIDATES = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};
const CHROME = process.env.CHROME_PATH ?? (CHROME_CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));
if (!CHROME) {
  console.error('Chrome introuvable : définissez CHROME_PATH.');
  process.exit(1);
}
mkdirSync(OUTPUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...args);

// --- Local "websites": a page whose <title> is given in the query string -----------------------
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const server = http.createServer((req, res) => {
  const title = new URL(req.url, 'http://local').searchParams.get('t') ?? 'Page';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><h1>${escapeHtml(title)}</h1>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const page = (slug, title) => `http://localhost:${PORT}/${slug}?t=${encodeURIComponent(title)}`;

// --- Chrome over the DevTools pipe ------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'tcg-e2e-profile-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--window-size=1280,800',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
);
const [toChrome, fromChrome] = [chrome.stdio[3], chrome.stdio[4]];
let nextId = 1;
const pending = new Map();
const events = [];
let buffer = '';
fromChrome.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data ?? ''}`));
      else resolve(message.result);
    } else {
      events.push(message);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 30000);
  });
}
async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result.result.value;
}
async function waitForTarget(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await send('Target.getTargets');
    const target = targetInfos.find(predicate);
    if (target) return target;
    await sleep(200);
  }
  throw new Error('target not found');
}
async function poll(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last.ok) return last;
    await sleep(500);
  }
  throw new Error(`${label}: timeout (last: ${JSON.stringify(last)})`);
}
async function screenshot(sessionId, file, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await sleep(600);
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(OUTPUT, file), Buffer.from(data, 'base64'));
  log(`screenshot -> tools/e2e-output/${file}`);
}

const failures = [];
const check = (condition, message) => {
  if (condition) log(`OK   ${message}`);
  else {
    failures.push(message);
    log(`FAIL ${message}`);
  }
};

try {
  const { id: extensionId } = await send('Extensions.loadUnpacked', { path: EXTENSION });
  log(`extension loaded: ${extensionId}`);
  await send('Target.setDiscoverTargets', { discover: true });
  const worker = await waitForTarget((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
  log(`service worker: ${worker.url}`);
  const { sessionId: sw } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  await send('Runtime.enable', {}, sw);

  const state = () =>
    evaluate(
      sw,
      `(async () => {
        const groups = await chrome.tabGroups.query({});
        const tabs = await chrome.tabs.query({});
        return groups.map((g) => ({ title: g.title, color: g.color, tabs: tabs.filter((t) => t.groupId === g.id).map((t) => t.title) }));
      })()`,
    );

  await evaluate(
    sw,
    `chrome.storage.local.set({ settings: { provider: 'heuristic', mode: 'auto', threshold: 10, incrementalThreshold: 3, minDelaySeconds: 10, notify: true } })`,
  );

  // 1) Automatic grouping at the 10th tab.
  const cars = [
    ['car1', 'Peugeot 208 occasion - La Centrale'],
    ['car2', 'Comparatif SUV électriques 2026 - Caradisiac'],
    ['car3', 'Essai Renault 5 E-Tech : notre avis'],
    ['car4', 'Tesla Model 3 : prix et autonomie'],
  ];
  const restaurants = [
    ['resto1', 'meilleur restaurant italien paris'],
    ['resto2', 'TheFork - Réservez les meilleurs restaurants'],
    ['resto3', 'Pizzeria Big Mamma - Réservation'],
    ['resto4', 'Il Gigolo, Paris - Avis sur les restaurants'],
    ['resto5', 'Brasserie Lipp : réserver une table'],
    ['resto6', 'Les meilleurs sushis de Paris - restaurants japonais'],
  ];
  const openTabs = (list) =>
    evaluate(sw, `(async () => { for (const url of ${JSON.stringify(list.map(([slug, title]) => page(slug, title)))}) await chrome.tabs.create({ url, active: false }); })()`);

  await openTabs([...cars, ...restaurants.slice(0, 5)]);
  await sleep(5000);
  check((await state()).length === 0, '9 eligible tabs: no automatic grouping yet');

  const started = Date.now();
  await openTabs(restaurants.slice(5));
  const grouped = await poll(async () => {
    const groups = await state();
    return { ok: groups.length === 2, groups };
  }, 20000, 'auto grouping');
  log(`groups after ${((Date.now() - started) / 1000).toFixed(1)} s (incl. 2.5 s debounce):`, JSON.stringify(grouped.groups, null, 1));
  const byTitle = Object.fromEntries(grouped.groups.map((g) => [g.title, g.tabs.length]));
  check(byTitle['\u{1F697} Voitures'] === 4 && byTitle['\u{1F37D}\u{FE0F} Restaurants'] === 6, 'real Chrome: 4 cars + 6 restaurants grouped automatically');

  // 2) Incremental grouping after the minimum delay.
  await sleep(10500);
  await openTabs([
    ['travel1', 'Vols Paris - Rome pas chers'],
    ['travel2', 'Hôtel à Rome près du Colisée'],
    ['car5', 'Dacia Spring occasion : prix et avis'],
  ]);
  const incremental = await poll(async () => {
    const groups = await state();
    return { ok: groups.length === 3, groups };
  }, 45000, 'incremental grouping');
  const afterIncremental = Object.fromEntries(incremental.groups.map((g) => [g.title, g.tabs.length]));
  log('after incremental run:', JSON.stringify(afterIncremental));
  check(afterIncremental['\u{1F697} Voitures'] === 5 && afterIncremental['\u{2708}\u{FE0F} Voyage'] === 2, 'incremental: car tab joins Voitures, new Voyage group');

  // 3) Popup (opened as a tab in the same window) + undo through its button.
  await evaluate(sw, `chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/popup.html'), active: true })`);
  const popupTarget = await waitForTarget((t) => t.type === 'page' && t.url.endsWith('/src/popup/popup.html'));
  const { sessionId: popup } = await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
  await send('Runtime.enable', {}, popup);
  await sleep(1500);
  const popupInfo = await evaluate(popup, `({ total: document.getElementById('count-total').textContent, status: document.getElementById('status-message').textContent, groups: [...document.querySelectorAll('.group-name')].map((e) => e.textContent), undoDisabled: document.getElementById('undo').disabled })`);
  log('popup:', JSON.stringify(popupInfo));
  check(popupInfo.groups.length === 3 && popupInfo.undoDisabled === false, 'popup lists the 3 groups and enables "Annuler"');
  await screenshot(popup, 'popup.png', 360, 560);

  await evaluate(popup, `document.getElementById('undo').click()`);
  const undone = await poll(async () => {
    const groups = await state();
    return { ok: groups.length === 2, groups };
  }, 10000, 'undo');
  const afterUndo = Object.fromEntries(undone.groups.map((g) => [g.title, g.tabs.length]));
  check(afterUndo['\u{1F697} Voitures'] === 4 && !afterUndo['\u{2708}\u{FE0F} Voyage'], 'undo (popup button) reverts only the last (incremental) run');
  await sleep(800);
  await screenshot(popup, 'popup-after-undo.png', 360, 560);

  // 4) Options page.
  await evaluate(sw, `chrome.runtime.openOptionsPage()`);
  const optionsTarget = await waitForTarget((t) => t.type === 'page' && t.url.endsWith('/src/options/options.html'));
  const { sessionId: options } = await send('Target.attachToTarget', { targetId: optionsTarget.targetId, flatten: true });
  await sleep(1200);
  const optionsInfo = await evaluate(options, `({ provider: document.querySelector('input[name=provider]:checked')?.value, threshold: document.querySelector('input[name=threshold]').value, origin: document.getElementById('extension-origin').textContent })`);
  log('options:', JSON.stringify(optionsInfo));
  check(optionsInfo.provider === 'heuristic' && optionsInfo.threshold === '10', 'options page shows the saved settings');
  await screenshot(options, 'options.png', 900, 2200);

  // Service worker errors, if any.
  const errors = events.filter((e) => e.sessionId === sw && (e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')));
  for (const error of errors) log('SW error:', JSON.stringify(error.params).slice(0, 400));
  check(errors.length === 0, 'no error logged by the service worker');
} catch (error) {
  failures.push(error.message);
  log('ERROR', error.stack ?? error.message);
} finally {
  try {
    await send('Browser.close');
  } catch {
    chrome.kill();
  }
  server.close();
  await sleep(1500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a lock on Windows
  }
  log(failures.length ? `${failures.length} failure(s)` : 'ALL CHECKS PASSED');
  process.exit(failures.length ? 1 : 0);
}
