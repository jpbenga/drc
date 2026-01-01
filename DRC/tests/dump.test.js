const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDumpWriter } = require('../src/logging/dump');
const { createLocalStore } = require('../src/storage/persistence');

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-dump-'));
  const archives = path.join(tmp, 'archives');
  const store = createLocalStore(archives);
  const writer = createDumpWriter('spec', { dir: tmp, retention: 1, persist: store.persist });
  const entry = writer.write('sample', { ok: true }, { tag: 'unit' });
  const saved = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  writer.write('second', { next: true });

  const manifest = JSON.parse(fs.readFileSync(writer.manifestPath, 'utf8'));
  const archivedFiles = fs.readdirSync(archives);

  assert.strictEqual(saved.meta.scope, 'spec');
  assert.deepStrictEqual(saved.data, { ok: true });
  assert(manifest.length === 1, 'manifest should enforce retention');
  assert(archivedFiles.length >= 1, 'archive store should receive copies');
  console.log('✅ dump writer passed');
}

run();
