const fs = require('fs');
const path = require('path');

function createLocalStore(baseDir = 'debug/archives') {
  const resolved = path.resolve(baseDir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });

  function persist(entry) {
    if (!entry?.file) return null;
    const fileName = path.basename(entry.file);
    const target = path.join(resolved, fileName);
    fs.copyFileSync(entry.file, target);
    return target;
  }

  return { persist };
}

module.exports = { createLocalStore };
