const DEFAULTS = {
  min_matches: 3,
  confidence_shrinkage: 15,
  max_goals: 20,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function fact(n) {
  return n <= 1 ? 1 : n * fact(n - 1);
}

function clubEloWinProb(deltaElo) {
  return 1 / (Math.pow(10, -deltaElo / 400) + 1);
}

function bayesianShrinkage(teamStats, leagueAvg, confidenceShrinkage) {
  const n = teamStats.length;
  if (n === 0) return leagueAvg;
  const teamMean = teamStats.reduce((a, b) => a + b, 0) / n;
  const C = Number(confidenceShrinkage ?? DEFAULTS.confidence_shrinkage);
  return (C * leagueAvg + n * teamMean) / (C + n);
}

function dixonColesTau(i, j, lh, la, rho) {
  if (!rho) return 1;
  if (i === 0 && j === 0) return 1 - (lh * la * rho);
  if (i === 0 && j === 1) return 1 + (lh * rho);
  if (i === 1 && j === 0) return 1 + (la * rho);
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

function buildScoreMatrix(lh, la, rho, maxGoals) {
  const MAX = Number(maxGoals ?? DEFAULTS.max_goals);
  const probs = [];
  let sumRaw = 0;
  let minRaw = Infinity;

  for (let i = 0; i <= MAX; i++) {
    const pi = (Math.exp(-lh) * Math.pow(lh, i)) / fact(i);
    for (let j = 0; j <= MAX; j++) {
      const pj = (Math.exp(-la) * Math.pow(la, j)) / fact(j);
      let p = pi * pj * dixonColesTau(i, j, lh, la, rho);
      if (p < minRaw) minRaw = p;
      if (p < 0) p = 0;
      sumRaw += p;
      probs.push(p);
    }
  }

  if (!(sumRaw > 0)) {
    probs.length = 0;
    sumRaw = 0;
    minRaw = 0;
    for (let i = 0; i <= MAX; i++) {
      const pi = (Math.exp(-lh) * Math.pow(lh, i)) / fact(i);
      for (let j = 0; j <= MAX; j++) {
        const pj = (Math.exp(-la) * Math.pow(la, j)) / fact(j);
        const p = pi * pj;
        sumRaw += p;
        probs.push(p);
      }
    }
  }

  const inv = 1 / sumRaw;
  for (let k = 0; k < probs.length; k++) probs[k] *= inv;

  return { probs, sumRaw, minRaw, maxGoals: MAX };
}

function idx(i, j, maxGoals) {
  return i * (maxGoals + 1) + j;
}

function detectImpactAbsences(match, meta, side) {
  const injuries = side === "home" ? match.context?.injuries_home : match.context?.injuries_away;
  const playerRatings = side === "home" ? match.context?.player_ratings_home : match.context?.player_ratings_away;
  if (!injuries || !meta) return { offensive: 0, defensive: 0, absences: [] };

  const absences = [];
  let offensiveImpact = 0;
  let defensiveImpact = 0;

  const topScorers = Array.isArray(meta.top_scorers) ? meta.top_scorers : [];
  const topAssists = Array.isArray(meta.top_assists) ? meta.top_assists : [];
  const topDefenders = Array.isArray(meta.top_defenders) ? meta.top_defenders : [];
  const topGoalkeepers = Array.isArray(meta.top_goalkeepers) ? meta.top_goalkeepers : [];

  const normId = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : x;
  };

  const normName = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

  const findName = (pid, fallback) => {
    const pidN = normId(pid);

    const fromInjury = injuries.find((x) => normId(x.player_id) === pidN);
    if (fromInjury?.player_name) return fromInjury.player_name;

    const fromRatings = playerRatings?.find((p) => normId(p.id) === pidN);
    if (fromRatings?.name) return fromRatings.name;

    const s = topScorers.find((p) => normId(p.id) === pidN);
    if (s?.name) return s.name;

    const a = topAssists.find((p) => normId(p.id) === pidN);
    if (a?.name) return a.name;

    return fallback || `#${pid}`;
  };

  const inList = (list, pid, pName) => {
    const pidN = normId(pid);
    if (list.some((x) => normId(x.id) === pidN)) return true;
    const n = normName(pName);
    if (!n) return false;
    return list.some((x) => normName(x.name) === n);
  };

  injuries.forEach((inj) => {
    const pid = inj.player_id;
    const pName = inj.player_name || inj.name || "";
    const tags = [];
    let off = 0;
    let def = 0;

    const isTopScorer = inList(topScorers, pid, pName);
    if (isTopScorer) {
      tags.push("Top Scorer");
      off += 1;
      offensiveImpact += 1;
    }

    const isTopAssist = inList(topAssists, pid, pName);
    if (isTopAssist) {
      tags.push("Top Assist");
      off += 0.5;
      offensiveImpact += 0.5;
    }

    const isTopDef = inList(topDefenders, pid, pName);
    if (isTopDef) {
      tags.push("Top Defender");
      def += 0.8;
      defensiveImpact += 0.8;
    }

    const isTopGK = inList(topGoalkeepers, pid, pName);
    if (isTopGK) {
      tags.push("Top GK");
      def += 1.2;
      defensiveImpact += 1.2;
    }

    const ratingMatch = playerRatings?.find((p) => normId(p.id) === normId(pid));
    if (ratingMatch?.rating) {
      const r = Number(ratingMatch.rating);
      if (Number.isFinite(r)) {
        const delta = clamp((7.5 - r) / 10, -0.5, 0.5);
        off += delta;
        def += delta / 2;
      }
    }

    absences.push({
      player_id: pid,
      name: findName(pid, pName),
      tags,
      impact_off: Number(off.toFixed(2)),
      impact_def: Number(def.toFixed(2)),
    });
  });

  return {
    offensive: Number(offensiveImpact.toFixed(2)),
    defensive: Number(defensiveImpact.toFixed(2)),
    absences,
  };
}

function calculatePoissonPro({
  params,
  tracker,
  match,
  metaHome,
  metaAway,
  homeId,
  awayId,
  eloHome,
  eloAway,
}) {
  const p = { ...DEFAULTS, ...(params || {}) };
  const minMatches = p.min_matches;
  if (tracker[homeId].xg.length < minMatches || tracker[awayId].xg.length < minMatches) return null;

  const allXG = [...tracker[homeId].xg, ...tracker[awayId].xg];
  const leagueAvgXG = allXG.reduce((a, b) => a + b, 0) / (allXG.length || 1);

  const attH = bayesianShrinkage(tracker[homeId].xg, leagueAvgXG, p.confidence_shrinkage);
  const defA = bayesianShrinkage(tracker[awayId].ga, leagueAvgXG, p.confidence_shrinkage);
  const attA = bayesianShrinkage(tracker[awayId].xg, leagueAvgXG, p.confidence_shrinkage);
  const defH = bayesianShrinkage(tracker[homeId].ga, leagueAvgXG, p.confidence_shrinkage);

  const pWinH = clubEloWinProb((eloHome - eloAway) + p.hfa);
  const pWinA = 1 - pWinH;

  let lh = (attH * 0.6 + defA * 0.4) * p.w_xg * Math.pow((pWinH / 0.5), p.w_elo);
  let la = (attA * 0.6 + defH * 0.4) * p.w_xg * Math.pow((pWinA / 0.5), p.w_elo);

  const lh_base = lh;
  const la_base = la;

  const impactDebug = { home: null, away: null };

  if (match.context) {
    const impactH = detectImpactAbsences(match, metaHome, "home");
    const impactA = detectImpactAbsences(match, metaAway, "away");
    impactDebug.home = impactH;
    impactDebug.away = impactA;

    if (impactH.offensive > 0) lh *= (1 - p.impact_offensive * impactH.offensive);
    if (impactA.defensive > 0) lh *= (1 + p.impact_defensive * impactA.defensive);
    if (impactA.offensive > 0) la *= (1 - p.impact_offensive * impactA.offensive);
    if (impactH.defensive > 0) la *= (1 + p.impact_defensive * impactH.defensive);
  }

  lh = Math.max(lh, 0.01);
  la = Math.max(la, 0.01);

  const { probs, sumRaw, minRaw, maxGoals } = buildScoreMatrix(lh, la, p.rho, p.max_goals ?? p.score_matrix_max);

  let pH = 0; let pD = 0; let pA = 0;
  let pBTTS = 0;
  let pUnder25 = 0;
  let pHomeScores = 0;
  let pAwayScores = 0;
  let pHomeLE1 = 0;
  let pAwayLE1 = 0;

  const scoreProbs = [];

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const prob = probs[idx(i, j, maxGoals)];
      if (i > j) pH += prob;
      else if (i === j) pD += prob;
      else pA += prob;

      if (i > 0 && j > 0) pBTTS += prob;
      if ((i + j) <= 2) pUnder25 += prob;
      if (i > 0) pHomeScores += prob;
      if (j > 0) pAwayScores += prob;

      scoreProbs.push({ score: `${i}-${j}`, prob });
    }
  }

  for (let j = 0; j <= maxGoals; j++) {
    pHomeLE1 += probs[idx(0, j, maxGoals)] + probs[idx(1, j, maxGoals)];
    pAwayLE1 += probs[idx(j, 0, maxGoals)] + probs[idx(j, 1, maxGoals)];
  }

  const pOver25 = 1 - pUnder25;
  const pHomeOver15 = 1 - pHomeLE1;
  const pAwayOver15 = 1 - pAwayLE1;

  const top3 = scoreProbs.sort((a, b) => b.prob - a.prob).slice(0, 3);

  return {
    H: pH, D: pD, A: pA,
    top3,
    pred: top3[0]?.score || "0-0",
    pScore: top3[0] ? (top3[0].prob * 100).toFixed(1) : "—",
    raw: {
      btts: pBTTS,
      over25: pOver25,
      under25: pUnder25,
      homeScores: pHomeScores,
      awayScores: pAwayScores,
      homeOver15: pHomeOver15,
      awayOver15: pAwayOver15,
    },
    debug: {
      lh_base, la_base, lh, la,
      rho: p.rho,
      hfa: p.hfa,
      hElo: eloHome,
      aElo: eloAway,
      impact: impactDebug,
      matrix_sum_raw: sumRaw,
      matrix_min_raw: minRaw,
      matrix_max_goals: maxGoals,
    },
  };
}

function calculateErrorVector(pred, actual) {
  const [pH, pA] = pred.split("-").map(Number);
  const [aH, aA] = actual.split("-").map(Number);
  return {
    home: pH - aH,
    away: pA - aA,
    manhattan: Math.abs(pH - aH) + Math.abs(pA - aA),
  };
}

module.exports = {
  bayesianShrinkage,
  buildScoreMatrix,
  calculateErrorVector,
  calculatePoissonPro,
  clubEloWinProb,
  detectImpactAbsences,
  dixonColesTau,
  fact,
};
