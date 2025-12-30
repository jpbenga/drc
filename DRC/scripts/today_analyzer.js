/**
 * today_analyzer.js (v2)
 * --------------------------------------------------------------------------------------
 * ✅ Matchs du jour (buffer hier→demain) + timezone Europe/Paris
 * ✅ Design “backtest-like” + détails par match
 * ✅ Pronostics SDM + Top scores + sous-marchés
 * ✅ AJOUT: COTES pre-match via /odds (cache ./data/cache_odds/fixture_<id>.json)
 * ✅ AJOUT: Rappel taux historique par marché (accuracy + n) calculé depuis history_<league>.json
 *
 * Marchés odds gérés (mapping API-Football):
 * - 1X  => "Double Chance" value "Home/Draw"
 * - X2  => "Double Chance" value "Draw/Away"
 * - Over/Under 2.5 & 3.5 => "Goals Over/Under" values "Over 2.5", "Under 2.5", etc.
 * - BTTS Yes/No => "Both Teams Score" values "Yes"/"No"
 * - Away TT Over 0.5 => "Total - Away" value "Over 0.5"
 *
 * IMPORTANT:
 * - L’API /fixtures from/to exige league+season (sinon erreurs)
 * - Les cotes: on utilise le 1er bookmaker de la réponse par défaut
 *   (ou BOOKMAKER_PREFERRED_ID si défini).
 *
 * Lancer:
 *   export APISPORTS_KEY="xxxx"
 *   node scripts/today_analyzer.js
 * Dashboard:
 *   http://localhost:3000
 * --------------------------------------------------------------------------------------
 */

const fs = require("fs");
const http = require("http");
const axios = require("axios");
const path = require("path");

// ===============================
// CONFIG
// ===============================
const PORT = 3000;
const TZ = "Europe/Paris";

// Ligues core
const LEAGUES = ["39", "61", "78", "140", "135", "94", "88", "197", "203"];

// ⚠️ /fixtures from/to => nécessite league + season + from + to + timezone
const DEFAULT_SEASON = 2025;

// Buffer date (hier→demain)
const BUFFER_DAYS_BEFORE = 1;
const BUFFER_DAYS_AFTER = 1;

// Odds cache
const ODDS_CACHE_DIR = "./data/cache_odds";
const DEBUG_DIR = "./data/debug";
const DEBUG_FIXTURES_RAW = "./data/debug/fixtures_raw.json";
const DEBUG_ODDS_RAW = "./data/debug/odds_raw.json";

// Bookmaker selection:
// - si défini (ex: "1" pour 10Bet), on tente ce bookmaker
// - sinon on prend le 1er bookmaker renvoyé
const BOOKMAKER_PREFERRED_ID = process.env.BOOKMAKER_ID ? String(process.env.BOOKMAKER_ID) : null;

// Paths projet
const PATHS = {
  elo: "./data/elo/elo_history_archive.json",
  history: (lid) => `./data/history/history_${lid}.json`,
  meta: (lid) => `./data/meta/league_${lid}_meta.json`,
  params: "./data/params/optimized_params.json",
};

const API_KEY =
  process.env.APISPORTS_KEY ||
  process.env.API_FOOTBALL_KEY ||
  process.env.X_APISPORTS_KEY ||
  "";

if (!API_KEY) {
  console.log('❌ API KEY manquante. Fais: export APISPORTS_KEY="..."');
  process.exit(1);
}

if (!fs.existsSync(PATHS.elo)) {
  console.log(`❌ Elo archive introuvable: ${PATHS.elo}`);
  process.exit(1);
}

if (!fs.existsSync(ODDS_CACHE_DIR)) fs.mkdirSync(ODDS_CACHE_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ===============================
// PARAMS (defaults + load optimized)
// ===============================
let PARAMS = {
  w_xg: 1.071767063590507,
  w_elo: 0.49006079437897576,
  rho: 0.06755116568534326,
  hfa: 63.17135680219842,
  impact_offensive: 0.069775,
  impact_defensive: 0.045351,
  min_matches: 3,
  confidence_shrinkage: 18.60106985887924,
  score_matrix_max: 8,
};

if (fs.existsSync(PATHS.params)) {
  try {
    const optimized = JSON.parse(fs.readFileSync(PATHS.params, "utf8"));
    if (optimized?.best_params) {
      PARAMS = { ...PARAMS, ...optimized.best_params };
      console.log("✅ Paramètres optimisés chargés");
    } else {
      console.log("⚠️ optimized_params.json présent mais best_params manquant → defaults");
    }
  } catch {
    console.log("⚠️ Impossible de lire optimized_params.json → defaults");
  }
}

// ===============================
// LOAD STATIC DATA
// ===============================
const ELO_HISTORY = JSON.parse(fs.readFileSync(PATHS.elo, "utf8"));

// ===============================
// UTILS
// ===============================
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function fmt2(x) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—";
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fact(n) {
  return n <= 1 ? 1 : n * fact(n - 1);
}
function clubEloWinProb(deltaElo) {
  return 1 / (Math.pow(10, -deltaElo / 400) + 1);
}
function poissonPMF(k, lambda) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact(k);
}
function dixonColesAdj(i, j, lh, la, rho) {
  if (!rho) return 1.0;
  if (i === 0 && j === 0) return 1 - (lh * la * rho);
  if (i === 0 && j === 1) return 1 + (lh * rho);
  if (i === 1 && j === 0) return 1 + (la * rho);
  if (i === 1 && j === 1) return 1 - rho;
  return 1.0;
}
function bayesianShrinkage(teamStats, leagueAvg, confidence) {
  const n = teamStats.length;
  if (!n) return leagueAvg;
  const mean = teamStats.reduce((a, b) => a + b, 0) / n;
  return (confidence * leagueAvg + n * mean) / (confidence + n);
}

function calculateErrorVector(pred, actual) {
  const [pH, pA] = String(pred || "0-0").split("-").map(Number);
  const [aH, aA] = String(actual || "0-0").split("-").map(Number);
  return {
    home: pH - aH,
    away: pA - aA,
    manhattan: Math.abs(pH - aH) + Math.abs(pA - aA),
  };
}

// Paris date helpers
function isoDateInTZ(d, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}
function toParisDateStr(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString("fr-FR", { timeZone: TZ });
}

function pickElo(lid, roundName, teamName) {
  const v = ELO_HISTORY?.[String(lid)]?.[String(roundName)]?.[String(teamName)];
  return typeof v === "number" ? v : 1500;
}

