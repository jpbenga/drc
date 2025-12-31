function renderPage({ title, body, styles = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title || 'Report'}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #0c0c0f; color: #e8e8ed; }
    h1, h2, h3 { color: #f5f5f7; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #2b2b33; padding: 8px; text-align: left; }
    th { background: #1a1a20; }
    caption { caption-side: top; color: #b2b2bb; margin-bottom: 6px; }
    .warning { color: #ffb347; }
    ${styles}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

module.exports = { renderPage };
