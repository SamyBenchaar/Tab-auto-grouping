// Chrome Web Store package: dist/tab-context-grouper-<version>[-draft].zip at the repository root.
// Usage: npm run package             store upload (requires the Google sign-in client in the manifest)
//        npm run package -- --draft  first upload, only to obtain the item ID and its public key
// Contents: manifest.json, icons/ and src/ only (no tests, scripts, package.json or dotfiles).
// The manifest's "key" is removed: the Web Store does not accept it and signs the item with its own key
// (the same one, once the store's public key has been copied into the manifest).
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateRawSync } from 'node:zlib';

export const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED_ROOTS = ['icons', 'src'];
const OAUTH_CLIENT = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/** Chrome extension ID = first 128 bits of SHA-256(public key), written with the letters a–p. */
export function extensionIdFromKey(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Minimal ZIP writer: deflate (or store when it does not help), UTF-8 names, one entry per directory.
 * @param {{name: string, data: Buffer|null}[]} entries data null = directory (name ends with "/")
 */
export function createZip(entries, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = data ?? Buffer.alloc(0);
    const deflated = raw.length ? deflateRawSync(raw, { level: 9 }) : raw;
    const method = deflated.length < raw.length ? 8 : 0;
    const body = method === 8 ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: MS-DOS, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(data === null ? 0x10 : 0, 38); // MS-DOS directory attribute
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(EXTENSION_DIR, path).split(sep).join('/'));
    }
  };
  walk(root);
  return files;
}

/** Files the manifest points to: they must all be in the package. */
function referencedFiles(manifest) {
  return [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean);
}

/**
 * @param {{draft?: boolean, outDir?: string, manifest?: object, date?: Date}} [options] manifest: tests only
 * @returns {{path: string, files: string[], warnings: string[], extensionId: string|null, size: number}}
 */
export function buildPackage({ draft = false, outDir = resolve(EXTENSION_DIR, '..', 'dist'), manifest, date } = {}) {
  const source = manifest ?? JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const problems = [];
  if (!OAUTH_CLIENT.test(source.oauth2?.client_id ?? '')) problems.push('pas de client OAuth (oauth2.client_id) : la connexion Google ne fonctionnera pas');
  const warnings = [];
  if (!source.key) warnings.push('pas de « key » : en développement, l’ID de l’extension ne sera pas celui du Chrome Web Store');
  if (problems.length && !draft) {
    throw new Error(`Paquet refusé :\n- ${problems.join('\n- ')}\nPremier envoi (pour obtenir l’ID de l’élément) : npm run package -- --draft`);
  }

  const { key, ...storeManifest } = source;
  const files = PACKAGED_ROOTS.flatMap((root) => listFiles(join(EXTENSION_DIR, root)));
  const missing = referencedFiles(storeManifest).filter((file) => !files.includes(file));
  if (missing.length) throw new Error(`Fichiers du manifeste absents : ${missing.join(', ')}`);

  const directories = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) directories.add(`${parts.slice(0, depth).join('/')}/`);
  }
  const entries = [
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(storeManifest, null, 2)}\n`) },
    ...[...directories].map((name) => ({ name, data: null })),
    ...files.map((name) => ({ name, data: readFileSync(join(EXTENSION_DIR, name)) })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const zip = createZip(entries, date);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `tab-context-grouper-${source.version}${draft ? '-draft' : ''}.zip`);
  writeFileSync(path, zip);
  return {
    path,
    files: ['manifest.json', ...files],
    warnings: [...problems, ...warnings],
    extensionId: key ? extensionIdFromKey(key) : null,
    size: zip.length,
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  const { values } = parseArgs({ options: { draft: { type: 'boolean', default: false } } });
  try {
    const result = buildPackage({ draft: values.draft });
    for (const warning of result.warnings) console.warn(`Attention : ${warning}`);
    console.log(`${relative(process.cwd(), result.path) || result.path} : ${result.files.length} fichiers, ${(result.size / 1024).toFixed(1)} Ko`);
    if (result.extensionId) console.log(`ID de l'extension (d'après « key ») : ${result.extensionId}`);
    if (values.draft) console.log('Brouillon : à téléverser seulement pour obtenir l’ID de l’élément et sa clé publique, ne pas soumettre.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