// ===============================
// META/HISTORY
// ===============================
function loadMetaForLeague(lid) {
  const p = PATHS.meta(lid);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function loadHistoryForLeague(lid) {
  const p = PATHS.history(lid);
  if (!fs.existsSync(p)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ===============================
// IMPACT PLAYERS (context-based)
// ===============================
function detectImpactAbsences(fixture, meta, side) {
  const injuries =
    side === "home" ? fixture?.context?.injuries_home : fixture?.context?.injuries_away;
  const ratings =
    side === "home" ? fixture?.context?.player_ratings_home : fixture?.context?.player_ratings_away;

  if (!Array.isArray(injuries) || !meta) return { offensive: 0, defensive: 0, absences: [] };

  const topScorers = meta?.top_scorers || [];
  const topAssists = meta?.top_assists || [];

  const absences = [];
  let offensiveImpact = 0;
  let defensiveImpact = 0;

  const findName = (pid) => {
    const fromInjury = injuries.find((x) => x.player_id === pid);
    if (fromInjury?.player_name) return fromInjury.player_name;
    const fromRatings = Array.isArray(ratings) ? ratings.find((p) => p.id === pid) : null;
    if (fromRatings?.name) return fromRatings.name;
    const s = topScorers.find((p) => p.id === pid);
    if (s?.name) return s.name;
    const a = topAssists.find((p) => p.id === pid);
    if (a?.name) return a.name;
    return `#${pid}`;
  };

  for (const inj of injuries) {
    if (inj?.type !== "Missing Fixture") continue;
    const pid = inj.player_id;
    if (!pid) continue;

    const tags = [];
    let off = 0;
    let def = 0;

    if (topScorers.some((p) => p.id === pid)) {
      tags.push("Top Scorer");
      off += 1.0;
      offensiveImpact += 1.0;
    }
    if (topAssists.some((p) => p.id === pid)) {
      tags.push("Top Assist");
      off += 0.5;
      offensiveImpact += 0.5;
    }

    const player = Array.isArray(ratings) ? ratings.find((p) => p.id === pid) : null;
    const position = player?.position || inj.position || "—";
    const rating = player?.rating != null ? Number(player.rating) : null;

    if (player && (position === "Defender" || position === "Goalkeeper")) {
      if (rating != null && rating > 7.0) {
        tags.push("Key Defender/GK");
        def += 1.0;
        defensiveImpact += 1.0;
      }
    }

    absences.push({
      id: pid,
      name: findName(pid),
      position,
      rating,
      reason: inj.reason || inj.detail || "Missing Fixture",
      tags,
      impact_off: off,
      impact_def: def,
    });
  }

  return { offensive: offensiveImpact, defensive: defensiveImpact, absences };
}

// ===============================
// TRACKER from history
// ===============================
function buildTrackerFromHistory(history) {
  const tracker = {};
  const sorted = [...history].sort(
    (a, b) => new Date(a?.fixture?.date) - new Date(b?.fixture?.date)
  );

  for (const m of sorted) {
    const status = m?.fixture?.status?.short;
    if (status !== "FT" && status !== "AET" && status !== "PEN") continue;

    const hID = m?.teams?.home?.id;
    const aID = m?.teams?.away?.id;
    if (!hID || !aID) continue;

    if (!tracker[hID]) tracker[hID] = { xg: [], ga: [] };
    if (!tracker[aID]) tracker[aID] = { xg: [], ga: [] };

    const goalsH = m?.goals?.home;
    const goalsA = m?.goals?.away;
    if (goalsH == null || goalsA == null) continue;

    const xgHraw = m?.stats?.home?.expected_goals;
    const xgAraw = m?.stats?.away?.expected_goals;

    const xgH = xgHraw != null ? Number(xgHraw) : null;
    const xgA = xgAraw != null ? Number(xgAraw) : null;

    if (Number.isFinite(xgH) && Number.isFinite(xgA)) {
      tracker[hID].xg.push(xgH);
      tracker[hID].ga.push(goalsA);
      tracker[aID].xg.push(xgA);
      tracker[aID].ga.push(goalsH);
    }
  }
  return tracker;
}

// ===============================
// MODEL (Poisson matrix + submarkets)
// ===============================
function calculatePoissonPro(hID, aID, hName, aName, lid, roundName, tracker, fixture, meta) {
  const minMatches = PARAMS.min_matches;
  if (!tracker[hID] || !tracker[aID]) return null;
  if (tracker[hID].xg.length < minMatches || tracker[aID].xg.length < minMatches) return null;

  const allXG = [...tracker[hID].xg, ...tracker[aID].xg];
  const leagueAvg = allXG.length ? allXG.reduce((s, v) => s + v, 0) / allXG.length : 1.5;

  const attH = bayesianShrinkage(tracker[hID].xg, leagueAvg, PARAMS.confidence_shrinkage);
  const defA = bayesianShrinkage(tracker[aID].ga, leagueAvg, PARAMS.confidence_shrinkage);
  const attA = bayesianShrinkage(tracker[aID].xg, leagueAvg, PARAMS.confidence_shrinkage);
  const defH = bayesianShrinkage(tracker[hID].ga, leagueAvg, PARAMS.confidence_shrinkage);

  const hElo = pickElo(lid, roundName, hName);
  const aElo = pickElo(lid, roundName, aName);

  const pWinH = clubEloWinProb((hElo - aElo) + PARAMS.hfa);
  const pWinA = 1 - pWinH;

  let lh = (attH * 0.6 + defA * 0.4) * PARAMS.w_xg * Math.pow((pWinH / 0.5), PARAMS.w_elo);
  let la = (attA * 0.6 + defH * 0.4) * PARAMS.w_xg * Math.pow((pWinA / 0.5), PARAMS.w_elo);

  const lh_base = lh;
  const la_base = la;

  const impactDebug = { home: null, away: null };
  if (fixture?.context && meta) {
    const impactH = detectImpactAbsences(fixture, meta, "home");
    const impactA = detectImpactAbsences(fixture, meta, "away");
    impactDebug.home = impactH;
    impactDebug.away = impactA;

    if (impactH.offensive > 0) lh *= (1 - PARAMS.impact_offensive * impactH.offensive);
    if (impactA.defensive > 0) lh *= (1 + PARAMS.impact_defensive * impactA.defensive);
    if (impactA.offensive > 0) la *= (1 - PARAMS.impact_offensive * impactA.offensive);
    if (impactH.defensive > 0) la *= (1 + PARAMS.impact_defensive * impactH.defensive);
  }

  lh = Math.max(lh, 0.01);
  la = Math.max(la, 0.01);

  const maxG = PARAMS.score_matrix_max || 8;

  let pH = 0, pD = 0, pA = 0;

  let m_btts = 0;
  let m_over25 = 0, m_under25 = 0;
  let m_over35 = 0, m_under35 = 0;
  let m_awayOver05 = 0;

  const scoreProbs = [];
  let sumP = 0;
  let minP = 1;

  for (let i = 0; i <= maxG; i++) {
    for (let j = 0; j <= maxG; j++) {
      const corr = dixonColesAdj(i, j, lh, la, PARAMS.rho);
      const p = poissonPMF(i, lh) * poissonPMF(j, la) * corr;

      sumP += p;
      if (p < minP) minP = p;

      scoreProbs.push({ score: `${i}-${j}`, prob: p });

      if (i > j) pH += p;
      else if (i === j) pD += p;
      else pA += p;

      const tot = i + j;

      if (i > 0 && j > 0) m_btts += p;
      if (tot > 2) m_over25 += p;
      if (tot < 3) m_under25 += p;
      if (tot > 3) m_over35 += p;
      if (tot < 4) m_under35 += p;

      if (j > 0) m_awayOver05 += p;
    }
  }

  const top3 = scoreProbs.sort((a, b) => b.prob - a.prob).slice(0, 3);

  const sdmPick = (pH >= pA) ? "1X" : "X2";
  const sdmProb = (sdmPick === "1X") ? (pH + pD) : (pA + pD);
  const sdmConf = clamp(sdmProb * 100, 0, 100);

  return {
    H: pH, D: pD, A: pA,
    sdmPick,
    sdmProb,
    sdmConf,
    top3,
    pred: top3[0]?.score || "0-0",
    m: {
      btts_yes: m_btts,
      btts_no: 1 - m_btts,
      over25: m_over25,
      under25: m_under25,
      over35: m_over35,
      under35: m_under35,
      awayOver05: m_awayOver05,
    },
    debug: {
      lh_base, la_base, lh, la,
      rho: PARAMS.rho, hfa: PARAMS.hfa,
      hElo, aElo,
      matrix_sum_raw: sumP,
      matrix_min_raw: minP,
      impact: impactDebug,
    }
  };
}

// ===============================
// FETCH FIXTURES (buffer range) per league
// ===============================
async function fetchFixturesRangeByLeague({ league, season, from, to, timezone }) {
  const url = "https://v3.football.api-sports.io/fixtures";
  const res = await axios.get(url, {
    headers: { "x-apisports-key": API_KEY },
    params: { league, season, from, to, timezone },
    timeout: 30_000,
  });
  return res.data;
}
function extractFixtures(apiData) {
  const resp = apiData?.response;
  if (!Array.isArray(resp)) return [];
  return resp;
}
function isInTargetLeagues(fx) {
  const lid = String(fx?.league?.id ?? "");
  return LEAGUES.includes(lid);
}
function parisDayKeyForFixture(fx) {
  const date = fx?.fixture?.date;
  if (!date) return null;
  return isoDateInTZ(new Date(date), TZ);
}

// ===============================
// ODDS (pre-match) + cache
// ===============================
async function fetchOddsForFixture(fixtureId) {
  const cachePath = path.join(ODDS_CACHE_DIR, `fixture_${fixtureId}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf8"));
    } catch {
      // continue fetch
    }
  }

  const url = "https://v3.football.api-sports.io/odds";
  // /odds pre-match: fixture=ID
  const res = await axios.get(url, {
    headers: { "x-apisports-key": API_KEY },
    params: { fixture: fixtureId },
    timeout: 30_000,
  });

  try {
    fs.writeFileSync(cachePath, JSON.stringify(res.data, null, 2));
  } catch {}

  return res.data;
}

function pickBookmaker(oddsApiData) {
  const resp = oddsApiData?.response;
  if (!Array.isArray(resp) || !resp.length) return null;

  // API-Football odds response shape can be:
  // response[0].bookmakers = [...]
  const bookmakers = resp[0]?.bookmakers;
  if (!Array.isArray(bookmakers) || !bookmakers.length) return null;

  if (BOOKMAKER_PREFERRED_ID) {
    const found = bookmakers.find((b) => String(b.id) === String(BOOKMAKER_PREFERRED_ID));
    if (found) return found;
  }
  return bookmakers[0];
}

function getOddFromBookmaker(bookmaker, betName, valueName) {
  if (!bookmaker?.bets || !Array.isArray(bookmaker.bets)) return null;
  const bet = bookmaker.bets.find((b) => String(b.name).toLowerCase() === String(betName).toLowerCase());
  if (!bet?.values || !Array.isArray(bet.values)) return null;

  const v = bet.values.find((x) => String(x.value).toLowerCase() === String(valueName).toLowerCase());
  if (!v?.odd) return null;

  const odd = Number(v.odd);
  return Number.isFinite(odd) ? odd : null;
}

function buildOddsSnapshot(oddsApiData) {
  // Return odds for the markets we display, from selected bookmaker.
  const bm = pickBookmaker(oddsApiData);
  if (!bm) return { bookmaker: null, odds: {} };

  const odds = {
    // Double chance
    "1X": getOddFromBookmaker(bm, "Double Chance", "Home/Draw"),
    "X2": getOddFromBookmaker(bm, "Double Chance", "Draw/Away"),
    // O/U totals
    "Over 2.5": getOddFromBookmaker(bm, "Goals Over/Under", "Over 2.5"),
    "Under 2.5": getOddFromBookmaker(bm, "Goals Over/Under", "Under 2.5"),
    "Over 3.5": getOddFromBookmaker(bm, "Goals Over/Under", "Over 3.5"),
    "Under 3.5": getOddFromBookmaker(bm, "Goals Over/Under", "Under 3.5"),
    // BTTS
    "BTTS Yes": getOddFromBookmaker(bm, "Both Teams Score", "Yes"),
    "BTTS No": getOddFromBookmaker(bm, "Both Teams Score", "No"),
    // Away team total
    "Away TT Over 0.5": getOddFromBookmaker(bm, "Total - Away", "Over 0.5"),
  };

  return { bookmaker: { id: bm.id, name: bm.name }, odds };
}

// ===============================
// HISTORICAL MARKET ACCURACY (always-bet @ p>=0.5)
// ===============================
function initHistAgg() {
  const mk = [
    "1X", "X2",
    "Over 2.5", "Under 2.5",
    "Over 3.5", "Under 3.5",
    "BTTS Yes", "BTTS No",
    "Away TT Over 0.5",
  ];
  const agg = {};
  for (const k of mk) agg[k] = { win: 0, n: 0 };
  return agg;
}

function addHist(agg, market, isWin) {
  if (!agg[market]) return;
  agg[market].n += 1;
  if (isWin) agg[market].win += 1;
}

function histRate(agg, market) {
  const a = agg[market];
  if (!a || !a.n) return { rate: null, n: 0 };
  return { rate: (a.win / a.n) * 100, n: a.n };
}

function computeHistoricalMarketAccuracy(leagueData) {
  // leagueData[lid] = { history, meta, tracker }
  // We'll simulate “always bet” AFTER warm-up is possible (min_matches on both teams),
  // using the already-built tracker from full history.
  //
  // Note: tracker already contains xg/ga arrays built from full history.
  // For a strict walk-forward you’d update incrementally per match; here we do a pragmatic
  // “historical rate” heuristic (fast + stable) for decision support.
  const globalAgg = initHistAgg();
  const leagueAgg = {}; // lid -> agg

  for (const lid of LEAGUES) {
    leagueAgg[lid] = initHistAgg();
    const history = leagueData[lid]?.history || [];
    const meta = leagueData[lid]?.meta || null;

    // Build incremental tracker for walk-forward style here:
    const trackerInc = {};
    const sorted = [...history].sort((a, b) => new Date(a?.fixture?.date) - new Date(b?.fixture?.date));

    for (const m of sorted) {
      const status = m?.fixture?.status?.short;
      if (status !== "FT" && status !== "AET" && status !== "PEN") continue;

      const hID = m?.teams?.home?.id;
      const aID = m?.teams?.away?.id;
      const hName = m?.teams?.home?.name;
      const aName = m?.teams?.away?.name;
      const roundName = m?.league?.round || "N/A";
      if (!hID || !aID || !hName || !aName) continue;

      if (!trackerInc[hID]) trackerInc[hID] = { xg: [], ga: [] };
      if (!trackerInc[aID]) trackerInc[aID] = { xg: [], ga: [] };

      // Predict BEFORE updating with this match (walk-forward)
      const res = calculatePoissonPro(hID, aID, hName, aName, String(lid), roundName, trackerInc, m, meta);
      const gH = m?.goals?.home;
      const gA = m?.goals?.away;
      if (res && gH != null && gA != null) {
        const tot = gH + gA;
        const btts = gH > 0 && gA > 0;

        // SDM markets “1X/X2” always-bet: pick by model sdmPick
        const sdmPick = res.sdmPick;
        const sdmWin = (sdmPick === "1X") ? (gH >= gA) : (gA >= gH);
        addHist(globalAgg, sdmPick, sdmWin);
        addHist(leagueAgg[lid], sdmPick, sdmWin);

        // Over/Under 2.5 always-bet: pick by p>=0.5
        const pickOU25 = (res.m.over25 >= 0.5) ? "Over 2.5" : "Under 2.5";
        const winOU25 = (pickOU25 === "Over 2.5") ? (tot > 2) : (tot < 3);
        addHist(globalAgg, pickOU25, winOU25);
        addHist(leagueAgg[lid], pickOU25, winOU25);

        // Over/Under 3.5
        const pickOU35 = (res.m.over35 >= 0.5) ? "Over 3.5" : "Under 3.5";
        const winOU35 = (pickOU35 === "Over 3.5") ? (tot > 3) : (tot < 4);
        addHist(globalAgg, pickOU35, winOU35);
        addHist(leagueAgg[lid], pickOU35, winOU35);

        // BTTS
        const pickBTTS = (res.m.btts_yes >= 0.5) ? "BTTS Yes" : "BTTS No";
        const winBTTS = (pickBTTS === "BTTS Yes") ? btts : !btts;
        addHist(globalAgg, pickBTTS, winBTTS);
        addHist(leagueAgg[lid], pickBTTS, winBTTS);

        // Away TT Over 0.5
        const pickAway05 = (res.m.awayOver05 >= 0.5) ? "Away TT Over 0.5" : null;
        if (pickAway05) {
          const winAway05 = gA > 0;
          addHist(globalAgg, pickAway05, winAway05);
          addHist(leagueAgg[lid], pickAway05, winAway05);
        }
      }

      // Update tracker with this match (after prediction)
      const xgHraw = m?.stats?.home?.expected_goals;
      const xgAraw = m?.stats?.away?.expected_goals;
      const xgH = xgHraw != null ? Number(xgHraw) : null;
      const xgA = xgAraw != null ? Number(xgAraw) : null;

      if (Number.isFinite(xgH) && Number.isFinite(xgA) && gH != null && gA != null) {
        trackerInc[hID].xg.push(xgH);
        trackerInc[hID].ga.push(gA);
        trackerInc[aID].xg.push(xgA);
        trackerInc[aID].ga.push(gH);
      }
    }
  }

  return { globalAgg, leagueAgg };
}

// ===============================
// MAIN — Today Analyzer
// ===============================
async function runTodayAnalyzer() {
  console.log("\n" + "=".repeat(90));
  console.log("📅 SDM ULTRA — MATCHS DU JOUR (buffer hier→demain + timezone Europe/Paris + ODDS + HIST)");
  console.log("=".repeat(90));
  console.log(`📊 Params: w_xg=${PARAMS.w_xg} w_elo=${PARAMS.w_elo} rho=${PARAMS.rho} hfa=${PARAMS.hfa}`);
  console.log(`📌 min_matches=${PARAMS.min_matches} • shrinkage=${PARAMS.confidence_shrinkage}`);
  console.log(`🕒 Timezone: ${TZ}`);
  console.log(`🎯 Leagues filter: ${LEAGUES.join(", ")}`);
  console.log(`🎲 Bookmaker preferred: ${BOOKMAKER_PREFERRED_ID || "first bookmaker"}`);
  console.log("=".repeat(90) + "\n");

  const now = new Date();
  const todayParis = isoDateInTZ(now, TZ);
  const from = isoDateInTZ(new Date(now.getTime() - BUFFER_DAYS_BEFORE * 24 * 3600 * 1000), TZ);
  const to = isoDateInTZ(new Date(now.getTime() + BUFFER_DAYS_AFTER * 24 * 3600 * 1000), TZ);

  // Prepare league data (history/meta/tracker)
  const leagueData = {};
  for (const lid of LEAGUES) {
    const history = loadHistoryForLeague(lid);
    const meta = loadMetaForLeague(lid);
    const tracker = buildTrackerFromHistory(history);
    leagueData[lid] = { history, meta, tracker };
  }

  // Compute historical rates (global + per-league)
  const { globalAgg, leagueAgg } = computeHistoricalMarketAccuracy(leagueData);

  // Fetch fixtures per league (range)
  let allFixtures = [];
  const apiDebug = { range: { from, to, todayParis }, leagues: [], errors: [] };

  for (const lid of LEAGUES) {
    const season = DEFAULT_SEASON;
    try {
      const data = await fetchFixturesRangeByLeague({
        league: lid,
        season,
        from,
        to,
        timezone: TZ,
      });

      apiDebug.leagues.push({
        league: lid,
        season,
        results: data?.results ?? null,
        paging: data?.paging ?? null,
        errors: data?.errors ?? null,
      });

      const fixtures = extractFixtures(data);
      allFixtures.push(...fixtures);
      await delay(150); // petit pacing
    } catch (e) {
      apiDebug.errors.push({ league: lid, error: String(e?.message || e) });
    }
  }

  // Dump debug raw fixtures
  fs.writeFileSync(DEBUG_FIXTURES_RAW, JSON.stringify({ apiDebug, fixtures: allFixtures }, null, 2));

  // Filter to “today” in Paris
  const todays = allFixtures
    .filter(isInTargetLeagues)
    .filter((fx) => parisDayKeyForFixture(fx) === todayParis)
    .sort((a, b) => new Date(a?.fixture?.date) - new Date(b?.fixture?.date));

  // Evaluate each match today
  const matchesOut = [];
  const oddsDebug = { fetched: 0, empty: 0, errors: [] };

  for (const fx of todays) {
    const lid = String(fx?.league?.id ?? "");
    const roundName = fx?.league?.round || "N/A";

    const h = fx?.teams?.home;
    const a = fx?.teams?.away;
    if (!h?.id || !a?.id || !h?.name || !a?.name) continue;

    const tracker = leagueData[lid]?.tracker;
    const meta = leagueData[lid]?.meta;

    const res = calculatePoissonPro(h.id, a.id, h.name, a.name, lid, roundName, tracker, fx, meta);

    const gH = fx?.goals?.home;
    const gA = fx?.goals?.away;
    const hasScore = gH != null && gA != null;
    const actual = hasScore ? `${gH}-${gA}` : "—";
    const status = fx?.fixture?.status?.short || "—";

    let isSdmOk = null;
    let errorVec = null;
    if (hasScore && res) {
      isSdmOk = (res.sdmPick === "1X") ? (gH >= gA) : (gA >= gH);
      errorVec = calculateErrorVector(res.pred, `${gH}-${gA}`);
    } else {
      errorVec = { home: "—", away: "—", manhattan: "—" };
    }

    // Odds pre-match (on essaye, même si match live/FT)
    let oddsSnap = { bookmaker: null, odds: {} };
    try {
      const oddsData = await fetchOddsForFixture(fx?.fixture?.id);
      oddsDebug.fetched += 1;
      if (!oddsData?.response || !oddsData.response.length) oddsDebug.empty += 1;
      oddsSnap = buildOddsSnapshot(oddsData);
    } catch (e) {
      oddsDebug.errors.push({ fixture: fx?.fixture?.id, error: String(e?.message || e) });
    }

    matchesOut.push({
      fixtureId: fx?.fixture?.id,
      date: fx?.fixture?.date,
      dateParis: toParisDateStr(fx?.fixture?.date),
      leagueId: lid,
      leagueName: fx?.league?.name || `#${lid}`,
      round: roundName,
      status,
      home: h.name,
      away: a.name,
      actual,
      res,
      isSdmOk,
      errorVec,
      odds: oddsSnap,
    });

    await delay(120); // pacing odds
  }

  // Dump debug odds
  fs.writeFileSync(DEBUG_ODDS_RAW, JSON.stringify({ oddsDebug }, null, 2));

  // Summary scored accuracy
  const evaluated = matchesOut.filter((m) => !!m.res);
  const withScore = evaluated.filter((m) => m.actual !== "—");
  const sdmW = withScore.filter((m) => m.isSdmOk === true).length;
  const totalScored = withScore.length;

  console.log("\n" + "=".repeat(90));
  console.log("📊 SUMMARY");
  console.log("=".repeat(90));
  console.log(`Today (Paris)          : ${todayParis}`);
  console.log(`Fixtures fetched (raw) : ${allFixtures.length}`);
  console.log(`Matches today (target) : ${matchesOut.length}`);
  console.log(`Model available        : ${evaluated.length}/${matchesOut.length}`);
  console.log(`Scored matches         : ${totalScored}`);
  console.log(`SDM accuracy (scored)  : ${totalScored ? (sdmW / totalScored * 100).toFixed(2) : "—"}% (${sdmW}/${totalScored})`);
  console.log(`Odds debug             : fetched=${oddsDebug.fetched} empty=${oddsDebug.empty} errors=${oddsDebug.errors.length}`);
  console.log("=".repeat(90));

  // UI
  const html = renderDashboard(todayParis, matchesOut, evaluated, totalScored, sdmW, globalAgg, leagueAgg);
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    })
    .listen(PORT, () => console.log(`\n🌍 Dashboard : http://localhost:${PORT}`));
}

