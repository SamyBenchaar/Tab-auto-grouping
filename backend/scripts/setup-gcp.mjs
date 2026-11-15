// One-time Google Cloud setup for the tab-classifier backend (idempotent).
// Usage: npm run setup-gcp [-- --project <PROJECT_ID>] [--secret-region europe-west1] [--firestore-location europe-west1]
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gcloud, requireProject } from './gcloud.mjs';

const configFile = new URL('../deploy.config.json', import.meta.url);
const saved = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};

const { values } = parseArgs({
  options: {
    project: { type: 'string', default: saved.project },
    'secret-region': { type: 'string', default: 'europe-west1' },
    // Permanent choice: the location of a Firestore database cannot be changed afterwards.
    'firestore-location': { type: 'string', default: 'europe-west1' },
  },
});
const project = requireProject(values);
const saName = 'tab-classifier-sa';
const saEmail = `${saName}@${project}.iam.gserviceaccount.com`;

console.log(`\n==> Projet ${project}`);
gcloud(['config', 'set', 'project', project]);

console.log('\n==> Activation des API (Vertex AI, Cloud Run, Artifact Registry, Cloud Build, Secret Manager, Firestore)');
gcloud([
  'services', 'enable',
  'aiplatform.googleapis.com', 'run.googleapis.com', 'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com', 'secretmanager.googleapis.com', 'firestore.googleapis.com',
  '--project', project,
]);

console.log(`\n==> Compte de service ${saEmail} (rôle roles/aiplatform.user)`);
if (!gcloud(['iam', 'service-accounts', 'describe', saEmail, '--project', project], { capture: true, allowFailure: true }).ok) {
  gcloud(['iam', 'service-accounts', 'create', saName, '--display-name', 'Tab classifier (Cloud Run)', '--project', project]);
}
gcloud(['projects', 'add-iam-policy-binding', project, '--member', `serviceAccount:${saEmail}`, '--role', 'roles/aiplatform.user', '--condition', 'None'], { capture: true });

// Source deployments build with the Compute Engine default service account, which needs this role.
const projectNumber = gcloud(['projects', 'describe', project, '--format', 'value(projectNumber)'], { capture: true }).stdout;
if (projectNumber) {
  gcloud(
    ['projects', 'add-iam-policy-binding', project, '--member', `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`, '--role', 'roles/run.builder', '--condition', 'None'],
    { capture: true, allowFailure: true },
  );
}

console.log('\n==> Secret « extension-token »');
if (gcloud(['secrets', 'describe', 'extension-token', '--project', project], { capture: true, allowFailure: true }).ok) {
  console.log('Le secret existe déjà. Pour l’afficher : gcloud secrets versions access latest --secret=extension-token');
} else {
  const token = randomBytes(32).toString('hex');
  gcloud(
    ['secrets', 'create', 'extension-token', '--replication-policy', 'user-managed', '--locations', values['secret-region'], '--data-file', '-', '--project', project],
    { input: token },
  );
  console.log('\nJeton propriétaire généré (accès sans limite, à garder pour vous) : options de l’extension › Paramètres avancés :');
  console.log(`  ${token}\n`);
}
gcloud(['secrets', 'add-iam-policy-binding', 'extension-token', '--member', `serviceAccount:${saEmail}`, '--role', 'roles/secretmanager.secretAccessor', '--project', project], { capture: true });

console.log(`\n==> Firestore (compteurs quotidiens de la connexion Google, ${values['firestore-location']})`);
if (!gcloud(['firestore', 'databases', 'describe', '--project', project], { capture: true, allowFailure: true }).ok) {
  gcloud(['firestore', 'databases', 'create', '--location', values['firestore-location'], '--project', project]);
}
gcloud(['projects', 'add-iam-policy-binding', project, '--member', `serviceAccount:${saEmail}`, '--role', 'roles/datastore.user', '--condition', 'None'], { capture: true });
// TTL policy: Firestore deletes each counter on its own once `expireAt` (two days later) has passed.
const ttl = gcloud(
  ['firestore', 'fields', 'ttls', 'update', 'expireAt', '--collection-group', 'usage', '--enable-ttl', '--async', '--project', project],
  { capture: true, allowFailure: true },
);
if (!ttl.ok) console.warn('Attention : politique TTL non créée (les compteurs ne seront pas effacés automatiquement). Relancez ce script.');

console.log(`\n==> Terminé. Déploiement : npm run deploy${saved.project === project ? '' : ` -- --project ${project}`}`);
