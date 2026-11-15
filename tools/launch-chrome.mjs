// Opens a visible Chrome window (separate profile in tools/.chrome-profile/) with the extension
// loaded and configured for the Cloud Run backend. Handy for demos: your usual Chrome is untouched.
// Usage (PowerShell):
//   $env:BACKEND_URL="https://...run.app"; $env:EXTENSION_TOKEN="..."; node tools/launch-chrome.mjs
// Without BACKEND_URL/EXTENSION_TOKEN the extension keeps its current settings.
// Keep this process running while you use the window; closing Chrome ends it.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const PROFILE = join(ROOT, 'tools', '.chrome-profile');
const CANDIDATES = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
};
const CHROME = process.env.CHROME_PATH ?? (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));
if (!CHROME) {
  console.error('Chrome introuvable : définissez CHROME_PATH.');
  process.exit(1);
}
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(
  CHROME,
  ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--start-maximized'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);
chrome.on('exit', () => process.exit(0));

const [toChrome, fromChrome] = [chrome.stdio[3], chrome.stdio[4]];
let nextId = 1;
const pending = new Map();
let buffer = '';
fromChrome.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const waiter = pending.get(message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolvePromise, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject });
    toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { id } = await send('Extensions.loadUnpacked', { path: EXTENSION });
console.log(`Extension chargée : chrome-extension://${id}`);

if (process.env.BACKEND_URL && process.env.EXTENSION_TOKEN) {
  let worker;
  for (let i = 0; i < 50 && !worker; i += 1) {
    const { targetInfos } = await send('Target.getTargets');
    worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
    if (!worker) await sleep(200);
  }
  const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  const settings = { provider: 'backend', backendUrl: process.env.BACKEND_URL, backendToken: process.env.EXTENSION_TOKEN };
  await send(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...(settings ?? {}), ...${JSON.stringify(settings)} } }))`,
      awaitPromise: true,
    },
    sessionId,
  );
  await send('Target.detachFromTarget', { sessionId });
  console.log(`Configurée sur ${process.env.BACKEND_URL}`);
}
console.log('Chrome est ouvert. Fermez la fenêtre pour terminer.');
