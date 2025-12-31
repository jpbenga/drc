#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createApiClient } = require('../data/apiClient');
const { runBacktestHeadless } = require('../pipeline/backtest');
const { createLogger } = require('../logging/logger');
const { validateFixtureResponse, validateFixture } = require('../validation');

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

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function resolveRange(range, args) {
  if (args.from || args.to) {
    return { from: args.from || args.to, to: args.to || args.from };
  }
  const today = new Date();
  if (range === 'last7days') {
    const from = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { from: iso(from), to: iso(today) };
  }
  return { from: iso(today), to: iso(today) };
}

function loadFixtures(input) {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) throw new Error(`Fixtures path not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(resolved).filter((f) => f.endsWith('.json'));
    return files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(resolved, f), 'utf8')));
  }
  const content = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return Array.isArray(content) ? content : [];
}

function loadLeagueConfig(filePath) {
  const resolved = path.resolve(filePath || path.join(__dirname, '..', '..', 'config/leagues.json'));
  if (!fs.existsSync(resolved)) throw new Error(`League config missing at ${resolved}`);
  const content = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return Array.isArray(content) ? content : [];
}

async function fetchFixturesLive({ range, leagues, apiKey, transport, schema, logger }) {
  const client = createApiClient({
    baseURL: 'https://api-football-v1.p.rapidapi.com/v3',
    apiKey,
    rateLimitPerMinute: 25,
    schema,
    transport,
  });
  const fixtures = [];
  for (const league of leagues) {
    const params = { league: league.id, season: league.season, from: range.from, to: range.to };
    logger.info('fetching_fixtures', params);
    const res = await client.get('/fixtures', params);
    const parsed = validateFixtureResponse(res, { path: `league:${league.id}` });
    fixtures.push(...parsed.response.map((f) => validateFixture(f, { path: `league:${league.id}` })));
  }
  return fixtures;
}

async function run(range, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const logger = createLogger({ scope: `cli:${range}` });
  const leagueConfig = loadLeagueConfig(args['league-config']);
  const sampleSize = args.sample ? Number(args.sample) : null;
  const dump = args.dump || null;
  const collect = Boolean(args.collect);
  const apiKey = args['api-key'] || process.env.API_FOOTBALL_KEY;
  const useFixturesFile = args.fixtures;
  const elo = args.elo ? JSON.parse(fs.readFileSync(path.resolve(args.elo), 'utf8')) : {};

  const rangeDates = resolveRange(range, args);
  let fixtures;

  if (useFixturesFile) {
    fixtures = loadFixtures(useFixturesFile).map((f, idx) => validateFixture(f, { path: `file:${idx}` }));
    logger.info('fixtures_loaded_from_file', { count: fixtures.length, path: path.resolve(useFixturesFile) });
  } else {
    fixtures = await fetchFixturesLive({
      range: rangeDates,
      leagues: leagueConfig,
      apiKey,
      schema: null,
      logger,
    });
  }

  const summary = runBacktestHeadless({ fixtures, sampleSize, dumpFile: dump, collect, eloHistory: elo, logger });
  logger.info('live_summary', { ...summary, matches: undefined });
  console.log(`Range: ${rangeDates.from} -> ${rangeDates.to}`);
  console.log(`Matches evaluated: ${summary.total}`);
  console.log(`Pick accuracy: ${(summary.pickAccuracy * 100).toFixed(2)}%`);
  return summary;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error('Usage: node src/cli/live.js <today|last7days> [options]');
    process.exit(1);
  }
  run(cmd, rest).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, resolveRange, run, loadLeagueConfig, loadFixtures, fetchFixturesLive };
