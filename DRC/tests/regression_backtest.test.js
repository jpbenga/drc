const assert = require('assert');
const path = require('path');
const baseline = require('./fixtures/backtest_baseline.json');
const { runBacktestHeadless } = require('../src/pipeline/backtest');

function almostEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) <= epsilon;
}

function run() {
  const fixtures = require(path.join(__dirname, 'fixtures/history_sample.json'));
  const summary = runBacktestHeadless({ fixtures });

  assert.strictEqual(summary.total, baseline.total);
  assert(almostEqual(summary.pickAccuracy, baseline.pickAccuracy));
  assert(almostEqual(summary.ou25Accuracy, baseline.ou25Accuracy));
  assert(almostEqual(summary.bttsAccuracy, baseline.bttsAccuracy));
  assert(almostEqual(summary.awayOver05Accuracy, baseline.awayOver05Accuracy));
  assert.deepStrictEqual(summary.warnings, baseline.warnings);
  assert.deepStrictEqual(summary.calibrators, baseline.calibrators);
  console.log('✅ regression backtest baseline matched');
}

run();
