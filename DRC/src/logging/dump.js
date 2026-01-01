const fs = require('fs');
const path = require('path');

function writeDump(label, data, { dir = 'debug/dumps', meta } = {}) {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const folder = path.resolve(dir);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${safeLabel}.json`);
  const payload = meta ? { meta, data } : data;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

function pruneManifest(manifest, retention) {
  if (!retention || manifest.length <= retention) return [];
  const extra = manifest.length - retention;
  return manifest.splice(0, extra);
}

function createDumpWriter(scope, { dir = 'debug/dumps', withManifest = true, retention, persist } = {}) {
  const baseDir = path.resolve(dir, scope);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const manifestPath = path.join(baseDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];

  function write(label, data, meta = {}) {
    const ts = new Date().toISOString();
    const stampedLabel = `${ts.replace(/[:.]/g, '-')}_${label}`;
    const file = writeDump(stampedLabel, data, { dir: baseDir, meta: { ...meta, scope, ts } });
    const entry = { label, file, ts, meta };
    manifest.push(entry);
    const removed = pruneManifest(manifest, retention);
    removed.forEach((r) => {
      if (fs.existsSync(r.file)) fs.unlinkSync(r.file);
    });
    if (withManifest) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    if (persist && typeof persist === 'function') persist(entry);
    return entry;
  }

  return { write, manifestPath };
}

module.exports = { writeDump, createDumpWriter };