// ===============================
// UI HELPERS
// ===============================
function confColor(conf) {
  const c = clamp(conf, 0, 100);
  if (c >= 90) return "#4ade80";
  if (c >= 80) return "#0ea5e9";
  if (c >= 70) return "#fbbf24";
  if (c >= 60) return "#f59e0b";
  return "#94a3b8";
}
function formatConfBadge(conf) {
  const c = clamp(conf, 0, 100);
  const bg = confColor(c);
  const fg = "#000";
  return `<span style="padding:5px 10px; border-radius:6px; background:${bg}; color:${fg}; font-weight:bold">${c.toFixed(0)}%</span>`;
}
function formatHistBadge(rateObj) {
  if (!rateObj || rateObj.rate == null) return `<span class="hist-badge hist-na">Hist —</span>`;
  return `<span class="hist-badge">${rateObj.rate.toFixed(1)}% <span style="opacity:.75">(${rateObj.n})</span></span>`;
}
function vectorClass(m) {
  const d = m?.errorVec?.manhattan;
  if (d === 0) return "vector-perfect";
  if (d === 1) return "vector-close";
  if (typeof d === "number" && d <= 2) return "vector-close";
  return "vector-far";
}
function formatOdd(odd) {
  if (odd == null) return "—";
  if (!Number.isFinite(odd)) return "—";
  return odd.toFixed(2);
}

