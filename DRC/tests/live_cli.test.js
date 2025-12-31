const assert = require('assert');
const { run, resolveRange } = require('../src/cli/live');

async function runTest() {
  const summary = await run('today', ['--fixtures=tests/fixtures/history_sample.json']);
  assert.strictEqual(summary.total, 3);
  assert(summary.pickAccuracy > 0);

  const range = resolveRange('last7days', {});
  const [fromYear] = range.from.split('-');
  assert(fromYear.length === 4);
  console.log('✅ live CLI test passed');
}

runTest().catch((err) => {
  console.error('live CLI test failed', err);
  process.exit(1);
});
