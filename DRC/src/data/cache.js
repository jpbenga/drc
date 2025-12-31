const fs = require('fs');
const path = require('path');
const { validateWithSchema } = require('../validation');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isExpired(filePath, ttlMs) {
  if (!ttlMs) return false;
  const stats = fs.statSync(filePath);
  const age = Date.now() - stats.mtimeMs;
  return age > ttlMs;
}

function readJsonCached(filePath, { ttlMs, schema } = {}) {
  if (!fs.existsSync(filePath)) return null;
  if (isExpired(filePath, ttlMs)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (schema) validateWithSchema(data, schema, { path: filePath });
  return data;
}

function writeJsonCached(filePath, data) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function touch(filePath) {
  ensureDir(filePath);
  fs.closeSync(fs.openSync(filePath, 'a'));
  fs.utimesSync(filePath, new Date(), new Date());
}

module.exports = {
  readJsonCached,
  writeJsonCached,
  touch,
};
