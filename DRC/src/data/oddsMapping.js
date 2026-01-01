const SAFE_MIN_ODD = 1.01;
const SAFE_MAX_ODD = 150;

const MARKET_DEFS = {
  OU25: {
    key: 'ou25',
    names: ['O/U 2.5', 'Over/Under 2.5'],
    values: {
      over: ['Over 2.5', 'over 2.5'],
      under: ['Under 2.5', 'under 2.5'],
    },
  },
  OU35: {
    key: 'ou35',
    names: ['O/U 3.5', 'Over/Under 3.5'],
    values: {
      over: ['Over 3.5', 'over 3.5'],
      under: ['Under 3.5', 'under 3.5'],
    },
  },
  BTTS: {
    key: 'btts',
    names: ['Both Teams Score', 'Both Teams To Score'],
    values: {
      yes: ['Yes', 'Both Teams Score', 'btts yes'],
      no: ['No', 'btts no'],
    },
  },
  AWAY_OVER_05: {
    key: 'away_over_05',
    names: ['Away Team Total Goals'],
    values: {
      over: ['Over 0.5', 'Away Over 0.5'],
    },
  },
  DOUBLE_CHANCE: {
    key: 'double_chance',
    names: ['Double Chance'],
    values: {
      '1X': ['1X'],
      X2: ['X2'],
      '12': ['12'],
    },
  },
};

function norm(str) {
  return (str || '').toString().trim().toLowerCase();
}

function impliedProbability(odd) {
  return 1 / odd;
}

function checkOddsSanity(odd) {
  return Number.isFinite(odd) && odd >= SAFE_MIN_ODD && odd <= SAFE_MAX_ODD;
}

function detectAnomalies(pair) {
  const warnings = [];
  if (!pair) return warnings;
  const values = Object.values(pair).filter((v) => v && v.odd);
  const invalid = values.filter((v) => !checkOddsSanity(v.odd));
  invalid.forEach((v) => warnings.push(`Odd out of bounds for ${v.code || 'value'}: ${v.odd}`));

  if (values.length >= 2) {
    const impliedSum = values.reduce((acc, v) => acc + impliedProbability(v.odd), 0);
    if (impliedSum < 0.7 || impliedSum > 1.4) {
      warnings.push(`Implied probability sum looks inconsistent: ${impliedSum.toFixed(2)}`);
    }
  }

  return warnings;
}

function mapOutcomes(marketDef, marketData) {
  const mapped = {};
  const warnings = [];
  const outcomes = marketData?.values || marketData?.outcomes || [];
  outcomes.forEach((o) => {
    const name = norm(o.value || o.name);
    const odd = Number(o.odd || o.price || o.odds);
    Object.entries(marketDef.values).forEach(([code, labels]) => {
      if (labels.map(norm).includes(name)) {
        mapped[code] = { odd, code, name: o.value || o.name };
      }
    });
  });

  const missingKeys = Object.keys(marketDef.values).filter((k) => !mapped[k]);
  if (missingKeys.length) warnings.push(`Missing outcomes: ${missingKeys.join(', ')}`);

  return { mapped, warnings: warnings.concat(detectAnomalies(mapped)) };
}

function findMarket(def, markets) {
  return markets.find((m) => def.names.map(norm).includes(norm(m.name)));
}

function mapFixtureOdds(markets = []) {
  const result = { markets: {}, warnings: [] };

  Object.values(MARKET_DEFS).forEach((def) => {
    const market = findMarket(def, markets);
    if (!market) {
      result.warnings.push(`Market missing: ${def.key}`);
      return;
    }
    const { mapped, warnings } = mapOutcomes(def, market);
    result.markets[def.key] = mapped;
    result.warnings.push(...warnings.map((w) => `${def.key}: ${w}`));
  });

  return result;
}

module.exports = {
  MARKET_DEFS,
  mapFixtureOdds,
  impliedProbability,
  checkOddsSanity,
};
