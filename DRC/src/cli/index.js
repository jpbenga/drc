#!/usr/bin/env node
const { run: runBacktestCli } = require('./backtest');
const { run: runEnrichCli } = require('./enrich');
const { run: runLiveCli } = require('./live');

const HELP = `Usage: node src/cli/index.js <command> [options]
Commands:
  backtest   Run the headless backtest with optional dumps and HTML report
  enrich     Validate odds mapping and write dumps for inspection
  today      Fetch live fixtures for today and evaluate via backtest
  last7days  Fetch live fixtures for the last 7 days and evaluate
  help       Show this message
`;

function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'backtest':
      return runBacktestCli(rest);
    case 'enrich':
      return runEnrichCli(rest);
    case 'today':
      return runLiveCli('today', rest);
    case 'last7days':
      return runLiveCli('last7days', rest);
    case 'help':
    case undefined:
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exitCode = 1;
      return 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
