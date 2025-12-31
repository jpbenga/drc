#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { runBacktestHeadless, loadFixturesFromDir } = require('../pipeline/backtest');
const { createLogger } = require('../logging/logger');
const { renderBacktestDashboard } = require('../ui/backtestDashboard');

function parseArgs(argv) {
  const args = {};
  argv.forEach((arg) => {
    if (arg.startsWith('--')) {
      const [k, v] = arg.replace(/^--/, '').split('=');
      args[k] = v === undefined ? true : v;
    }
  });
  return args;
}

function loadFixtures(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Fixtures path not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return loadFixturesFromDir(resolved);
  const content = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return Array.isArray(content) ? content : [];
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixturesPath = args.fixtures || path.join(__dirname, '..', '..', 'tests/fixtures/history_sample.json');
  const sampleSize = args.sample ? Number(args.sample) : null;
  const dump = args.dump || null;
  const html = args.html || null;
  const collect = Boolean(args.collect || html);
  const logger = createLogger({ scope: 'cli:backtest' });

  const fixtures = loadFixtures(fixturesPath);
  logger.info('starting_backtest', { fixtures: fixtures.length, sampleSize: sampleSize || 'all' });

  const summary = runBacktestHeadless({ fixtures, sampleSize, dumpFile: dump, collect, logger });

  if (html) {
    const rendered = renderBacktestDashboard(summary);
    const resolved = path.resolve(html);
    fs.writeFileSync(resolved, rendered, 'utf8');
    logger.info('html_report_written', { file: resolved });
  }

  if (dump && !summary.matches) {
    // ensure dump contains traces when requested explicitly without html
    runBacktestHeadless({ fixtures, sampleSize, dumpFile: dump, collect: true, logger });
  }

  logger.info('backtest_summary', summary);
  console.log(`Matches: ${summary.total}`);
  console.log(`Pick accuracy: ${(summary.pickAccuracy * 100).toFixed(2)}%`);
  console.log(`OU2.5 accuracy: ${(summary.ou25Accuracy * 100).toFixed(2)}%`);
  console.log(`BTTS accuracy: ${(summary.bttsAccuracy * 100).toFixed(2)}%`);
  console.log(`Away>0.5 accuracy: ${(summary.awayOver05Accuracy * 100).toFixed(2)}%`);
}

if (require.main === module) {
  run();
}

module.exports = { parseArgs, loadFixtures, run };
