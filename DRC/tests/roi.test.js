const assert = require('assert');
const { createRoiTracker, calculateKellyStake } = require('../src/core');
const { runBacktestHeadless } = require('../src/pipeline/backtest');
const fixtures = require('./fixtures/history_sample.json');

function testKelly() {
  const stake = calculateKellyStake(0.55, 2.1, 100, 0.5);
  assert(stake > 0, 'kelly stake should be positive');
}

function testTracker() {
  const tracker = createRoiTracker({ initialBankroll: 50, strategy: 'flat', unitStake: 2 });
  tracker.recordBet({ market: 'dc', selection: '1X', probability: 0.6, odd: 1.8, outcome: true });
  tracker.recordBet({ market: 'ou25', selection: 'over', probability: 0.45, odd: 2.2, outcome: false });
  const summary = tracker.summary();
  assert.strictEqual(summary.totalBets, 2);
  assert(summary.bankrollEnd !== summary.bankrollStart);
}

function testPipelineRoi() {
  const summary = runBacktestHeadless({ fixtures, collect: true });
  assert(summary.roi, 'roi summary should be present');
  assert(summary.roi.totalBets >= 0);
}

function run() {
  testKelly();
  testTracker();
  testPipelineRoi();
  console.log('✅ roi tests passed');
}

run();
