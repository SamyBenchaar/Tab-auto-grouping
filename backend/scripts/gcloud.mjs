// Minimal cross-platform wrapper around the gcloud CLI (Windows PowerShell/cmd, macOS, Linux, Cloud Shell).
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function quote(arg) {
  // On Windows gcloud is a .cmd file and must go through the shell: quote what cmd.exe would split.
  return isWindows && /[\s"&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * @param {string[]} args
 * @param {{capture?: boolean, input?: string, allowFailure?: boolean}} [options]
 * @returns {{ok: boolean, stdout: string}}
 */
export function gcloud(args, { capture = false, input, allowFailure = false } = {}) {
  const result = spawnSync('gcloud', args.map(quote), {
    shell: isWindows,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  if (result.error) {
    throw new Error(`gcloud introuvable (${result.error.message}). Installez le Google Cloud SDK ou utilisez Cloud Shell.`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`« gcloud ${args.slice(0, 3).join(' ')} … » a échoué (code ${result.status}).${capture && result.stderr ? `\n${result.stderr}` : ''}`);
  }
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
}

export function requireProject(values) {
  const project = values.project || process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error('Projet GCP manquant : ajoutez --project <ID> (ex. npm run deploy -- --project mon-projet).');
    process.exit(1);
  }
  return project;
}
