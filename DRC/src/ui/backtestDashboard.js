const { renderTable } = require('./components');
const { renderPage } = require('./layout');

function formatPct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function renderMetrics(summary) {
  const headers = ['Metric', 'Value'];
  const rows = [
    ['Matches', summary.total],
    ['Pick accuracy', formatPct(summary.pickAccuracy || 0)],
    ['OU 2.5 accuracy', formatPct(summary.ou25Accuracy || 0)],
    ['BTTS accuracy', formatPct(summary.bttsAccuracy || 0)],
    ['Away >0.5 accuracy', formatPct(summary.awayOver05Accuracy || 0)],
  ];
  return renderTable(headers, rows, { caption: 'Global metrics' });
}

function renderWarnings(warnings) {
  if (!warnings || warnings.length === 0) return '<p>No odds warnings detected.</p>';
  const headers = ['Fixture', 'Warnings'];
  const rows = warnings.map((w) => [w.fixture, w.warnings.join('<br/>')]);
  return renderTable(headers, rows, { caption: 'Odds mapping warnings' });
}

function renderMatches(matches = []) {
  if (!matches.length) return '<p>No match traces collected (use collect=true).</p>';
  const headers = ['Fixture', 'Score', 'Pick', 'P(H)', 'P(D)', 'P(A)', 'P(Over2.5)', 'P(BTTS)', 'P(Away>0.5)'];
  const rows = matches.slice(0, 50).map((m) => [
    `${m.teams.home} vs ${m.teams.away}`,
    `${m.actual.home}-${m.actual.away}`,
    m.pick,
    m.probs?.H?.toFixed ? m.probs.H.toFixed(3) : '',
    m.probs?.D?.toFixed ? m.probs.D.toFixed(3) : '',
    m.probs?.A?.toFixed ? m.probs.A.toFixed(3) : '',
    m.probs?.ou25?.toFixed ? m.probs.ou25.toFixed(3) : '',
    m.probs?.btts?.toFixed ? m.probs.btts.toFixed(3) : '',
    m.probs?.awayOver05?.toFixed ? m.probs.awayOver05.toFixed(3) : '',
  ]);
  return renderTable(headers, rows, { caption: 'Match traces (first 50)' });
}

function renderBacktestDashboard(summary) {
  const body = `
  <h1>Backtest summary</h1>
  ${renderMetrics(summary)}
  <h2>Calibrators</h2>
  <pre>${JSON.stringify(summary.calibrators, null, 2)}</pre>
  <h2>Warnings</h2>
  ${renderWarnings(summary.warnings)}
  <h2>Traces</h2>
  ${renderMatches(summary.matches || [])}
`;
  return renderPage({ title: 'Backtest report', body });
}

module.exports = { renderBacktestDashboard };
