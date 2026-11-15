// Chrome Web Store package: contents, manifest rewrite and ZIP validity (read back with zlib).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import * as zlib from 'node:zlib';
import { buildPackage, EXTENSION_DIR, extensionIdFromKey } from '../scripts/package.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'tcg-package-'));
after(() => rmSync(outDir, { recursive: true, force: true }));

const MANIFEST = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
const CONFIGURED = {
  ...MANIFEST,
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkey',
  oauth2: { client_id: '123456789012-abcdef.apps.googleusercontent.com', scopes: ['openid'] },
};

/** Reads a ZIP through its central directory and checks every entry (sizes, CRC-32). */
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central directory header');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const skip = buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, `local header of ${name}`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, size, `size of ${name}`);
    if (zlib.crc32) assert.equal(zlib.crc32(data), crc, `CRC-32 of ${name}`);
    entries.set(name, data);
    offset += 46 + nameLength + skip;
  }
  return entries;
}

describe('Chrome Web Store package', () => {
  test('only the runtime files, a valid archive, and the manifest without "key"', () => {
    const result = buildPackage({ manifest: CONFIGURED, outDir });
    assert.match(result.path, /tab-context-grouper-\d+\.\d+\.\d+\.zip$/);
    const entries = readZip(readFileSync(result.path));
    const names = [...entries.keys()];

    for (const required of ['manifest.json', 'src/', 'src/background/index.js', 'src/popup/popup.html', 'src/options/options.html', 'icons/icon128.png']) {
      assert.ok(names.includes(required), `${required} is packaged`);
    }
    assert.ok(!names.some((name) => /^(tests|scripts|node_modules)\/|package\.json$|(^|\/)\./.test(name)), 'no development files');
    assert.ok(names.indexOf('src/') < names.indexOf('src/background/index.js'), 'directories come first');

    const { key, ...expected } = CONFIGURED;
    assert.deepEqual(JSON.parse(entries.get('manifest.json').toString('utf8')), expected);
    assert.deepEqual(entries.get('src/background/index.js'), readFileSync(join(EXTENSION_DIR, 'src/background/index.js')));
    assert.match(result.extensionId, /^[a-p]{32}$/);
    assert.equal(result.extensionId, extensionIdFromKey(CONFIGURED.key));
  });

  test('a store build needs the Google sign-in client; a draft does not', () => {
    const { oauth2, ...withoutClient } = CONFIGURED;
    assert.throws(() => buildPackage({ manifest: withoutClient, outDir }), /client OAuth/);
    const draft = buildPackage({ manifest: withoutClient, outDir, draft: true });
    assert.match(draft.path, /-draft\.zip$/);
    assert.ok(draft.warnings.some((warning) => /client OAuth/.test(warning)));
  });

  test('every file the manifest points to must exist', () => {
    const broken = { ...CONFIGURED, options_ui: { page: 'src/options/missing.html' } };
    assert.throws(() => buildPackage({ manifest: broken, outDir }), /missing\.html/);
  });
});