function renderImpactBlock(res, matchId) {
  const impact = res?.debug?.impact;
  const home = impact?.home;
  const away = impact?.away;

  const lh0 = res?.debug?.lh_base;
  const la0 = res?.debug?.la_base;
  const lh1 = res?.debug?.lh;
  const la1 = res?.debug?.la;

  const dh = (typeof lh0 === "number" && typeof lh1 === "number" && lh0 !== 0) ? ((lh1 - lh0) / lh0 * 100) : 0;
  const da = (typeof la0 === "number" && typeof la1 === "number" && la0 !== 0) ? ((la1 - la0) / la0 * 100) : 0;

  const renderAbs = (abs) => {
    if (!Array.isArray(abs) || !abs.length) return `<div style="color:#94a3b8;">Aucune absence détectée (context manquant ou non enrichi).</div>`;
    return abs.map(p => `
      <div style="padding:10px; border:1px solid #334155; border-radius:8px; margin-bottom:8px; background:#0b1220;">
        <div style="font-weight:bold; color:#e2e8f0;">${escapeHtml(p.name || "—")}</div>
        <div style="color:#94a3b8; font-size:0.85em;">${escapeHtml(p.position || "—")} • Rating ${p.rating ?? "—"} • ${escapeHtml(p.reason || "—")}</div>
        <div style="margin-top:6px; color:#94a3b8; font-size:0.85em;">
          ΔOff ${p.impact_off ?? 0} • ΔDef ${p.impact_def ?? 0}
          ${Array.isArray(p.tags) && p.tags.length ? ` • <span style="color:#38bdf8">${escapeHtml(p.tags.join(", "))}</span>` : ""}
        </div>
      </div>
    `).join("");
  };

  const blockId = `impact_${matchId}`;

  return `
    <div class="detail-section">
      <div class="detail-title">🧑‍⚕️ Impact Players — Absences & Effet sur λ</div>

      <button class="toggle-btn" style="margin-bottom:12px;" onclick="toggleImpact('${blockId}')">
        Afficher / Masquer
      </button>

      <div id="${blockId}" style="display:none;">
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px; margin-bottom:12px;">
          <div style="background:#1e293b; border:1px solid #334155; border-radius:10px; padding:12px;">
            <div style="color:#94a3b8; font-size:0.8em;">λ Home (base → final)</div>
            <div style="font-weight:bold; font-size:1.1em; color:#38bdf8;">${fmt2(lh0)} → ${fmt2(lh1)}</div>
            <div style="color:#94a3b8;">Δ ${dh >= 0 ? "+" : ""}${dh.toFixed(1)}%</div>
          </div>
          <div style="background:#1e293b; border:1px solid #334155; border-radius:10px; padding:12px;">
            <div style="color:#94a3b8; font-size:0.8em;">λ Away (base → final)</div>
            <div style="font-weight:bold; font-size:1.1em; color:#38bdf8;">${fmt2(la0)} → ${fmt2(la1)}</div>
            <div style="color:#94a3b8;">Δ ${da >= 0 ? "+" : ""}${da.toFixed(1)}%</div>
          </div>
          <div style="background:#1e293b; border:1px solid #334155; border-radius:10px; padding:12px;">
            <div style="color:#94a3b8; font-size:0.8em;">Coefficients Impact</div>
            <div style="font-weight:bold; font-size:1.1em; color:#38bdf8;">Off ${PARAMS.impact_offensive.toFixed(3)} • Def ${PARAMS.impact_defensive.toFixed(3)}</div>
            <div style="color:#94a3b8; font-size:0.85em;">(appliqués en multiplicatif sur λ)</div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:16px;">
          <div>
            <div style="font-weight:bold; color:#38bdf8; margin-bottom:6px;">🏠 Domicile</div>
            <div style="color:#94a3b8; margin-bottom:10px;">Off ${home?.offensive ?? 0} • Def ${home?.defensive ?? 0} • Abs ${home?.absences?.length ?? 0}</div>
            ${renderAbs(home?.absences)}
          </div>

          <div>
            <div style="font-weight:bold; color:#38bdf8; margin-bottom:6px;">✈️ Extérieur</div>
            <div style="color:#94a3b8; margin-bottom:10px;">Off ${away?.offensive ?? 0} • Def ${away?.defensive ?? 0} • Abs ${away?.absences?.length ?? 0}</div>
            ${renderAbs(away?.absences)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderDashboard(todayParis, matchesOut, evaluated, totalScored, sdmW, globalAgg, leagueAgg) {
  const cMuted = "#94a3b8";

  // group by league
  const byLeague = {};
  for (const m of matchesOut) {
    const key = `${m.leagueId}__${m.leagueName}`;
    if (!byLeague[key]) byLeague[key] = [];
    byLeague[key].push(m);
  }

  const leagueCards = Object.entries(byLeague).map(([key, ms]) => {
    const scored = ms.filter(x => x.actual !== "—" && x.res);
    const win = scored.filter(x => x.isSdmOk === true).length;
    const total = scored.length;
    const avail = ms.filter(x => x.res).length;

    // show some per-league hist rates (SDM + OU25 + BTTS Yes)
    const lid = ms[0]?.leagueId;
    const h1x = histRate(leagueAgg[lid], "1X");
    const hx2 = histRate(leagueAgg[lid], "X2");
    const hou25 = histRate(leagueAgg[lid], "Under 2.5");
    const hbtts = histRate(leagueAgg[lid], "BTTS Yes");

    return `
      <div class="league-card">
        <div class="league-header">⚽ ${escapeHtml(ms[0]?.leagueName || key)}</div>
        <div class="stat-row"><span class="stat-label">Matchs du jour</span><span class="stat-value">${ms.length}</span></div>
        <div class="stat-row"><span class="stat-label">Modèle dispo</span><span class="stat-value">${avail}/${ms.length}</span></div>
        <div class="stat-row"><span class="stat-label">Scorés</span><span class="stat-value">${total}</span></div>
        <div class="stat-row"><span class="stat-label">SDM (scorés)</span><span class="stat-value">${total ? (win/total*100).toFixed(1) : "—"}%</span></div>
        <div style="margin-top:12px; padding-top:12px; border-top:1px solid #334155;">
          <div style="color:#94a3b8; font-size:0.8em; margin-bottom:6px;">📌 Historique ligue (always-bet)</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <span class="pill">1X ${formatHistBadge(h1x)}</span>
            <span class="pill">X2 ${formatHistBadge(hx2)}</span>
            <span class="pill">U2.5 ${formatHistBadge(hou25)}</span>
            <span class="pill">BTTS Yes ${formatHistBadge(hbtts)}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // global hist badges for detail table header
  const g_1x = formatHistBadge(histRate(globalAgg, "1X"));
  const g_x2 = formatHistBadge(histRate(globalAgg, "X2"));
  const g_o25 = formatHistBadge(histRate(globalAgg, "Over 2.5"));
  const g_u25 = formatHistBadge(histRate(globalAgg, "Under 2.5"));
  const g_o35 = formatHistBadge(histRate(globalAgg, "Over 3.5"));
  const g_u35 = formatHistBadge(histRate(globalAgg, "Under 3.5"));
  const g_by = formatHistBadge(histRate(globalAgg, "BTTS Yes"));
  const g_bn = formatHistBadge(histRate(globalAgg, "BTTS No"));
  const g_a05 = formatHistBadge(histRate(globalAgg, "Away TT Over 0.5"));

  const rows = matchesOut.map((m, idx) => {
    const id = `m_${m.fixtureId || idx}`;
    const res = m.res;

    const sdmPick = res?.sdmPick || "—";
    const sdmConf = res ? formatConfBadge(res.sdmConf) : `<span style="color:${cMuted}">—</span>`;

    const vec = (m.actual !== "—" && res)
      ? `<span class="vector ${vectorClass(m)}">[${m.errorVec.home >= 0 ? "+" : ""}${m.errorVec.home} | ${m.errorVec.away >= 0 ? "+" : ""}${m.errorVec.away}]</span>`
      : `<span class="vector" style="background:#1e293b; color:${cMuted};">[—|—]</span>`;

    const okLabel = (m.actual !== "—" && res)
      ? (m.isSdmOk ? `<span style="color:#4ade80; font-weight:bold;">✅ SDM</span>` : `<span style="color:#ef4444; font-weight:bold;">❌ FAIL</span>`)
      : `<span style="color:${cMuted}; font-weight:bold;">${escapeHtml(m.status)}</span>`;

    const topScoresHtml = (res?.top3 || []).map(s => {
      const cls = s.score === res.pred ? "score-item predicted" : "score-item";
      return `
        <div class="${cls}">
          <div class="score">${escapeHtml(s.score)}</div>
          <div class="prob">${(s.prob * 100).toFixed(2)}%</div>
          ${s.score === res.pred ? `<div style="font-size:0.7em; color:#38bdf8; margin-top:5px;">⭐ PRÉDIT</div>` : ""}
        </div>
      `;
    }).join("");

    const odds = m?.odds?.odds || {};
    const bm = m?.odds?.bookmaker;

    // model probs
    const mk = res?.m || {};
    const p_over25 = res ? (mk.over25*100) : null;
    const p_under25 = res ? (mk.under25*100) : null;
    const p_over35 = res ? (mk.over35*100) : null;
    const p_under35 = res ? (mk.under35*100) : null;
    const p_bttsY = res ? (mk.btts_yes*100) : null;
    const p_bttsN = res ? (mk.btts_no*100) : null;
    const p_away05 = res ? (mk.awayOver05*100) : null;

    const marketsRows = res ? `
      <tr><td>1X <span class="hist-inline">${g_1x}</span></td><td>${res.sdmPick==="1X" ? "✅" : "—"}</td><td>${(res.sdmProb*100).toFixed(1)}%</td><td>${formatConfBadge(res.sdmConf)}</td><td>${formatOdd(odds["1X"])}</td></tr>
      <tr><td>X2 <span class="hist-inline">${g_x2}</span></td><td>${res.sdmPick==="X2" ? "✅" : "—"}</td><td>${((res.D + (res.A||0))*100).toFixed(1)}%</td><td>${formatConfBadge((res.D + (res.A||0))*100)}</td><td>${formatOdd(odds["X2"])}</td></tr>

      <tr><td>Over 2.5 <span class="hist-inline">${g_o25}</span></td><td>—</td><td>${p_over25.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.over25, 1-mk.over25)*100)}</td><td>${formatOdd(odds["Over 2.5"])}</td></tr>
      <tr><td>Under 2.5 <span class="hist-inline">${g_u25}</span></td><td>—</td><td>${p_under25.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.under25, 1-mk.under25)*100)}</td><td>${formatOdd(odds["Under 2.5"])}</td></tr>

      <tr><td>Over 3.5 <span class="hist-inline">${g_o35}</span></td><td>—</td><td>${p_over35.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.over35, 1-mk.over35)*100)}</td><td>${formatOdd(odds["Over 3.5"])}</td></tr>
      <tr><td>Under 3.5 <span class="hist-inline">${g_u35}</span></td><td>—</td><td>${p_under35.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.under35, 1-mk.under35)*100)}</td><td>${formatOdd(odds["Under 3.5"])}</td></tr>

      <tr><td>BTTS Yes <span class="hist-inline">${g_by}</span></td><td>—</td><td>${p_bttsY.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.btts_yes, 1-mk.btts_yes)*100)}</td><td>${formatOdd(odds["BTTS Yes"])}</td></tr>
      <tr><td>BTTS No <span class="hist-inline">${g_bn}</span></td><td>—</td><td>${p_bttsN.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.btts_no, 1-mk.btts_no)*100)}</td><td>${formatOdd(odds["BTTS No"])}</td></tr>

      <tr><td>Away TT Over 0.5 <span class="hist-inline">${g_a05}</span></td><td>—</td><td>${p_away05.toFixed(1)}%</td><td>${formatConfBadge(Math.max(mk.awayOver05, 1-mk.awayOver05)*100)}</td><td>${formatOdd(odds["Away TT Over 0.5"])}</td></tr>
    ` : `<tr><td colspan="5" style="color:${cMuted}; padding:12px;">Modèle indisponible (warm-up insuffisant)</td></tr>`;

    const impactBlock = res ? renderImpactBlock(res, id) : "";

    return `
      <tr class="match-row" onclick="toggleMatchDetails('${id}', event)">
        <td style="font-weight:500">${escapeHtml(m.leagueName)}</td>
        <td>${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</td>
        <td>${escapeHtml(m.dateParis)}</td>
        <td><span class="badge badge-info">${escapeHtml(m.actual)}</span></td>
        <td><span class="badge">${escapeHtml(sdmPick)}</span></td>
        <td>${sdmConf}</td>
        <td>${vec}</td>
        <td>${okLabel}</td>
      </tr>

      <tr>
        <td colspan="8" style="padding: 0; border: none;">
          <div id="${id}" class="match-details">
            <div style="background:#1e293b; padding:20px; border-radius:8px; margin-bottom:20px;">
              <h3 style="color:#38bdf8; margin-bottom:6px;">🏟️ ${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</h3>
              <div style="color:${cMuted}; margin-bottom:12px;">
                Status: <strong>${escapeHtml(m.status)}</strong> • Round: ${escapeHtml(m.round)}
                ${bm?.name ? ` • Bookmaker: <strong>${escapeHtml(bm.name)}</strong>` : ""}
              </div>

              <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px;">
                <div>
                  <div style="color:${cMuted}; font-size:0.8em;">Score Réel</div>
                  <div style="font-size:1.5em; font-weight:bold; color:#4ade80;">${escapeHtml(m.actual)}</div>
                </div>
                <div>
                  <div style="color:${cMuted}; font-size:0.8em;">Score Prédit</div>
                  <div style="font-size:1.5em; font-weight:bold; color:#38bdf8;">${res ? escapeHtml(res.pred) : "—"}</div>
                </div>
                <div>
                  <div style="color:${cMuted}; font-size:0.8em;">SDM</div>
                  <div style="font-size:0.9em; color:${cMuted};">Pick ${escapeHtml(sdmPick)} • Confiance ${res ? clamp(res.sdmConf,0,100).toFixed(0) : "—"}%</div>
                </div>
              </div>
            </div>

            ${impactBlock}

            <div class="detail-section">
              <div class="detail-title">📈 Marchés (Probabilité modèle • Confiance • Cote • Historique)</div>
              <table class="comparison-table">
                <thead>
                  <tr>
                    <th>Marché</th><th>Pick</th><th>Probabilité</th><th>Confiance</th><th>Cote</th>
                  </tr>
                </thead>
                <tbody>
                  ${marketsRows}
                </tbody>
              </table>
              <div style="color:${cMuted}; font-size:0.85em; margin-top:10px;">
                Les badges “Hist” sont calculés sur l’historique (walk-forward: prédire puis update), règle always-bet @ p≥0.5.
              </div>
            </div>

            <div class="detail-section">
              <div class="detail-title">📊 Top Scores (Poisson matrix)</div>
              <div class="top-scores">
                ${res ? topScoresHtml : `<div style="color:${cMuted};">—</div>`}
              </div>
            </div>

            <div class="detail-section">
              <div class="detail-title">🔬 Métriques Techniques</div>
              <div class="metrics-grid">
                <div class="metric-item"><div class="metric-label">λ Domicile</div><div class="metric-value">${res ? fmt2(res.debug.lh) : "—"}</div></div>
                <div class="metric-item"><div class="metric-label">λ Extérieur</div><div class="metric-value">${res ? fmt2(res.debug.la) : "—"}</div></div>
                <div class="metric-item"><div class="metric-label">Rho</div><div class="metric-value">${res ? escapeHtml(String(res.debug.rho)) : "—"}</div></div>
                <div class="metric-item"><div class="metric-label">HFA</div><div class="metric-value">${res ? `+${fmt2(Number(res.debug.hfa))}` : "—"}</div></div>
                <div class="metric-item"><div class="metric-label">Matrix Σ raw</div><div class="metric-value">${res ? fmt2(res.debug.matrix_sum_raw) : "—"}</div></div>
                <div class="metric-item"><div class="metric-label">Matrix min raw</div><div class="metric-value">${res ? fmt2(res.debug.matrix_min_raw) : "—"}</div></div>
              </div>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>SDM Ultra — Today Analyzer</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0f172a; color:white; font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif; padding: 30px; }
    .container { max-width: 1800px; margin:auto; }
    h1 { color:#38bdf8; border-left:5px solid #38bdf8; padding-left:15px; margin-bottom:20px; font-size:2em; }
    h2 { color:#38bdf8; margin: 30px 0 15px 0; font-size:1.3em; }

    .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin: 20px 0 30px 0; }
    .kpi-card { background:#1e293b; padding:20px; border-radius:12px; text-align:center; border: 1px solid #334155; position:relative; }
    .kpi-card .label { font-size:0.75em; color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; }
    .kpi-card .value { font-size:2.2em; font-weight:800; color:#38bdf8; }
    .kpi-card .sub { font-size:0.85em; color:#94a3b8; margin-top:8px; }

    .league-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .league-card { background:#1e293b; padding:20px; border-radius:12px; border:1px solid #334155; }
    .league-header { font-weight:bold; color:#38bdf8; font-size:1.1em; margin-bottom:15px; border-bottom:2px solid #334155; padding-bottom:10px; }
    .stat-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:0.9em; }
    .stat-label { color:#94a3b8; }
    .stat-value { font-weight:bold; color:#4ade80; }
    .pill { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; background:#0b1220; border:1px solid #334155; font-size:0.85em; color:#e2e8f0; }

    table { width:100%; border-collapse: collapse; margin: 20px 0; background:#1e293b; border-radius:12px; overflow:hidden; }
    th { text-align:left; color:#64748b; font-size:0.8em; text-transform:uppercase; padding:15px; border-bottom:2px solid #0f172a; background:#1e293b; }
    td { padding:12px 15px; border-bottom:1px solid #334155; font-size:0.9em; vertical-align:middle; }
    tr:hover { background:#334155; cursor:pointer; }
    tr.match-row.expanded { background:#334155; }

    .match-details { display:none; background:#0f172a; padding:25px; border-radius:8px; margin:15px 0; }
    .match-details.active { display:block; animation: slideDown 0.2s ease-out; }
    @keyframes slideDown { from { opacity:0; transform: translateY(-10px);} to { opacity:1; transform: translateY(0);} }

    .detail-section { margin: 20px 0; }
    .detail-title { color:#38bdf8; font-weight:bold; font-size:1.05em; margin-bottom:12px; border-bottom:2px solid #334155; padding-bottom:8px; }

    .comparison-table { width:100%; background:#1e293b; border-radius:8px; overflow:hidden; }
    .comparison-table th { background:#1e293b; color:#38bdf8; font-size:0.85em; }
    .comparison-table td { font-size:0.85em; }

    .badge { padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 0.85em; display:inline-block; background:#334155; }
    .badge-info { background:#38bdf8; color:#000; }

    .vector { font-weight:bold; padding:5px 10px; border-radius:5px; font-family: "Courier New", monospace; }
    .vector-perfect { background:#4ade80; color:#000; }
    .vector-close { background:#fbbf24; color:#000; }
    .vector-far { background:#ef4444; color:#fff; }

    .top-scores { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-top:10px; }
    .score-item { background:#1e293b; padding:10px; border-radius:6px; text-align:center; border:2px solid transparent; }
    .score-item.predicted { border-color:#38bdf8; }
    .score-item .score { font-size:1.5em; font-weight:bold; color:#38bdf8; }
    .score-item .prob { font-size:0.8em; color:#94a3b8; margin-top:5px; }

    .metrics-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:15px; margin-top:15px; }
    .metric-item { background:#1e293b; padding:15px; border-radius:8px; border-left:3px solid #38bdf8; }
    .metric-label { font-size:0.8em; color:#64748b; margin-bottom:5px; }
    .metric-value { font-size:1.2em; font-weight:bold; color:#38bdf8; }

    .toggle-btn { background:#38bdf8; color:#000; border:none; padding:10px 16px; border-radius:8px; font-weight:bold; cursor:pointer; }
    .toggle-btn:hover { background:#0ea5e9; }

    .hist-badge { padding:3px 8px; border-radius:999px; background:#0b1220; border:1px solid #334155; color:#e2e8f0; font-size:0.75em; font-weight:bold; }
    .hist-badge.hist-na { color:#94a3b8; font-weight:600; }
    .hist-inline { margin-left:8px; vertical-align:middle; }
  </style>
</head>
<body>
<div class="container">
  <h1>📅 SDM ULTRA — Matchs du jour (${escapeHtml(todayParis)} • ${TZ})</h1>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="label">Matchs du jour</div>
      <div class="value">${matchesOut.length}</div>
      <div class="sub">Leagues: ${escapeHtml(LEAGUES.join(", "))}</div>
    </div>
    <div class="kpi-card">
      <div class="label">Modèle disponible</div>
      <div class="value">${evaluated.length}/${matchesOut.length}</div>
      <div class="sub">min_matches=${PARAMS.min_matches}</div>
    </div>
    <div class="kpi-card">
      <div class="label">Matchs scorés</div>
      <div class="value">${totalScored}</div>
      <div class="sub">live/FT uniquement</div>
    </div>
    <div class="kpi-card">
      <div class="label">SDM accuracy (scorés)</div>
      <div class="value">${totalScored ? (sdmW/totalScored*100).toFixed(1) : "—"}%</div>
      <div class="sub">${sdmW}/${totalScored}</div>
    </div>
  </div>

  <h2>🏆 Résumé par ligue (incl. rappel historique)</h2>
  <div class="league-grid">
    ${leagueCards || `<div style="color:#94a3b8;">Aucune ligue à afficher</div>`}
  </div>

  <h2>🧾 Matchs du jour — Prédictions + Détails (avec cotes)</h2>
  <table>
    <thead>
      <tr>
        <th>Ligue</th><th>Match</th><th>Date</th><th>Score</th><th>SDM</th><th>Confiance</th><th>Vecteur</th><th>OK/Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="8" style="text-align:center; padding:30px; color:#94a3b8;">Aucun match trouvé pour aujourd’hui (${escapeHtml(todayParis)}).</td></tr>`}
    </tbody>
  </table>

  <div style="margin-top:25px; color:#94a3b8; font-size:0.85em;">
    Debug: fixtures=${escapeHtml(DEBUG_FIXTURES_RAW)} • odds=${escapeHtml(DEBUG_ODDS_RAW)} • cache=${escapeHtml(ODDS_CACHE_DIR)}/fixture_*.json
  </div>
</div>

<script>
  function toggleMatchDetails(id, ev) {
    ev = ev || window.event;
    const row = ev.currentTarget;
    const detail = document.getElementById(id);

    document.querySelectorAll(".match-details").forEach(d => { if (d.id !== id) d.classList.remove("active"); });
    document.querySelectorAll(".match-row").forEach(r => { if (r !== row) r.classList.remove("expanded"); });

    detail.classList.toggle("active");
    row.classList.toggle("expanded");
  }

  function toggleImpact(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = (el.style.display === "none" || !el.style.display) ? "block" : "none";
  }
</script>
</body>
</html>
`;
  return html;
}

// ===============================
// RUN
// ===============================
runTodayAnalyzer().catch((e) => {
  console.error("❌ Fatal:", e?.message || e);
});
