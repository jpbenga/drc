const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDumpWriter } = require('../src/logging/dump');

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drc-dump-'));
  const writer = createDumpWriter('spec', { dir: tmp });
  const entry = writer.write('sample', { ok: true }, { tag: 'unit' });

  const saved = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(writer.manifestPath, 'utf8'));

  assert.strictEqual(saved.meta.scope, 'spec');
  assert.deepStrictEqual(saved.data, { ok: true });
  assert(manifest.length === 1, 'manifest should track single dump');
  console.log('✅ dump writer passed');
}

run();
