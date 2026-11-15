// Options page: read / validate / save settings, connection test, cache, shortcut.
import { DEFAULT_SETTINGS, LANGUAGES, loadSettings, normalizeBackendUrl, sanitizeSettings, saveSettings } from '../shared/settings.js';

const form = document.getElementById('settings-form');
const $ = (id) => document.getElementById(id);
const field = (name) => form.elements.namedItem(name);

const VALUE_FIELDS = [
  'backendUrl', 'backendToken', 'geminiApiKey', 'geminiModel', 'threshold',
  'incrementalThreshold', 'minDelaySeconds', 'maxGroups', 'language',
];
const CHECKBOX_FIELDS = ['includeGroupedTabs', 'collapseInactive', 'notify', 'cacheEnabled'];

function setRadio(name, value) {
  for (const input of form.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === value;
}

function getRadio(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value;
}

function updateProviderFields() {
  const provider = getRadio('provider');
  for (const element of form.querySelectorAll('.fields[data-provider]')) {
    element.hidden = element.dataset.provider !== provider;
  }
}

function updateThresholdOutput() {
  $('threshold-value').textContent = field('threshold').value;
}

function fillForm(settings) {
  setRadio('provider', settings.provider);
  setRadio('mode', settings.mode);
  for (const name of VALUE_FIELDS) field(name).value = settings[name];
  for (const name of CHECKBOX_FIELDS) field(name).checked = settings[name];
  field('excludedDomains').value = settings.excludedDomains.join('\n');
  updateThresholdOutput();
  updateProviderFields();
}

function readForm() {
  const values = Object.fromEntries(VALUE_FIELDS.map((name) => [name, field(name).value.trim()]));
  const checks = Object.fromEntries(CHECKBOX_FIELDS.map((name) => [name, field(name).checked]));
  return {
    ...values,
    ...checks,
    provider: getRadio('provider'),
    mode: getRadio('mode'),
    excludedDomains: field('excludedDomains').value.split(/\n+/),
  };
}

function validate(raw) {
  const errors = [];
  const urlValid = Boolean(normalizeBackendUrl(raw.backendUrl));
  field('backendUrl').setAttribute('aria-invalid', String(raw.provider === 'backend' && !urlValid));
  if (raw.provider === 'backend' && !urlValid) errors.push('URL du backend invalide (HTTPS, ou HTTP sur localhost).');
  if (raw.provider === 'gemini' && !raw.geminiApiKey) errors.push('Clé API Gemini manquante.');
  return errors;
}

function setSaveStatus(text, state = '') {
  const element = $('save-status');
  element.textContent = text;
  element.dataset.state = state;
}

async function init() {
  for (const [code, label] of LANGUAGES) $('language').append(new Option(label, code));
  fillForm(await loadSettings());

  const origin = `chrome-extension://${chrome.runtime.id}`;
  $('extension-origin').textContent = origin;
  $('copy-origin').addEventListener('click', async () => {
    await navigator.clipboard.writeText(origin);
    $('copy-origin').textContent = 'Copié ✓';
  });

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((command) => command.name === 'group-now')?.shortcut;
  $('shortcut').textContent = shortcut || 'non défini';
  $('edit-shortcut').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  form.addEventListener('input', (event) => {
    if (event.target.name === 'threshold') updateThresholdOutput();
    if (event.target.name === 'provider') updateProviderFields();
    setSaveStatus('Modifications non enregistrées.');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = readForm();
    const errors = validate(raw);
    if (errors.length) {
      setSaveStatus(errors.join(' '), 'error');
      return;
    }
    fillForm(await saveSettings(raw)); // show the normalised values
    setSaveStatus('Enregistré ✓', 'ok');
  });

  $('reset').addEventListener('click', () => {
    fillForm(sanitizeSettings(DEFAULT_SETTINGS));
    setSaveStatus('Valeurs par défaut chargées : cliquez sur « Enregistrer » pour les appliquer.');
  });

  $('test-provider').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const output = $('test-result');
    const raw = readForm();
    const errors = validate(raw);
    if (errors.length) {
      output.textContent = errors.join(' ');
      output.dataset.state = 'error';
      return;
    }
    button.disabled = true;
    output.textContent = 'Test en cours…';
    output.dataset.state = '';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'testProvider', settings: sanitizeSettings(raw) });
      const warning = result.message?.startsWith('Attention');
      output.textContent = result.ok || warning ? result.message : `Échec : ${result.message}`;
      output.dataset.state = result.ok ? 'ok' : warning ? 'warn' : 'error';
    } catch (error) {
      output.textContent = `Échec : ${error.message}`;
      output.dataset.state = 'error';
    } finally {
      button.disabled = false;
    }
  });

  $('clear-cache').addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ type: 'clearCache' });
    setSaveStatus(result?.message ?? 'Cache vidé.', 'ok');
  });
}

init();
