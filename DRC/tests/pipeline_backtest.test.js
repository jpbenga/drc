const assert = require('assert');
const path = require('path');
const { runBacktestHeadless } = require('../src/pipeline/backtest');

function run() {
  const fixtures = require(path.join(__dirname, 'fixtures/history_sample.json'));
  const summary = runBacktestHeadless({ fixtures });

  assert.strictEqual(summary.total, 3, 'expected three evaluated matches');
  assert(summary.pickAccuracy >= 0 && summary.pickAccuracy <= 1);
  assert(summary.calibrators.ou25.n === 3);
  assert(summary.warnings.length >= 1, 'expected odds anomaly warnings');
  console.log('✅ pipeline backtest passed');
}

run();
