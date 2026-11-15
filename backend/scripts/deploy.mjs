// Build and deploy the backend to Cloud Run from source.
// Usage: npm run deploy [-- --project <PROJECT_ID>] [--origin chrome-extension://<id>] [--oauth-client-id <id>]
//        [--daily-limit 50] [--global-daily-limit 300] [--contact <e-mail or https URL>]
//        [--region europe-west1] [--location eu] [--model gemini-3.8-flash] [--service tab-classifier]
//
// Each deploy replaces every environment variable of the service, so the defaults are kept in files:
// - deploy.config.json: project, daily limits, privacy contact;
// - ../extension/manifest.json: the allowed origin (extension ID derived from "key") and the Google
//   sign-in client ("oauth2.client_id").
// Command-line options win over both.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GEMINI_MODEL } from '../src/core/constants.js';
import { gcloud, requireProject } from './gcloud.mjs';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
const saved = readJson(join(backendDir, 'deploy.config.json'));
const manifest = readJson(join(backendDir, '..', 'extension', 'manifest.json'));

const OAUTH_CLIENT = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** Chrome extension ID = first 128 bits of SHA-256(public key), written with the letters a–p. */
function extensionIdFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

const { values } = parseArgs({
  options: {
    project: { type: 'string', default: saved.project },
    region: { type: 'string', default: 'europe-west1' }, // Cloud Run region
    location: { type: 'string', default: 'eu' }, // Vertex AI location: eu | us | global
    model: { type: 'string', default: DEFAULT_GEMINI_MODEL },
    service: { type: 'string', default: 'tab-classifier' },
    origin: { type: 'string', multiple: true, default: [] }, // allowed extension origin(s)
    'oauth-client-id': { type: 'string', multiple: true, default: [] },
    'daily-limit': { type: 'string', default: String(saved.dailyLimitPerUser ?? 50) },
    'global-daily-limit': { type: 'string', default: String(saved.globalDailyLimit ?? 300) },
    contact: { type: 'string', default: saved.privacyContact ?? '' },
    'max-instances': { type: 'string', default: '3' },
  },
});
const project = requireProject(values);

const manifestOrigin = manifest.key ? `chrome-extension://${extensionIdFromKey(manifest.key)}` : null;
const origins = values.origin.length ? values.origin : manifestOrigin ? [manifestOrigin] : [];
const manifestClient = OAUTH_CLIENT.test(manifest.oauth2?.client_id ?? '') ? manifest.oauth2.client_id : null;
const clientIds = values['oauth-client-id'].length ? values['oauth-client-id'] : manifestClient ? [manifestClient] : [];

// Environment variables go through a YAML file: no shell-escaping issues on any platform.
const envVars = {
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  GOOGLE_CLOUD_PROJECT: project,
  GOOGLE_CLOUD_LOCATION: values.location,
  GEMINI_MODEL: values.model,
  QUOTA_STORE: 'firestore',
  DAILY_LIMIT_PER_USER: values['daily-limit'],
  GLOBAL_DAILY_LIMIT: values['global-daily-limit'],
  ...(origins.length ? { ALLOWED_ORIGINS: origins.join(',') } : {}),
  ...(clientIds.length ? { GOOGLE_OAUTH_CLIENT_IDS: clientIds.join(',') } : {}),
  ...(values.contact ? { PRIVACY_CONTACT: values.contact } : {}),
};
const tempDir = mkdtempSync(join(tmpdir(), 'tab-classifier-'));
const envFile = join(tempDir, 'env.yaml');
writeFileSync(envFile, Object.entries(envVars).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'));

console.log(`Projet ${project} · origine(s) : ${origins.join(', ') || 'toute extension Chrome'}`);
console.log(`Connexion Google : ${clientIds.length ? clientIds.join(', ') : 'désactivée (pas de client OAuth dans le manifeste)'}`);
console.log(`Limites : ${values['daily-limit']} par utilisateur et par jour, ${values['global-daily-limit']} au total (0 = illimité)`);
if (!origins.length) {
  console.warn('Attention : aucune origine fixée, toute extension Chrome sera acceptée par CORS (une connexion reste exigée).');
}

try {
  gcloud([
    'run', 'deploy', values.service,
    '--project', project,
    '--source', backendDir,
    '--region', values.region,
    '--service-account', `tab-classifier-sa@${project}.iam.gserviceaccount.com`,
    '--set-secrets', 'EXTENSION_TOKEN=extension-token:latest',
    '--env-vars-file', envFile,
    '--allow-unauthenticated', // the API is protected by Google sign-in or the owner token
    '--max-instances', values['max-instances'],
    '--concurrency', '40',
    '--cpu', '1',
    '--memory', '512Mi',
    '--timeout', '30',
    '--quiet',
  ]);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const url = gcloud(
  ['run', 'services', 'describe', values.service, '--project', project, '--region', values.region, '--format', 'value(status.url)'],
  { capture: true },
).stdout;
console.log(`\nService déployé : ${url}`);
console.log(`Vérification    : curl ${url}/health`);
console.log(`Confidentialité : ${url}/privacy`);
