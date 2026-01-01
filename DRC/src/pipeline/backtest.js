const fs = require('fs');
const path = require('path');
const { calculatePoissonPro, PlattCalibrator, clamp, createRoiTracker } = require('../core');
const { mapFixtureOdds } = require('../data/oddsMapping');
const { writeDump } = require('../logging/dump');
const { createLogger } = require('../logging/logger');
const { validateFixture, validateOdds } = require('../validation');

const DEFAULT_PARAMS = {
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

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ensureTracker(tracker, teamId) {
  if (!tracker[teamId]) tracker[teamId] = { xg: [], ga: [] };
  return tracker[teamId];
}

function runBacktestHeadless({
  fixtures,
  eloHistory = {},
  params = {},
  sampleSize = null,
  dumpFile,
  collect = false,
  logger = createLogger({ scope: 'pipeline:backtest' }),
} = {}) {
  if (!Array.isArray(fixtures)) throw new Error('fixtures must be an array');
  const p = { ...DEFAULT_PARAMS, ...params };
  const tracker = {};
  const calibrators = {
    ou25: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
    btts: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
    awayOver05: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
  };
  const roiTracker = createRoiTracker({ initialBankroll: 100, strategy: 'kelly', kellyFraction: 0.3 });
  const global = {
    total: 0,
    correctPicks: 0,
    bttsCorrect: 0,
    ouCorrect: 0,
    awayOver05Correct: 0,
    warnings: [],
  };

  const traces = [];

  const sorted = [...fixtures]
    .map((f) => validateFixture(f))
    .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

  const limited = sampleSize ? sorted.slice(0, sampleSize) : sorted;

  limited.forEach((m) => {
    const lid = m.league?.id || 'unknown';
    const roundKey = m.league?.round || 'R';
    const hid = m.teams.home.id;
    const aid = m.teams.away.id;
    ensureTracker(tracker, hid);
    ensureTracker(tracker, aid);

    const actualH = m.goals.home;
    const actualA = m.goals.away;
    const actualScore = `${actualH}-${actualA}`;

    const canPredict = tracker[hid].xg.length >= p.min_matches && tracker[aid].xg.length >= p.min_matches;
    if (!canPredict) {
      const seedXGH = safeNumber(m.stats?.home?.expected_goals ?? m.goals.home);
      const seedXGA = safeNumber(m.stats?.away?.expected_goals ?? m.goals.away);
      if (seedXGH != null && seedXGA != null) {
        tracker[hid].xg.push(seedXGH);
        tracker[hid].ga.push(actualA);
        tracker[aid].xg.push(seedXGA);
        tracker[aid].ga.push(actualH);
      }
      return;
    }

    const eloHome = eloHistory?.[lid]?.[roundKey]?.[m.teams.home.name] ?? 1500;
    const eloAway = eloHistory?.[lid]?.[roundKey]?.[m.teams.away.name] ?? 1500;

    const res = calculatePoissonPro({
      params: p,
      tracker,
      match: m,
      metaHome: m.metaHome || {},
      metaAway: m.metaAway || {},
      homeId: hid,
      awayId: aid,
      eloHome,
      eloAway,
    });

    if (!res) return;

    const pick = res.H >= res.A ? '1X' : 'X2';
    const isCorrect = pick === '1X' ? actualH >= actualA : actualA >= actualH;
    if (isCorrect) global.correctPicks += 1;

    const pBTTS = clamp(res.raw.btts, 1e-6, 1 - 1e-6);
    const pOver25 = clamp(res.raw.over25, 1e-6, 1 - 1e-6);
    const pAwayOver05 = clamp(res.raw.awayScores, 1e-6, 1 - 1e-6);

    if (actualH > 0 && actualA > 0) calibrators.btts.update(pBTTS, true);
    else calibrators.btts.update(pBTTS, false);

    const yOver = actualH + actualA > 2;
    calibrators.ou25.update(pOver25, yOver);
    const yAway05 = actualA > 0;
    calibrators.awayOver05.update(pAwayOver05, yAway05);

    if (yOver === (pOver25 >= 0.5)) global.ouCorrect += 1;
    if (yAway05 === (pAwayOver05 >= 0.5)) global.awayOver05Correct += 1;
    if ((actualH > 0 && actualA > 0) === (pBTTS >= 0.5)) global.bttsCorrect += 1;

    if (m.odds) {
      const odds = validateOdds(m.odds, { path: `fixture:${m.fixture.id}` });
      const mapped = mapFixtureOdds(odds?.markets || []);
      if (mapped.warnings.length) {
        global.warnings.push({ fixture: m.fixture.id, warnings: mapped.warnings });
      }
      const dcMarket = mapped.markets.double_chance;
      if (dcMarket) {
        const prob = pick === '1X' ? res.H + res.D : res.D + res.A;
        const outcome = pick === '1X' ? actualH >= actualA : actualA >= actualH;
        const odd = dcMarket[pick]?.odd;
        roiTracker.recordBet({ market: 'double_chance', selection: pick, probability: prob, odd, outcome, meta: { fixture: m.fixture.id } });
      }
      const ouMarket = mapped.markets.ou25;
      if (ouMarket && ouMarket.over?.odd && ouMarket.under?.odd) {
        const outcome = actualH + actualA > 2;
        const odd = outcome ? ouMarket.over.odd : ouMarket.under.odd;
        const prob = outcome ? pOver25 : 1 - pOver25;
        roiTracker.recordBet({ market: 'ou25', selection: outcome ? 'over' : 'under', probability: prob, odd, outcome, meta: { fixture: m.fixture.id } });
      }
      const bttsMarket = mapped.markets.btts;
      if (bttsMarket) {
        const outcome = actualH > 0 && actualA > 0;
        const odd = outcome ? bttsMarket.yes?.odd : bttsMarket.no?.odd;
        const prob = outcome ? pBTTS : 1 - pBTTS;
        roiTracker.recordBet({ market: 'btts', selection: outcome ? 'yes' : 'no', probability: prob, odd, outcome, meta: { fixture: m.fixture.id } });
      }
      const awayOverMarket = mapped.markets.away_over_05;
      if (awayOverMarket?.over?.odd) {
        const outcome = actualA > 0;
        const prob = pAwayOver05;
        roiTracker.recordBet({ market: 'away_over_05', selection: 'over', probability: prob, odd: awayOverMarket.over.odd, outcome, meta: { fixture: m.fixture.id } });
      }
    }

    global.total += 1;

    if (collect) {
      traces.push({
        fixtureId: m.fixture.id,
        date: m.fixture.date,
        league: m.league,
        teams: { home: m.teams.home.name, away: m.teams.away.name },
        actual: { home: actualH, away: actualA },
        pick,
        probs: { H: res.H, D: res.D, A: res.A, ou25: pOver25, btts: pBTTS, awayOver05: pAwayOver05 },
      });
    }

    const nextXGH = safeNumber(m.stats?.home?.expected_goals ?? m.goals.home);
    const nextXGA = safeNumber(m.stats?.away?.expected_goals ?? m.goals.away);
    if (nextXGH != null && nextXGA != null) {
      tracker[hid].xg.push(nextXGH);
      tracker[hid].ga.push(actualA);
      tracker[aid].xg.push(nextXGA);
      tracker[aid].ga.push(actualH);
    }

    logger.debug('match_processed', {
      fixture: m.fixture.id,
      score: actualScore,
      pick,
      probs: { H: res.H, D: res.D, A: res.A },
    });
  });

  const summary = {
    total: global.total,
    pickAccuracy: global.total ? global.correctPicks / global.total : 0,
    ou25Accuracy: global.total ? global.ouCorrect / global.total : 0,
    bttsAccuracy: global.total ? global.bttsCorrect / global.total : 0,
    awayOver05Accuracy: global.total ? global.awayOver05Correct / global.total : 0,
    roi: roiTracker.summary(),
    warnings: global.warnings,
    calibrators: {
      ou25: calibrators.ou25.snapshot(),
      btts: calibrators.btts.snapshot(),
      awayOver05: calibrators.awayOver05.snapshot(),
    },
    matches: collect ? traces : undefined,
  };

  if (dumpFile) {
    const file = path.isAbsolute(dumpFile) ? dumpFile : path.resolve(dumpFile);
    writeDump(path.basename(file, '.json'), summary, {
      dir: path.dirname(file),
      meta: { scope: 'backtest', sampleSize: sampleSize || 'all' },
    });
  }

  return summary;
}

function loadFixturesFromDir(dirPath) {
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  const fixtures = [];
  files.forEach((file) => {
    const content = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
    if (Array.isArray(content)) fixtures.push(...content);
  });
  return fixtures;
}

module.exports = { runBacktestHeadless, loadFixturesFromDir };
