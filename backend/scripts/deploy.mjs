// Build and deploy the backend to Cloud Run from source.
// Usage: npm run deploy -- --project <PROJECT_ID> [--origin chrome-extension://<id>] [--region europe-west1]
//        [--location eu] [--model gemini-3.8-flash] [--service tab-classifier]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GEMINI_MODEL } from '../src/core/constants.js';
import { gcloud, requireProject } from './gcloud.mjs';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    region: { type: 'string', default: 'europe-west1' }, // Cloud Run region
    location: { type: 'string', default: 'eu' }, // Vertex AI location: eu | us | global
    model: { type: 'string', default: DEFAULT_GEMINI_MODEL },
    service: { type: 'string', default: 'tab-classifier' },
    origin: { type: 'string', multiple: true, default: [] }, // allowed extension origin(s)
    'max-instances': { type: 'string', default: '3' },
  },
});
const project = requireProject(values);
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Environment variables go through a YAML file: no shell-escaping issues on any platform.
const envVars = {
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  GOOGLE_CLOUD_PROJECT: project,
  GOOGLE_CLOUD_LOCATION: values.location,
  GEMINI_MODEL: values.model,
  ...(values.origin.length ? { ALLOWED_ORIGINS: values.origin.join(',') } : {}),
};
const tempDir = mkdtempSync(join(tmpdir(), 'tab-classifier-'));
const envFile = join(tempDir, 'env.yaml');
writeFileSync(envFile, Object.entries(envVars).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n'));

if (!values.origin.length) {
  console.warn('Attention : aucun --origin fourni, toute extension Chrome sera acceptée par CORS (le jeton reste exigé).');
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
    '--allow-unauthenticated', // the API is protected by the application token
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
console.log('Dans les options de l’extension : moteur « Backend Cloud Run », URL ci-dessus et jeton du secret extension-token.');
