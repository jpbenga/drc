#!/usr/bin/env node
const path = require('path');
const { mapFixtureOdds } = require('../data/oddsMapping');
const { createDumpWriter } = require('../logging/dump');
const { createLogger } = require('../logging/logger');
const { parseArgs, loadFixtures } = require('./backtest');

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixturesPath = args.fixtures || path.join(__dirname, '..', '..', 'tests/fixtures/history_sample.json');
  const dumpDir = args.dump || path.join('debug', 'dumps', 'enrich');
  const logger = createLogger({ scope: 'cli:enrich' });
  const fixtures = loadFixtures(fixturesPath);

  logger.info('enrich_start', { fixtures: fixtures.length, dumpDir });

  const writer = createDumpWriter('odds_enrich', { dir: dumpDir });
  const reports = fixtures.map((f) => {
    const mapped = mapFixtureOdds(f.odds?.markets || []);
    return {
      fixtureId: f.fixture?.id,
      league: f.league,
      warnings: mapped.warnings,
      markets: mapped.markets,
    };
  });

  const warningsCount = reports.reduce((acc, r) => acc + (r.warnings?.length || 0), 0);
  writer.write('odds_mapping', { reports }, { fixtures: fixtures.length, warnings: warningsCount });

  logger.info('enrich_done', { fixtures: fixtures.length, warnings: warningsCount, manifest: writer.manifestPath });
}

if (require.main === module) {
  run();
}

module.exports = { run };
