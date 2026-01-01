function createLogger({ scope } = {}) {
  const base = { scope };
  const fmt = (level, message, meta) => ({
    ts: new Date().toISOString(),
    level,
    message,
    ...base,
    ...(meta || {}),
  });

  return {
    info: (message, meta) => console.log(JSON.stringify(fmt('info', message, meta))),
    warn: (message, meta) => console.warn(JSON.stringify(fmt('warn', message, meta))),
    error: (message, meta) => console.error(JSON.stringify(fmt('error', message, meta))),
    debug: (message, meta) => console.log(JSON.stringify(fmt('debug', message, meta))),
  };
}

module.exports = { createLogger };
