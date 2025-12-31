const assert = require('assert');
const { renderBacktestDashboard } = require('../src/ui/backtestDashboard');

function run() {
  const summary = {
    total: 2,
    pickAccuracy: 0.5,
    ou25Accuracy: 0.5,
    bttsAccuracy: 1,
    awayOver05Accuracy: 0,
    warnings: [{ fixture: 101, warnings: ['Market missing: ou35'] }],
    calibrators: { ou25: { n: 2 }, btts: { n: 2 }, awayOver05: { n: 2 } },
    matches: [
      {
        teams: { home: 'Alpha', away: 'Beta' },
        actual: { home: 1, away: 0 },
        pick: '1X',
        probs: { H: 0.55, D: 0.25, A: 0.2, ou25: 0.35, btts: 0.3, awayOver05: 0.25 },
      },
    ],
  };

  const html = renderBacktestDashboard(summary);
  assert(html.includes('Backtest summary'));
  assert(html.includes('Global metrics'));
  assert(html.includes('Match traces'));
  assert(html.includes('Odds mapping warnings'));
  console.log('✅ backtest dashboard render passed');
}

run();
