const assert = require('assert');
const { calculatePoissonPro, PlattCalibrator } = require('../src/core');

function approx(actual, expected, tol = 1e-6) {
  return Math.abs(actual - expected) <= tol;
}

const params = {
  w_xg: 1.071767,
  w_elo: 0.490061,
  rho: 0.067551,
  hfa: 63.171357,
  impact_offensive: 0.069775,
  impact_defensive: 0.045351,
  min_matches: 3,
  confidence_shrinkage: 18.60107,
  max_goals: 8,
};

const tracker = {
  1: { xg: [1.2, 1.1, 1.4, 1.05], ga: [0.9, 1.0, 0.8, 1.2] },
  2: { xg: [0.9, 1.0, 0.85, 1.1], ga: [1.1, 1.3, 0.7, 0.95] },
};

const meta = {
  top_scorers: [{ id: 10, name: 'Striker A' }],
  top_assists: [{ id: 11, name: 'Playmaker B' }],
  top_defenders: [{ id: 12, name: 'Defender C' }],
  top_goalkeepers: [{ id: 13, name: 'Keeper D' }],
};

const match = {
  context: {
    injuries_home: [
      { player_id: 10, player_name: 'Striker A' },
      { player_id: 12, player_name: 'Defender C' },
    ],
    injuries_away: [
      { player_id: 13, player_name: 'Keeper D' },
    ],
    player_ratings_home: [
      { id: 10, name: 'Striker A', rating: '6.7' },
    ],
    player_ratings_away: [
      { id: 13, name: 'Keeper D', rating: '7.2' },
    ],
  },
};

const res = calculatePoissonPro({
  params,
  tracker,
  match,
  metaHome: meta,
  metaAway: meta,
  homeId: 1,
  awayId: 2,
  eloHome: 1580,
  eloAway: 1520,
});

assert(res, 'Expected a result from calculatePoissonPro');
assert(approx(res.H, 0.4569543176434209, 1e-9));
assert(approx(res.D, 0.2624893513003226, 1e-9));
assert(approx(res.A, 0.28055633105625655, 1e-9));
assert.deepStrictEqual(res.top3.map((t) => t.score), ['1-0', '1-1', '0-1']);
assert(approx(res.raw.btts, 0.44145325502652105, 1e-9));
assert(approx(res.raw.over25, 0.3960251740798634, 1e-9));
assert(approx(res.raw.under25, 0.6039748259201366, 1e-9));
assert(approx(res.raw.homeScores, 0.731166838774732, 1e-9));
assert(approx(res.raw.awayScores, 0.6157567717973598, 1e-9));
assert(approx(res.raw.homeOver15, 0.378007643228755, 1e-9));
assert(approx(res.raw.awayOver15, 0.24823569213019492, 1e-9));
assert(approx(res.debug.lh_base, 1.3393236681573173, 1e-9));
assert(approx(res.debug.la_base, 0.9229933661410742, 1e-9));
assert(approx(res.debug.lh, 1.313674228046769, 1e-9));
assert(approx(res.debug.la, 0.9564803038593653, 1e-9));

const cal = new PlattCalibrator({ lr: 0.02, reg: 0.001 });
const before = cal.predict(0.72);
assert(approx(before, 0.72, 1e-12));
cal.update(0.72, true);
const after = cal.predict(0.72);
assert(approx(after, 0.7221272235299733, 1e-12));
assert(approx(cal.a, 1.0052689850095087, 1e-12));
assert(approx(cal.b, 0.005600000000000001, 1e-12));

console.log('✅ smoke_backtest passed');
