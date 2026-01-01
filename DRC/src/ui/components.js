function renderTable(headers, rows, { caption } = {}) {
  const thead = headers.map((h) => `<th>${h}</th>`).join('');
  const tbody = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c != null ? c : ''}</td>`).join('')}</tr>`)
    .join('\n');
  const cap = caption ? `<caption>${caption}</caption>` : '';
  return `<table>${cap}<thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

function renderConfidenceBuckets(buckets) {
  const headers = ['Bucket', 'Matches', 'Win%', 'ROI'];
  const rows = buckets.map((b) => [
    b.label,
    b.count,
    `${(b.winPct * 100).toFixed(1)}%`,
    `${(b.roi * 100).toFixed(2)}%`,
  ]);
  return renderTable(headers, rows, { caption: 'Confidence Buckets' });
}

module.exports = {
  renderTable,
  renderConfidenceBuckets,
};
