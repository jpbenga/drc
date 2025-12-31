const assert = require('assert');
const { validateFixture, validateOdds, validateFixtureResponse } = require('../src/validation');

function run() {
  const fixture = {
    fixture: { id: 1, date: '2024-01-01T00:00:00Z' },
    league: { id: 99 },
    teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } },
    goals: { home: 1, away: 0 },
  };
  const validated = validateFixture(fixture);
  assert.strictEqual(validated.fixture.id, 1);

  assert.throws(() => validateFixture({}), /fixture/);

  const odds = validateOdds({ markets: [{ name: 'O/U 2.5', values: [{ value: 'Over 2.5', odd: '2.0' }] }] });
  assert.strictEqual(odds.markets[0].values[0].odd, 2);

  const response = validateFixtureResponse({ response: [fixture] });
  assert.strictEqual(response.response.length, 1);
  console.log('✅ validation schema test passed');
}

run();
