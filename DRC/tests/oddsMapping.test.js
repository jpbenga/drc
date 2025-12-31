const assert = require('assert');
const { mapFixtureOdds } = require('../src/data/oddsMapping');

function run() {
  const markets = [
    { name: 'O/U 2.5', values: [{ value: 'Over 2.5', odd: 1.9 }, { value: 'Under 2.5', odd: 1.95 }] },
    { name: 'Over/Under 3.5', values: [{ value: 'Over 3.5', odd: 2.8 }, { value: 'Under 3.5', odd: 15.0 }] },
    { name: 'Both Teams To Score', values: [{ value: 'Yes', odd: 1.7 }, { value: 'No', odd: 2.1 }] },
    { name: 'Away Team Total Goals', values: [{ value: 'Over 0.5', odd: 1.4 }] },
    { name: 'Double Chance', values: [{ value: '1X', odd: 1.3 }, { value: 'X2', odd: 1.6 }, { value: '12', odd: 1.25 }] },
  ];

  const res = mapFixtureOdds(markets);
  assert(res.markets.ou25.over.odd === 1.9);
  assert(res.markets.ou35.under.odd === 15);
  assert(res.warnings.length === 2, 'expected two warnings for implausible pricing');
  console.log('✅ odds mapping passed');
}

run();
