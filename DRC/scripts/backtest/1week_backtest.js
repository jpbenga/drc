/**
 * scripts/backtest/1week_backtest.js
 *
 * SDM ULTRA — 7 derniers jours • Cotes pre-match • ROI (1u)
 * - Always bet (toujours choisir le côté le plus probable) sur :
 *   - 1X vs X2 (Double Chance)
 *   - Over/Under 2.5
 *   - Over/Under 3.5
 *   - BTTS Yes/No
 *   - Away Team Total Goals Over/Under 0.5
 * - Rapport GLOBAL + PAR LIGUE
 * - Rapport PAR TRANCHES DE CONFIANCE (accuracy + ROI) (global + par ligue)
 * - Cache odds: ./data/cache_odds/fixture_<id>.json
 *
 * Dépendances: node >= 18
 * ENV: APISPORTS_KEY (obligatoire)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

// ---------------------------
// CONFIG
// ---------------------------
const PORT = 3000;
const API_BASE = "https://v3.football.api-sports.io";
const APISPORTS_KEY = process.env.APISPORTS_KEY || process.env.API_FOOTBALL_KEY || "";

const DAYS = 7;
const ODDS_SLEEP_MS = 250; // prudence rate-limit
const MAX_GOALS = 8;       // matrice 0..8

// Ligues (les mêmes que ton backtest principal)
const LEAGUES_CONFIG = {
  "39": { name: "Premier League" },
  "61": { name: "Ligue 1" },
  "78": { name: "Bundesliga" },
  "140": { name: "La Liga" },
  "135": { name: "Serie A" },
  "94": { name: "Liga Portugal" },
  "88": { name: "Eredivisie" },
  "197": { name: "Super League (GRE)" },
  "203": { name: "Süper Lig" },
};

// Files
const PATHS = {
  elo: "./data/elo/elo_history_archive.json",
  history: (lid) => `./data/history/history_${lid}.json`,
  meta: (lid) => `./data/meta/league_${lid}_meta.json`,
  params: "./data/params/optimized_params.json",
  cache_odds: "./data/cache_odds",
};

// Buckets confiance
const BUCKETS = [
  { key: "90-100", label: "90-100%", min: 90, max: 100 },
  { key: "80-90",  label: "80-90%",  min: 80, max: 90  },
  { key: "70-80",  label: "70-80%",  min: 70, max: 80  },
  { key: "60-70",  label: "60-70%",  min: 60, max: 70  },
  { key: "50-60",  label: "50-60%",  min: 50, max: 60  },
];

// ---------------------------
// PARAMS (chargés + fallback)
// ---------------------------
let PARAMS = {
  w_xg: 1.071767,
  w_elo: 0.490061,
  rho: 0.067551,
  hfa: 63.171357,
  impact_offensive: 0.069775,
  impact_defensive: 0.045351,

  min_matches: 3,
  confidence_shrinkage: 18.60107,
};

if (fs.existsSync(PATHS.params)) {
  try {
    const optimized = JSON.parse(fs.readFileSync(PATHS.params, "utf8"));
    if (optimized?.best_params) PARAMS = { ...PARAMS, ...optimized.best_params };
    console.log("✅ Paramètres optimisés chargés");
  } catch {
    console.log("⚠️  Utilisation des paramètres par défaut");
  }
}

// ---------------------------
// Utils
// ---------------------------
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pct = (num, den, d = 2) => (den ? ((num / den) * 100).toFixed(d) : "—");

function confBucketKey(conf) {
  const c = clamp(conf, 0, 100);
  for (const b of BUCKETS) {
    if (c >= b.min && (c < b.max || b.max === 100)) return b.key;
  }
  return null;
}
function confColor(conf) {
  const c = clamp(conf, 0, 100);
  if (c >= 90) return "#10b981";
  if (c >= 80) return "#0ea5e9";
  if (c >= 70) return "#fbbf24";
  if (c >= 60) return "#a78bfa";
  return "#94a3b8";
}
function confBadge(conf) {
  const c = clamp(conf, 0, 100);
  const bg = confColor(c);
  const fg = (bg === "#94a3b8") ? "#0f172a" : "#000";
  return `<span style="display:inline-block;padding:6px 10px;border-radius:8px;background:${bg};color:${fg};font-weight:800">${c.toFixed(0)}%</span>`;
}

// factorial memo (fast for small n)
const FACT = [1];
function fact(n) {
  while (FACT.length <= n) FACT.push(FACT[FACT.length - 1] * FACT.length);
  return FACT[n];
}

function clubEloWinProb(deltaElo) {
  return 1 / (Math.pow(10, -deltaElo / 400) + 1);
}

// Shrinkage Bayésien (simple et stable) : utilise confidence_shrinkage appris par Optuna
function bayesianShrinkage(teamStats, leagueAvg) {
  const n = teamStats.length;
  if (!n) return leagueAvg;
  const teamMean = teamStats.reduce((a, b) => a + b, 0) / n;
  const C = Number(PARAMS.confidence_shrinkage ?? 15);
  return (C * leagueAvg + n * teamMean) / (C + n);
}

// Poisson CDF (k inclus)
function poissonCdf(lambda, k) {
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += Math.exp(-lambda) * Math.pow(lambda, i) / fact(i);
  }
  return sum;
}

// ---------------------------
// Impact Players (détection)
// ---------------------------
function detectImpactAbsences(match, meta, side) {
  const injuries = side === "home" ? match.context?.injuries_home : match.context?.injuries_away;
  const playerRatings = side === "home" ? match.context?.player_ratings_home : match.context?.player_ratings_away;
  if (!injuries || !meta) return { offensive: 0, defensive: 0, absences: [] };

  const topScorers = meta.top_scorers || [];
  const topAssists = meta.top_assists || [];

  let offensive = 0;
  let defensive = 0;
  const absences = [];

  const getName = (pid) => {
    const fromInj = injuries.find((x) => x.player_id === pid);
    if (fromInj?.player_name) return fromInj.player_name;
    const fromRatings = playerRatings?.find((p) => p.id === pid);
    if (fromRatings?.name) return fromRatings.name;
    const s = topScorers.find((p) => p.id === pid);
    if (s?.name) return s.name;
    const a = topAssists.find((p) => p.id === pid);
    if (a?.name) return a.name;
    return `#${pid}`;
  };

  for (const inj of injuries) {
    if (inj.type !== "Missing Fixture") continue;
    const pid = inj.player_id;

    let dOff = 0;
    let dDef = 0;
    const tags = [];

    if (topScorers.some((p) => p.id === pid)) {
      dOff += 1.0;
      tags.push("Top Scorer");
    }
    if (topAssists.some((p) => p.id === pid)) {
      dOff += 0.5;
      tags.push("Top Assist");
    }

    const pr = playerRatings?.find((p) => p.id === pid);
    const pos = pr?.position || inj.position || "—";
    const rating = pr?.rating != null ? Number(pr.rating) : null;

    if (pr && (pos === "Defender" || pos === "Goalkeeper") && rating != null && rating > 7.0) {
      dDef += 1.0;
      tags.push("Key Defender/GK");
    }

    offensive += dOff;
    defensive += dDef;

    absences.push({
      id: pid,
      name: getName(pid),
      position: pos,
      rating,
      reason: inj.reason || inj.detail || "Missing Fixture",
      dOff,
      dDef,
      tags,
    });
  }

  return { offensive, defensive, absences };
}

// ---------------------------
// Simple online Platt scaling (SGD)
// calibrated = sigmoid(a * logit(p) + b)
// ---------------------------
function logit(p) {
  const x = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(x / (1 - x));
}
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}
function plattInit() {
  return { a: 1.0, b: 0.0, n: 0 };
}
function plattPredict(cal, p) {
  const z = cal.a * logit(p) + cal.b;
  return sigmoid(z);
}
function plattUpdate(cal, p, y, lr = 0.02) {
  const x = logit(p);
  const z = cal.a * x + cal.b;
  const q = sigmoid(z);
  const grad = (q - y);   // dL/dz for log-loss
  cal.a -= lr * grad * x;
  cal.b -= lr * grad * 1.0;
  cal.n += 1;
}

// ---------------------------
// Odds fetch + parsing
// ---------------------------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} ${text}`.trim());
  }
  return res.json();
}

// Normalisation strings
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseOddValue(v) {
  // API-Football returns strings or numbers
  const x = Number(v);
  return Number.isFinite(x) && x > 1.0 ? x : null;
}

// Picks: return odd for the desired market/selection (best effort)
function extractOdds(oddsPayload) {
  // returns a structure:
  // {
  //   doubleChance: { "1X": odd, "X2": odd },
  //   ou25: { over: odd, under: odd },
  //   ou35: { over: odd, under: odd },
  //   btts: { yes: odd, no: odd },
  //   awaytt05: { over: odd, under: odd }
  // }
  const out = {
    doubleChance: { "1X": null, "X2": null },
    ou25: { over: null, under: null },
    ou35: { over: null, under: null },
    btts: { yes: null, no: null },
    awaytt05: { over: null, under: null },
  };

  const resp = oddsPayload?.response;
  if (!Array.isArray(resp) || resp.length === 0) return out;

  // Each response item can contain bookmakers[].bets[]
  // We'll scan all bookmakers and keep first found; if multiple, keep best (max) to be consistent
  const scanBet = (bet) => {
    const betName = norm(bet?.name);
    const values = Array.isArray(bet?.values) ? bet.values : [];

    // helper to assign max
    const setMax = (obj, key, odd) => {
      if (!odd) return;
      if (!obj[key] || odd > obj[key]) obj[key] = odd;
    };

    // DOUBLE CHANCE
    if (betName.includes("double chance") || betName === "double chance") {
      for (const v of values) {
        const vv = String(v?.value || "");
        const ov = parseOddValue(v?.odd);
        const vvN = norm(vv);

        // variants
        if (vv === "1X" || vvN === "1x" || vvN.includes("home draw") || (vvN.includes("home") && vvN.includes("draw"))) setMax(out.doubleChance, "1X", ov);
        if (vv === "X2" || vvN === "x2" || vvN.includes("draw away") || (vvN.includes("draw") && vvN.includes("away"))) setMax(out.doubleChance, "X2", ov);
      }
    }

    // OVER/UNDER (full time)
    if (betName.includes("goals over under") || betName.includes("over under")) {
      for (const v of values) {
        const vv = String(v?.value || "");
        const ov = parseOddValue(v?.odd);
        const vvN = norm(vv);

        // examples: "Over 2.5", "Under 2.5"
        const isOver = vvN.startsWith("over");
        const isUnder = vvN.startsWith("under");

        if (vvN.includes("2 5")) {
          if (isOver) setMax(out.ou25, "over", ov);
          if (isUnder) setMax(out.ou25, "under", ov);
        }
        if (vvN.includes("3 5")) {
          if (isOver) setMax(out.ou35, "over", ov);
          if (isUnder) setMax(out.ou35, "under", ov);
        }
      }
    }

    // BTTS
    if (betName.includes("both teams to score") || betName === "btts") {
      for (const v of values) {
        const vv = norm(v?.value || "");
        const ov = parseOddValue(v?.odd);
        if (vv === "yes") setMax(out.btts, "yes", ov);
        if (vv === "no") setMax(out.btts, "no", ov);
      }
    }

    // AWAY TEAM TOTAL GOALS
    // naming can vary, we accept "away team total goals" / "team total goals away"
    if (betName.includes("away team total goals") || betName.includes("team total goals away")) {
      for (const v of values) {
        const vv = String(v?.value || "");
        const ov = parseOddValue(v?.odd);
        const vvN = norm(vv); // "over 0.5" "under 0.5"
        const isOver = vvN.startsWith("over");
        const isUnder = vvN.startsWith("under");
        if (vvN.includes("0 5")) {
          if (isOver) setMax(out.awaytt05, "over", ov);
          if (isUnder) setMax(out.awaytt05, "under", ov);
        }
      }
    }
  };

  for (const item of resp) {
    const bookmakers = Array.isArray(item?.bookmakers) ? item.bookmakers : [];
    for (const bm of bookmakers) {
      const bets = Array.isArray(bm?.bets) ? bm.bets : [];
      for (const bet of bets) scanBet(bet);
    }
  }

  return out;
}

async function getOddsForFixture(fixtureId, leagueId, season) {
  ensureDir(PATHS.cache_odds);
  const cacheFile = path.join(PATHS.cache_odds, `fixture_${fixtureId}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      // fall through
    }
  }

  if (!APISPORTS_KEY) {
    return null; // odds disabled if no key
  }

  const url = new URL(`${API_BASE}/odds`);
  url.searchParams.set("fixture", String(fixtureId));
  // league/season not strictly required if fixture provided, but helps sometimes
  if (leagueId) url.searchParams.set("league", String(leagueId));
  if (season) url.searchParams.set("season", String(season));

  const json = await fetchJson(url.toString(), {
    "x-apisports-key": APISPORTS_KEY,
  });

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(json, null, 2));
  } catch {
    // ignore
  }

  await sleep(ODDS_SLEEP_MS);
  return json;
}

// ---------------------------
// Model: compute probabilities (matrix) + calibrated markets
// ---------------------------
function computeMatchProbs(match, hElo, aElo, tracker, meta) {
  const hID = match.teams.home.id;
  const aID = match.teams.away.id;

  const minMatches = Number(PARAMS.min_matches ?? 3);
  if ((tracker[hID]?.xg?.length ?? 0) < minMatches || (tracker[aID]?.xg?.length ?? 0) < minMatches) return null;

  const allXG = [...tracker[hID].xg, ...tracker[aID].xg];
  const leagueAvgXG = allXG.length ? (allXG.reduce((a, b) => a + b, 0) / allXG.length) : 1.5;

  // Attack and defense proxies:
  // - xg: expected goals FOR
  // - ga: goals conceded (we shrink it toward league avg as well)
  const attH = bayesianShrinkage(tracker[hID].xg, leagueAvgXG);
  const attA = bayesianShrinkage(tracker[aID].xg, leagueAvgXG);
  const defH = bayesianShrinkage(tracker[hID].ga, leagueAvgXG);
  const defA = bayesianShrinkage(tracker[aID].ga, leagueAvgXG);

  const pWinH = clubEloWinProb((hElo - aElo) + Number(PARAMS.hfa ?? 0));
  const pWinA = 1 - pWinH;

  let lh = (attH * 0.6 + defA * 0.4) * Number(PARAMS.w_xg ?? 1) * Math.pow((pWinH / 0.5), Number(PARAMS.w_elo ?? 1));
  let la = (attA * 0.6 + defH * 0.4) * Number(PARAMS.w_xg ?? 1) * Math.pow((pWinA / 0.5), Number(PARAMS.w_elo ?? 1));

  const lh_base = lh;
  const la_base = la;

  // Impact Players
  const impact = { home: null, away: null };
  if (match.context && meta) {
    const impactH = detectImpactAbsences(match, meta, "home");
    const impactA = detectImpactAbsences(match, meta, "away");
    impact.home = impactH;
    impact.away = impactA;

    // apply multiplicatively (same logic as ton backtest)
    if (impactH.offensive > 0) lh *= (1 - Number(PARAMS.impact_offensive ?? 0) * impactH.offensive);
    if (impactA.defensive > 0) lh *= (1 + Number(PARAMS.impact_defensive ?? 0) * impactA.defensive);
    if (impactA.offensive > 0) la *= (1 - Number(PARAMS.impact_offensive ?? 0) * impactA.offensive);
    if (impactH.defensive > 0) la *= (1 + Number(PARAMS.impact_defensive ?? 0) * impactH.defensive);
  }

  lh = Math.max(lh, 0.01);
  la = Math.max(la, 0.01);

  // Score matrix + Dixon-Coles for low scores via rho
  const rho = Number(PARAMS.rho ?? 0);

  let pH = 0, pD = 0, pA = 0;

  // submarkets (raw from matrix)
  let p_btts_yes = 0;
  let p_over25 = 0;
  let p_over35 = 0;
  let p_home_over15 = 0;
  let p_home_over05 = 0;
  let p_away_over05 = 0;

  // track sum & min (debug)
  let sumP = 0;
  let minP = 1;

  // store top scores
  const scoreProbs = [];

  for (let i = 0; i <= MAX_GOALS; i++) {
    const pi = Math.exp(-lh) * Math.pow(lh, i) / fact(i);
    for (let j = 0; j <= MAX_GOALS; j++) {
      const pj = Math.exp(-la) * Math.pow(la, j) / fact(j);

      // Dixon-Coles style adjustment for (0,0) (0,1) (1,0) (1,1)
      let corr = 1;
      if (rho !== 0) {
        if (i === 0 && j === 0) corr = 1 - (lh * la * rho);
        else if (i === 0 && j === 1) corr = 1 + (la * rho);
        else if (i === 1 && j === 0) corr = 1 + (lh * rho);
        else if (i === 1 && j === 1) corr = 1 - rho;
      }

      const p = pi * pj * corr;
      sumP += p;
      if (p < minP) minP = p;

      scoreProbs.push({ score: `${i}-${j}`, prob: p });

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      // raw subs:
      if (i > 0 && j > 0) p_btts_yes += p;
      if (i + j > 2) p_over25 += p;
      if (i + j > 3) p_over35 += p;

      if (i > 1) p_home_over15 += p;
      if (i > 0) p_home_over05 += p;
      if (j > 0) p_away_over05 += p;
    }
  }

  // Normalize due to corr adjustments (keeps probabilities sane)
  // If sumP deviates slightly from 1, renormalize key probs.
  if (sumP > 0) {
    pH /= sumP; pD /= sumP; pA /= sumP;
    p_btts_yes /= sumP;
    p_over25 /= sumP;
    p_over35 /= sumP;
    p_home_over15 /= sumP;
    p_home_over05 /= sumP;
    p_away_over05 /= sumP;
    for (const s of scoreProbs) s.prob /= sumP;
  }

  const top3 = scoreProbs.sort((a, b) => b.prob - a.prob).slice(0, 3);

  // derived complements
  const p_btts_no = 1 - p_btts_yes;
  const p_under25 = 1 - p_over25;
  const p_under35 = 1 - p_over35;

  // Away Team Total Goals Over 0.5 is simply P(away scores >=1)
  // from matrix it is p_away_over05; complement is under0.5.
  const p_away_tt_over05 = p_away_over05;
  const p_away_tt_under05 = 1 - p_away_tt_over05;

  // Double chance
  const p_1x = pH + pD;
  const p_x2 = pA + pD;

  return {
    p1x: p_1x, px2: p_x2,
    p_over25, p_under25,
    p_over35, p_under35,
    p_btts_yes, p_btts_no,
    p_away_tt_over05, p_away_tt_under05,
    p_home_over15, p_home_over05,
    top3,
    debug: {
      lh_base, la_base, lh, la, rho, hfa: Number(PARAMS.hfa ?? 0), hElo, aElo,
      matrix_sum_raw: sumP, matrix_min_raw: minP,
      impact,
    }
  };
}

// ---------------------------
// Betting logic (ALWAYS BET)
// ---------------------------
function alwaysBetBinary(pYes, yesLabel, noLabel) {
  // returns { pickLabel, pickProb, confPct, isYesPick }
  const pNo = 1 - pYes;
  if (pYes >= pNo) return { pickLabel: yesLabel, pickProb: pYes, confPct: pYes * 100, isYesPick: true };
  return { pickLabel: noLabel, pickProb: pNo, confPct: pNo * 100, isYesPick: false };
}
function alwaysBetPair(pA, labelA, pB, labelB) {
  // choose max
  if (pA >= pB) return { pickLabel: labelA, pickProb: pA, confPct: pA * 100 };
  return { pickLabel: labelB, pickProb: pB, confPct: pB * 100 };
}

// ROI (1u): if win => odd-1 else -1
function pnl1u(win, odd) {
  if (!odd) return null;
  return win ? (odd - 1) : -1;
}

// ---------------------------
// Data load
// ---------------------------
if (!fs.existsSync(PATHS.elo)) {
  console.error(`❌ Elo archive manquante: ${PATHS.elo}`);
  process.exit(1);
}
const ELO_HISTORY = JSON.parse(fs.readFileSync(PATHS.elo, "utf8"));

// ---------------------------
// Aggregators
// ---------------------------
function makeMarketAgg() {
  return {
    bets: 0,
    wins: 0,

    oddsBets: 0,
    pnl: 0,

    buckets: Object.fromEntries(BUCKETS.map(b => [b.key, { bets: 0, wins: 0, oddsBets: 0, pnl: 0 }])),
  };
}

function aggAdd(agg, confPctVal, win, odd) {
  agg.bets++;
  if (win) agg.wins++;

  const k = confBucketKey(confPctVal);
  if (k) {
    agg.buckets[k].bets++;
    if (win) agg.buckets[k].wins++;
  }

  const p = pnl1u(win, odd);
  if (p != null) {
    agg.oddsBets++;
    agg.pnl += p;
    if (k) {
      agg.buckets[k].oddsBets++;
      agg.buckets[k].pnl += p;
    }
  }
}

function marketSummaryRow(name, agg) {
  const acc = agg.bets ? `${agg.wins}/${agg.bets} (${pct(agg.wins, agg.bets, 2)}%)` : "—";
  const roi = agg.oddsBets ? `${pct(agg.pnl, agg.oddsBets, 2)}%` : "—";
  const oddsBets = agg.bets ? `${agg.oddsBets}/${agg.bets}` : "—";
  const pnl = agg.oddsBets ? `${agg.pnl >= 0 ? "+" : ""}${agg.pnl.toFixed(2)}` : "+0.00";
  return { name, acc, oddsBets, roi, pnl };
}

// ---------------------------
// MAIN BACKTEST (7 days + warm-up history)
// ---------------------------
async function runBacktest() {
  console.log("\n" + "=".repeat(90));
  console.log("🚀 BACKTEST — 7 derniers jours + Cotes pre-match (Always Bet + Buckets + Per League)");
  console.log("=".repeat(90));
  console.log(`📊 Confiance Bayésienne (C) : ${PARAMS.confidence_shrinkage}`);
  console.log(`📏 Score matrix max goals   : ${MAX_GOALS}`);
  console.log("=".repeat(90) + "\n");

  const now = Date.now();
  const since = now - DAYS * 24 * 3600 * 1000;

  const leaguesOut = {};
  for (const lid of Object.keys(LEAGUES_CONFIG)) {
    leaguesOut[lid] = {
      id: lid,
      name: LEAGUES_CONFIG[lid].name,
      matches: [],
      markets: {
        "1X": makeMarketAgg(),
        "X2": makeMarketAgg(),
        "Over 2.5": makeMarketAgg(),
        "Under 2.5": makeMarketAgg(),
        "Over 3.5": makeMarketAgg(),
        "Under 3.5": makeMarketAgg(),
        "BTTS Yes": makeMarketAgg(),
        "BTTS No": makeMarketAgg(),
        "Away TT Over 0.5": makeMarketAgg(),
        "Away TT Under 0.5": makeMarketAgg(),
      },
    };
  }

  const global = {
    total: 0,
    sdmWins: 0,
    scoreExact: 0,
    scoreTop3: 0,

    markets: {
      "1X": makeMarketAgg(),
      "X2": makeMarketAgg(),
      "Over 2.5": makeMarketAgg(),
      "Under 2.5": makeMarketAgg(),
      "Over 3.5": makeMarketAgg(),
      "Under 3.5": makeMarketAgg(),
      "BTTS Yes": makeMarketAgg(),
      "BTTS No": makeMarketAgg(),
      "Away TT Over 0.5": makeMarketAgg(),
      "Away TT Under 0.5": makeMarketAgg(),
    },
  };

  // Optional meta (impact players)
  const metaByLeague = {};
  for (const lid of Object.keys(LEAGUES_CONFIG)) {
    const metaFile = PATHS.meta(lid);
    if (fs.existsSync(metaFile)) {
      try { metaByLeague[lid] = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
    }
  }

  // For each league: load full history, warm-up tracker chronologically,
  // but only evaluate matches within last 7 days.
  for (const lid of Object.keys(LEAGUES_CONFIG)) {
    const file = PATHS.history(lid);
    if (!fs.existsSync(file)) continue;

    const history = JSON.parse(fs.readFileSync(file, "utf8"))
      .filter(m => m?.fixture?.status?.short === "FT" && m?.goals?.home != null)
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    const tracker = {}; // per team: xg[] and ga[] (goals against)

    for (const m of history) {
      const hID = m.teams.home.id;
      const aID = m.teams.away.id;
      if (!tracker[hID]) tracker[hID] = { xg: [], ga: [] };
      if (!tracker[aID]) tracker[aID] = { xg: [], ga: [] };

      // Elo lookup
      const rKey = m.league.round;
      const hName = m.teams.home.name;
      const aName = m.teams.away.name;
      const hElo = ELO_HISTORY?.[lid]?.[rKey]?.[hName] ?? 1500;
      const aElo = ELO_HISTORY?.[lid]?.[rKey]?.[aName] ?? 1500;

      // Evaluate if within last 7d window (but tracker warm-start is always chronological)
      const t = new Date(m.fixture.date).getTime();
      const inWindow = (t >= since && t <= now);

      let probs = null;
      if (inWindow) {
        probs = computeMatchProbs(m, hElo, aElo, tracker, metaByLeague[lid] || null);
      }

      // Always update tracker after (so current match isn't in its own history)
      // Need xG present
      const xgH = m?.stats?.home?.expected_goals;
      const xgA = m?.stats?.away?.expected_goals;
      const gH = m.goals.home;
      const gA = m.goals.away;

      if (xgH != null && xgA != null && gH != null && gA != null) {
        tracker[hID].xg.push(Number(xgH) || 0);
        tracker[hID].ga.push(Number(gA) || 0);
        tracker[aID].xg.push(Number(xgA) || 0);
        tracker[aID].ga.push(Number(gH) || 0);
      }

      if (!inWindow || !probs) continue;

      // Odds
      const oddsJson = await getOddsForFixture(m.fixture.id, m.league.id, m.league.season);
      const odds = oddsJson ? extractOdds(oddsJson) : null;

      const actualH = Number(gH);
      const actualA = Number(gA);
      const totalGoals = actualH + actualA;

      // SDM (always choose 1X or X2)
      const sdmPick = alwaysBetPair(probs.p1x, "1X", probs.px2, "X2"); // pickProb already "confidence"
      const sdmWin = (sdmPick.pickLabel === "1X") ? (actualH >= actualA) : (actualA >= actualH);

      global.total++;
      if (sdmWin) global.sdmWins++;

      const actualScore = `${actualH}-${actualA}`;
      const predTop1 = probs.top3?.[0]?.score || "0-0";
      const isExact = predTop1 === actualScore;
      const isTop3 = (probs.top3 || []).some(s => s.score === actualScore);
      if (isExact) global.scoreExact++;
      if (isTop3) global.scoreTop3++;

      // --- Markets (always bet) ---
      // Double chance odds
      const odd1X = odds?.doubleChance?.["1X"] ?? null;
      const oddX2 = odds?.doubleChance?.["X2"] ?? null;

      // OU 2.5
      const pickOU25 = alwaysBetBinary(probs.p_over25, "Over 2.5", "Under 2.5");
      const ou25Win = (pickOU25.pickLabel === "Over 2.5") ? (totalGoals > 2) : (totalGoals < 3);
      const oddOU25 = (pickOU25.pickLabel === "Over 2.5") ? (odds?.ou25?.over ?? null) : (odds?.ou25?.under ?? null);

      // OU 3.5
      const pickOU35 = alwaysBetBinary(probs.p_over35, "Over 3.5", "Under 3.5");
      const ou35Win = (pickOU35.pickLabel === "Over 3.5") ? (totalGoals > 3) : (totalGoals < 4);
      const oddOU35 = (pickOU35.pickLabel === "Over 3.5") ? (odds?.ou35?.over ?? null) : (odds?.ou35?.under ?? null);

      // BTTS
      const pickBTTS = alwaysBetBinary(probs.p_btts_yes, "BTTS Yes", "BTTS No");
      const actualBTTS = (actualH > 0 && actualA > 0);
      const bttsWin = (pickBTTS.pickLabel === "BTTS Yes") ? actualBTTS : !actualBTTS;
      const oddBTTS = (pickBTTS.pickLabel === "BTTS Yes") ? (odds?.btts?.yes ?? null) : (odds?.btts?.no ?? null);

      // Away TT Over/Under 0.5
      const pickAwayTT = alwaysBetBinary(probs.p_away_tt_over05, "Away TT Over 0.5", "Away TT Under 0.5");
      const awayTTWin = (pickAwayTT.pickLabel === "Away TT Over 0.5") ? (actualA > 0) : (actualA === 0);
      const oddAwayTT = (pickAwayTT.pickLabel === "Away TT Over 0.5") ? (odds?.awaytt05?.over ?? null) : (odds?.awaytt05?.under ?? null);

      // --- aggregate global ---
      aggAdd(global.markets[sdmPick.pickLabel], sdmPick.confPct, sdmWin, (sdmPick.pickLabel === "1X") ? odd1X : oddX2);

      aggAdd(global.markets[pickOU25.pickLabel], pickOU25.confPct, ou25Win, oddOU25);
      aggAdd(global.markets[pickOU35.pickLabel], pickOU35.confPct, ou35Win, oddOU35);

      aggAdd(global.markets[pickBTTS.pickLabel], pickBTTS.confPct, bttsWin, oddBTTS);

      aggAdd(global.markets[pickAwayTT.pickLabel], pickAwayTT.confPct, awayTTWin, oddAwayTT);

      // --- per league ---
      const L = leaguesOut[lid];
      if (L) {
        aggAdd(L.markets[sdmPick.pickLabel], sdmPick.confPct, sdmWin, (sdmPick.pickLabel === "1X") ? odd1X : oddX2);
        aggAdd(L.markets[pickOU25.pickLabel], pickOU25.confPct, ou25Win, oddOU25);
        aggAdd(L.markets[pickOU35.pickLabel], pickOU35.confPct, ou35Win, oddOU35);
        aggAdd(L.markets[pickBTTS.pickLabel], pickBTTS.confPct, bttsWin, oddBTTS);
        aggAdd(L.markets[pickAwayTT.pickLabel], pickAwayTT.confPct, awayTTWin, oddAwayTT);
      }

      // store match row for dashboard
      leaguesOut[lid].matches.push({
        leagueId: lid,
        leagueName: LEAGUES_CONFIG[lid].name,
        date: m.fixture.date,
        fixtureId: m.fixture.id,

        home: m.teams.home.name,
        away: m.teams.away.name,

        actual: actualScore,
        predTop1,
        top3: probs.top3,

        sdm: {
          pick: sdmPick.pickLabel,
          p_pick: sdmPick.pickProb,
          conf: sdmPick.confPct,
          odd: (sdmPick.pickLabel === "1X") ? odd1X : oddX2,
          win: sdmWin,
        },

        markets: {
          ou25: { pick: pickOU25.pickLabel, p_pick: pickOU25.pickProb, conf: pickOU25.confPct, odd: oddOU25, win: ou25Win },
          ou35: { pick: pickOU35.pickLabel, p_pick: pickOU35.pickProb, conf: pickOU35.confPct, odd: oddOU35, win: ou35Win },
          btts: { pick: pickBTTS.pickLabel, p_pick: pickBTTS.pickProb, conf: pickBTTS.confPct, odd: oddBTTS, win: bttsWin },
          awaytt: { pick: pickAwayTT.pickLabel, p_pick: pickAwayTT.pickProb, conf: pickAwayTT.confPct, odd: oddAwayTT, win: awayTTWin },
        },

        oddsFound: !!oddsJson,
        oddsRaw: odds || null,

        debug: probs.debug,
      });
    }
  }

  // ---------------------------
  // Console summary
  // ---------------------------
  console.log("\n" + "=".repeat(90));
  console.log("📊 LAST 7 DAYS — SUMMARY");
  console.log("=".repeat(90));
  console.log(`Matches evaluated (7d) : ${global.total}`);
  console.log(`SDM accuracy           : ${pct(global.sdmWins, global.total, 2)}% (${global.sdmWins}/${global.total})`);
  console.log(`Score exact (Top1)     : ${pct(global.scoreExact, global.total, 2)}% (${global.scoreExact}/${global.total})`);
  console.log(`Score exact (Top3)     : ${pct(global.scoreTop3, global.total, 2)}% (${global.scoreTop3}/${global.total})`);
  console.log("-".repeat(90));

  const marketOrder = ["1X","X2","Over 2.5","Under 2.5","Over 3.5","Under 3.5","BTTS Yes","BTTS No","Away TT Over 0.5","Away TT Under 0.5"];
  for (const k of marketOrder) {
    const a = global.markets[k];
    const acc = a.bets ? `${pct(a.wins, a.bets, 2)}%` : "—%";
    const roi = a.oddsBets ? `${pct(a.pnl, a.oddsBets, 2)}%` : "—%";
    console.log(`${k.padEnd(16)} acc=${acc.padStart(7)} | odds_bets=${String(a.oddsBets).padStart(4)} | ROI=${roi.padStart(8)}`);
  }
  console.log("=".repeat(90));

  // ---------------------------
  // Dashboard
  // ---------------------------
  startServer(global, leaguesOut);
}

// ---------------------------
// Dashboard server
// ---------------------------
function startServer(global, leaguesOut) {
  const allMatches = Object.values(leaguesOut).flatMap(l => l.matches || [])
    .sort((a, b) => new Date(b.date) - new Date(a.date)); // most recent first

  const marketOrder = ["1X","X2","Over 2.5","Under 2.5","Over 3.5","Under 3.5","BTTS Yes","BTTS No","Away TT Over 0.5","Away TT Under 0.5"];

  function renderMarketTable(marketsAgg) {
    const rows = marketOrder.map((name) => marketSummaryRow(name, marketsAgg[name]));
    return `
      <table class="tbl">
        <thead>
          <tr>
            <th>Marché</th>
            <th>Accuracy</th>
            <th>Bets avec cotes</th>
            <th>ROI</th>
            <th>PnL total</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td style="font-weight:800">${escapeHtml(r.name)}</td>
              <td>${escapeHtml(r.acc)}</td>
              <td>${escapeHtml(r.oddsBets)}</td>
              <td>${escapeHtml(r.roi)}</td>
              <td style="font-weight:800">${escapeHtml(r.pnl)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  function renderBucketsTable(agg, title) {
    const rows = BUCKETS.map(b => {
      const s = agg.buckets[b.key];
      const acc = s.bets ? `${s.wins}/${s.bets} (${pct(s.wins, s.bets, 2)}%)` : "—";
      const roi = s.oddsBets ? `${pct(s.pnl, s.oddsBets, 2)}%` : "—";
      const pnl = s.oddsBets ? `${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(2)}` : "+0.00";
      return `
        <tr>
          <td>${b.label}</td>
          <td>${escapeHtml(acc)}</td>
          <td>${escapeHtml(s.oddsBets ? `${s.oddsBets}/${s.bets}` : `0/${s.bets}`)}</td>
          <td>${escapeHtml(roi)}</td>
          <td style="font-weight:800">${escapeHtml(pnl)}</td>
        </tr>
      `;
    }).join("");

    return `
      <div class="box">
        <div class="box-title">📊 ${escapeHtml(title)} — Tranches de confiance</div>
        <table class="tbl">
          <thead>
            <tr>
              <th>Tranche</th>
              <th>Accuracy</th>
              <th>Bets avec cotes</th>
              <th>ROI</th>
              <th>PnL</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderPerMarketBuckets(marketAggs, prefixTitle) {
    // One collapsible per market (global or league)
    return marketOrder.map(mk => {
      const agg = marketAggs[mk];
      return `
        <details class="details">
          <summary><span class="sum-title">${escapeHtml(prefixTitle)} • ${escapeHtml(mk)}</span></summary>
          ${renderBucketsTable(agg, `${prefixTitle} • ${mk}`)}
        </details>
      `;
    }).join("");
  }

  const leagueCards = Object.values(leaguesOut)
    .filter(l => (l.matches || []).length)
    .map(l => {
      const n = l.matches.length;
      // SDM global in that league:
      const sdmAgg1X = l.markets["1X"];
      const sdmAggX2 = l.markets["X2"];
      const sdmBets = sdmAgg1X.bets + sdmAggX2.bets;
      const sdmWins = sdmAgg1X.wins + sdmAggX2.wins;
      const sdmAcc = sdmBets ? pct(sdmWins, sdmBets, 2) : "—";

      return `
        <div class="league-card" onclick="showLeague('${escapeHtml(l.id)}')">
          <div class="league-name">📌 ${escapeHtml(l.name)}</div>
          <div class="league-sub">${n} match(s) • SDM ${sdmAcc}%</div>
          <div class="league-hint">Clique pour détails marchés + buckets</div>
        </div>
      `;
    }).join("");

  const leaguePanels = Object.values(leaguesOut)
    .filter(l => (l.matches || []).length)
    .map(l => {
      const id = l.id;
      return `
        <div class="league-panel" id="league_${escapeHtml(id)}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
            <div class="panel-title">📌 ${escapeHtml(l.name)} — Résultats par marché</div>
            <button class="btn" onclick="closeLeague()">Fermer</button>
          </div>
          ${renderMarketTable(l.markets)}
          <div class="split">
            <div class="box">
              <div class="box-title">📈 Buckets (Always bet) — par marché</div>
              ${renderPerMarketBuckets(l.markets, l.name)}
            </div>
          </div>
        </div>
      `;
    }).join("");

  const matchesRows = allMatches.map(m => {
    const vec = (() => {
      const [pH, pA] = (m.predTop1 || "0-0").split("-").map(Number);
      const [aH, aA] = (m.actual || "0-0").split("-").map(Number);
      const dh = pH - aH;
      const da = pA - aA;
      return `[${dh >= 0 ? "+" : ""}${dh} | ${da >= 0 ? "+" : ""}${da}]`;
    })();

    const ok = m.sdm.win ? "✅" : "❌";

    return `
      <tr class="row" onclick="toggleMatch('m_${m.fixtureId}')">
        <td>${escapeHtml(m.leagueName)}</td>
        <td><strong>${escapeHtml(m.home)}</strong> vs <strong>${escapeHtml(m.away)}</strong></td>
        <td><span class="pill">${escapeHtml(m.actual)}</span></td>
        <td><span class="pill">${escapeHtml(m.sdm.pick)}</span></td>
        <td>${confBadge(m.sdm.conf)}</td>
        <td><span class="mono">${escapeHtml(vec)}</span></td>
        <td style="font-weight:900">${ok}</td>
      </tr>
      <tr>
        <td colspan="7" style="padding:0;border:none;">
          <div class="detail" id="m_${m.fixtureId}">
            <div class="detail-head">
              <div>
                <div class="detail-title">🏟️ ${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</div>
                <div class="detail-sub">Fixture #${m.fixtureId} • ${escapeHtml(new Date(m.date).toLocaleString())}</div>
              </div>
              <div>
                <span class="pill">Réel ${escapeHtml(m.actual)}</span>
                <span class="pill">Top1 ${escapeHtml(m.predTop1)}</span>
              </div>
            </div>

            <div class="grid">
              <div class="card">
                <div class="card-title">📈 Marchés (Probabilité modèle • Confiance • Cote)</div>
                <div class="market-lines">
                  ${renderMarketLine("1X", m.sdm.pick === "1X" ? m.sdm.p_pick : (1 - m.sdm.p_pick), m.sdm.conf, m.sdm.pick === "1X" ? m.sdm.odd : null)}
                  ${renderMarketLine("X2", m.sdm.pick === "X2" ? m.sdm.p_pick : (1 - m.sdm.p_pick), m.sdm.conf, m.sdm.pick === "X2" ? m.sdm.odd : null)}
                  ${renderMarketLine("Over 2.5", m.markets.ou25.pick === "Over 2.5" ? m.markets.ou25.p_pick : (1 - m.markets.ou25.p_pick), m.markets.ou25.conf, m.markets.ou25.pick === "Over 2.5" ? m.markets.ou25.odd : null)}
                  ${renderMarketLine("Under 2.5", m.markets.ou25.pick === "Under 2.5" ? m.markets.ou25.p_pick : (1 - m.markets.ou25.p_pick), m.markets.ou25.conf, m.markets.ou25.pick === "Under 2.5" ? m.markets.ou25.odd : null)}
                  ${renderMarketLine("Over 3.5", m.markets.ou35.pick === "Over 3.5" ? m.markets.ou35.p_pick : (1 - m.markets.ou35.p_pick), m.markets.ou35.conf, m.markets.ou35.pick === "Over 3.5" ? m.markets.ou35.odd : null)}
                  ${renderMarketLine("Under 3.5", m.markets.ou35.pick === "Under 3.5" ? m.markets.ou35.p_pick : (1 - m.markets.ou35.p_pick), m.markets.ou35.conf, m.markets.ou35.pick === "Under 3.5" ? m.markets.ou35.odd : null)}
                  ${renderMarketLine("BTTS Yes", m.markets.btts.pick === "BTTS Yes" ? m.markets.btts.p_pick : (1 - m.markets.btts.p_pick), m.markets.btts.conf, m.markets.btts.pick === "BTTS Yes" ? m.markets.btts.odd : null)}
                  ${renderMarketLine("BTTS No", m.markets.btts.pick === "BTTS No" ? m.markets.btts.p_pick : (1 - m.markets.btts.p_pick), m.markets.btts.conf, m.markets.btts.pick === "BTTS No" ? m.markets.btts.odd : null)}
                  ${renderMarketLine("Away TT Over 0.5", m.markets.awaytt.pick === "Away TT Over 0.5" ? m.markets.awaytt.p_pick : (1 - m.markets.awaytt.p_pick), m.markets.awaytt.conf, m.markets.awaytt.pick === "Away TT Over 0.5" ? m.markets.awaytt.odd : null)}
                  ${renderMarketLine("Away TT Under 0.5", m.markets.awaytt.pick === "Away TT Under 0.5" ? m.markets.awaytt.p_pick : (1 - m.markets.awaytt.p_pick), m.markets.awaytt.conf, m.markets.awaytt.pick === "Away TT Under 0.5" ? m.markets.awaytt.odd : null)}
                </div>
              </div>

              <div class="card">
                <div class="card-title">🎯 Bets (Always bet) — Pick, Conf, Odd, Win</div>
                <table class="tbl mini">
                  <thead>
                    <tr><th>Marché</th><th>Pick</th><th>Conf</th><th>Odd</th><th>OK</th></tr>
                  </thead>
                  <tbody>
                    ${renderBetRow("SDM", m.sdm.pick, m.sdm.conf, m.sdm.odd, m.sdm.win)}
                    ${renderBetRow("OU 2.5", m.markets.ou25.pick, m.markets.ou25.conf, m.markets.ou25.odd, m.markets.ou25.win)}
                    ${renderBetRow("OU 3.5", m.markets.ou35.pick, m.markets.ou35.conf, m.markets.ou35.odd, m.markets.ou35.win)}
                    ${renderBetRow("BTTS", m.markets.btts.pick, m.markets.btts.conf, m.markets.btts.odd, m.markets.btts.win)}
                    ${renderBetRow("Away TT 0.5", m.markets.awaytt.pick, m.markets.awaytt.conf, m.markets.awaytt.odd, m.markets.awaytt.win)}
                  </tbody>
                </table>
              </div>
            </div>

            <div class="card" style="margin-top:12px">
              <div class="card-title">🔬 Métriques Techniques</div>
              <div class="metrics">
                <div><span class="k">λ Home</span> <span class="v">${fmt2(m.debug?.lh)}</span></div>
                <div><span class="k">λ Away</span> <span class="v">${fmt2(m.debug?.la)}</span></div>
                <div><span class="k">Rho</span> <span class="v">${escapeHtml(m.debug?.rho ?? "—")}</span></div>
                <div><span class="k">HFA</span> <span class="v">${fmt2(m.debug?.hfa)}</span></div>
                <div><span class="k">Matrix Σ</span> <span class="v">${fmt2(m.debug?.matrix_sum_raw)}</span></div>
                <div><span class="k">Min cell</span> <span class="v">${fmt2(m.debug?.matrix_min_raw)}</span></div>
              </div>
            </div>

          </div>
        </td>
      </tr>
    `;
  }).join("");

  function fmt2(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n.toFixed(2) : "—";
  }

  // helper used inside template (string)
  function renderMarketLine(label, prob, conf, odd) {
    const pTxt = `${(clamp(prob,0,1)*100).toFixed(1)}%`;
    const cTxt = `${clamp(conf,0,100).toFixed(0)}%`;
    const oddTxt = odd ? odd.toFixed(2) : "—";
    const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:${confColor(conf)};margin-right:8px"></span>`;
    return `
      <div class="ml">
        <div class="ml-left">${dot}<span class="ml-name">${escapeHtml(label)}</span></div>
        <div class="ml-right"><span class="ml-val">${pTxt}</span> • <span class="ml-val">${cTxt}</span> • <span class="ml-odd">odd ${oddTxt}</span></div>
      </div>
    `;
  }
  function renderBetRow(name, pick, conf, odd, win) {
    const oddTxt = odd ? odd.toFixed(2) : "—";
    const ok = win ? "✅" : "❌";
    return `
      <tr>
        <td>${escapeHtml(name)}</td>
        <td style="font-weight:800">${escapeHtml(pick)}</td>
        <td>${confBadge(conf)}</td>
        <td>${escapeHtml(oddTxt)}</td>
        <td style="font-weight:900">${ok}</td>
      </tr>
    `;
  }

  const globalMarketTable = renderMarketTable(global.markets);

  const globalBuckets = `
    <div class="box">
      <div class="box-title">📈 Buckets (Always bet) — Global par marché</div>
      ${renderPerMarketBuckets(global.markets, "GLOBAL")}
    </div>
  `;

  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SDM ULTRA — 7 derniers jours • Odds • ROI</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#0f172a;color:#fff;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px}
    .wrap{max-width:1700px;margin:0 auto}
    h1{margin:0 0 14px 0;color:#38bdf8;font-size:24px}
    .sub{color:#94a3b8;margin-bottom:18px}
    .gridTop{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin:14px 0 20px}
    .kpi{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:14px;position:relative;overflow:hidden}
    .kpi:after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;background:#38bdf8;opacity:.5}
    .kpi .t{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
    .kpi .v{font-size:26px;font-weight:900;margin-top:6px}
    .kpi .s{color:#94a3b8;margin-top:4px;font-size:13px}
    .box{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:16px;margin:14px 0}
    .box-title{font-weight:900;color:#38bdf8;margin-bottom:10px}
    .tbl{width:100%;border-collapse:collapse;background:#0b1224;border-radius:12px;overflow:hidden}
    .tbl th{background:#111c35;color:#94a3b8;text-transform:uppercase;font-size:12px;letter-spacing:.08em;text-align:left;padding:12px;border-bottom:1px solid #1f2a44}
    .tbl td{padding:12px;border-bottom:1px solid #1f2a44}
    .tbl tr:hover{background:#0f1a33}
    .tbl.mini th,.tbl.mini td{padding:10px;font-size:13px}
    .pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#111c35;border:1px solid #1f2a44;font-weight:800}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .leagueGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin:12px 0}
    .league-card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:14px;cursor:pointer;transition:transform .12s}
    .league-card:hover{transform:translateY(-2px)}
    .league-name{font-weight:900;color:#38bdf8}
    .league-sub{color:#94a3b8;margin-top:4px}
    .league-hint{color:#94a3b8;margin-top:8px;font-size:12px}
    .league-panel{display:none}
    .league-panel.active{display:block}
    .btn{background:#38bdf8;color:#000;border:none;border-radius:10px;padding:10px 14px;font-weight:900;cursor:pointer}
    .btn:hover{background:#0ea5e9}
    .row{cursor:pointer}
    .detail{display:none;padding:14px;background:#0b1224;border-top:1px solid #1f2a44}
    .detail.active{display:block}
    .detail-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px}
    .detail-title{font-weight:900;color:#38bdf8;font-size:16px}
    .detail-sub{color:#94a3b8;font-size:12px;margin-top:4px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
    .card{background:#111c35;border:1px solid #1f2a44;border-radius:14px;padding:14px}
    .card-title{font-weight:900;color:#38bdf8;margin-bottom:10px}
    .market-lines{display:flex;flex-direction:column;gap:8px}
    .ml{display:flex;justify-content:space-between;gap:12px;align-items:center}
    .ml-left{display:flex;align-items:center;gap:6px}
    .ml-name{font-weight:800}
    .ml-right{color:#cbd5e1}
    .ml-val{font-weight:900}
    .ml-odd{color:#94a3b8;font-weight:800}
    .metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
    .metrics .k{color:#94a3b8;margin-right:8px}
    .metrics .v{font-weight:900;color:#e2e8f0}
    details.details{background:#0b1224;border:1px solid #1f2a44;border-radius:12px;padding:10px;margin-top:10px}
    summary{cursor:pointer}
    .sum-title{font-weight:900;color:#e2e8f0}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>📅 SDM ULTRA — 7 derniers jours • Cotes pre-match • ROI (1u)</h1>
    <div class="sub">
      Always bet • Par ligue • Tranches de confiance • Cache odds: <span class="mono">${escapeHtml(PATHS.cache_odds)}</span>
    </div>

    <div class="gridTop">
      <div class="kpi">
        <div class="t">Matchs analysés (7d)</div>
        <div class="v">${global.total}</div>
        <div class="s">Warm-up historique via tracker</div>
      </div>
      <div class="kpi">
        <div class="t">SDM Accuracy</div>
        <div class="v">${pct(global.sdmWins, global.total, 2)}%</div>
        <div class="s">${global.sdmWins}/${global.total}</div>
      </div>
      <div class="kpi">
        <div class="t">Score exact (Top 1)</div>
        <div class="v">${pct(global.scoreExact, global.total, 2)}%</div>
        <div class="s">${global.scoreExact}/${global.total}</div>
      </div>
      <div class="kpi">
        <div class="t">Score exact (Top 3)</div>
        <div class="v">${pct(global.scoreTop3, global.total, 2)}%</div>
        <div class="s">${global.scoreTop3}/${global.total}</div>
      </div>
    </div>

    <div class="box">
      <div class="box-title">📈 Résultats par Marché (Accuracy + ROI)</div>
      ${globalMarketTable}
    </div>

    ${globalBuckets}

    <div class="box">
      <div class="box-title">🏆 Bilan par ligue</div>
      <div class="leagueGrid">
        ${leagueCards || `<div style="color:#94a3b8">Aucune ligue avec matchs sur 7 jours</div>`}
      </div>

      <div style="color:#94a3b8;font-size:12px;margin-top:8px">
        Clique sur une ligue pour afficher le détail des marchés et ROI.
      </div>

      ${leaguePanels}
    </div>

    <div class="box">
      <div class="box-title">🧾 Matchs (7 jours) — Détails + Odds</div>
      <table class="tbl">
        <thead>
          <tr>
            <th>Ligue</th>
            <th>Match</th>
            <th>Score</th>
            <th>SDM</th>
            <th>Confiance</th>
            <th>Vecteur</th>
            <th>OK</th>
          </tr>
        </thead>
        <tbody>
          ${matchesRows || `<tr><td colspan="7" style="color:#94a3b8">Aucun match</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    function closeLeague(){
      document.querySelectorAll('.league-panel').forEach(x => x.classList.remove('active'));
    }
    function showLeague(id){
      closeLeague();
      const el = document.getElementById('league_'+id);
      if(el) el.classList.add('active');
      window.scrollTo({top: el ? el.offsetTop - 10 : 0, behavior: 'smooth'});
    }
    function toggleMatch(id){
      const el = document.getElementById(id);
      if(!el) return;
      el.classList.toggle('active');
    }
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });

  server.listen(PORT, () => {
    console.log(`\n🌍 Dashboard : http://localhost:${PORT}\n`);
  });
}

// ---------------------------
// RUN
// ---------------------------
runBacktest().catch((e) => {
  console.error("❌ Crash:", e);
  process.exit(1);
});
