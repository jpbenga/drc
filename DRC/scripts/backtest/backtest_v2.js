#!/usr/bin/env node
/* eslint-disable no-var */
/* eslint-disable prefer-const */
/**
 * SDM Ultra — Backtest (Single-file) with:
 * - Robust score matrix (0..20) + Dixon-Coles + clamp + renormalization
 * - Impact Players explainability
 * - Walk-forward probability calibration (Platt scaling) for submarkets
 *
 * Calibration goal: fix overconfidence (your 90-100% buckets collapsing to ~50%).
 * We calibrate per submarket using online logistic regression on logit(p_raw):
 *   q = sigmoid(a * logit(p_raw) + b)
 * and update (a,b) AFTER scoring each match (walk-forward).
 */

function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  
  const fs = require("fs");
  const http = require("http");
  const { calculatePoissonPro, calculateErrorVector, PlattCalibrator, clamp } = require("../../src/core");
  const PORT = 3000;
  
  // ============================================================================
  // PATHS
  // ============================================================================
  const PATHS = {
    elo: "./data/elo/elo_history_archive.json",
    history: (lid) => `./data/history/history_${lid}.json`,
    meta: (lid) => `./data/meta/league_${lid}_meta.json`,
    params: "./data/params/optimized_params.json",
    results: "./data/results/",
  };
  
  // ============================================================================
  // PARAMS (defaults) + load optimized_params.json if present
  // ============================================================================
  let PARAMS = {
    w_xg: 1.071767,
    w_elo: 0.490061,
    rho: 0.067551,
    hfa: 63.171357,
    impact_offensive: 0.069775,
    impact_defensive: 0.045351,
    min_matches: 3,
    confidence_shrinkage: 18.60107,
    // score matrix max goals (explicit grid)
    max_goals: 20,
  };
  
  if (fs.existsSync(PATHS.params)) {
    try {
      const optimized = JSON.parse(fs.readFileSync(PATHS.params, "utf8"));
      PARAMS = { ...PARAMS, ...(optimized.best_params || {}) };
      if (optimized.max_goals != null) PARAMS.max_goals = optimized.max_goals;
      console.log("✅ Paramètres optimisés chargés");
    } catch (err) {
      console.log("⚠️  Utilisation des paramètres par défaut (params JSON illisible)");
    }
  }
  
  const ELO_HISTORY = JSON.parse(fs.readFileSync(PATHS.elo, "utf8"));
  
  const LEAGUES_CONFIG = {
    "39": { name: "Premier League" },
    "61": { name: "Ligue 1" },
    "78": { name: "Bundesliga" },
    "140": { name: "La Liga" },
    "135": { name: "Serie A" },
    "94": { name: "Liga Portugal" },
    "88": { name: "Eredivisie" },
    "203": { name: "Süper Lig" },
  };
  
  // ============================================================================
  // BACKTEST (GLOBAL CHRONO) + WALK-FORWARD CALIBRATION
  // ============================================================================
  function runBacktest() {
    const globalStats = {
      total: 0,
      sdmW: 0,
      scoreExact: 0,
      scoreTop3: 0,
      errorVectors: { home: [], away: [] },
      ou25Correct: 0,
      bttsCorrect: 0,
      homeOver15Correct: 0,
      awayOver05Correct: 0,
      homeOver05Correct: 0,
    };
  
    const leagues = {};
    for (const lid of Object.keys(LEAGUES_CONFIG)) {
      leagues[lid] = { name: LEAGUES_CONFIG[lid].name, matches: [] };
    }
  
    console.log("\n" + "=".repeat(90));
    console.log("🚀 BACKTEST V3 - Walk-forward Calibration (Submarkets) + Impact Players");
    console.log("=".repeat(90));
    console.log(`📊 Confiance Bayésienne (C) : ${PARAMS.confidence_shrinkage}`);
    console.log(`📏 Score matrix max goals   : ${PARAMS.max_goals}`);
    console.log("=".repeat(90) + "\n");
  
    const metaByLeague = {};
    for (const lid of Object.keys(LEAGUES_CONFIG)) {
      const metaFile = PATHS.meta(lid);
      metaByLeague[lid] = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : null;
    }
  
    const all = [];
    for (const lid of Object.keys(LEAGUES_CONFIG)) {
      const file = PATHS.history(lid);
      if (!fs.existsSync(file)) continue;
      const history = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const m of history) {
        if (m?.fixture?.status?.short !== "FT") continue;
        if (m?.goals?.home == null || m?.goals?.away == null) continue;
        all.push({ lid, m });
      }
    }
    all.sort((x, y) => new Date(x.m.fixture.date) - new Date(y.m.fixture.date));
  
    const trackers = {};
    for (const lid of Object.keys(LEAGUES_CONFIG)) trackers[lid] = {};
  
    const cal = {
      ou25_over: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
      btts: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
      homeOver15: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
      awayOver05: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
      homeOver05: new PlattCalibrator({ lr: 0.02, reg: 0.001 }),
    };
  
    const safeFloat = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
  
    for (const item of all) {
      const lid = item.lid;
      const m = item.m;
  
      const rKey = m.league.round;
      const hID = m.teams.home.id;
      const aID = m.teams.away.id;
      const hName = m.teams.home.name;
      const aName = m.teams.away.name;
  
      if (!trackers[lid][hID]) trackers[lid][hID] = { xg: [], ga: [] };
      if (!trackers[lid][aID]) trackers[lid][aID] = { xg: [], ga: [] };
  
      const tracker = trackers[lid];
  
      if (tracker[hID].xg.length >= PARAMS.min_matches && tracker[aID].xg.length >= PARAMS.min_matches) {
        const hElo = ELO_HISTORY[lid]?.[rKey]?.[hName] ?? 1500;
        const aElo = ELO_HISTORY[lid]?.[rKey]?.[aName] ?? 1500;
  
        const res = calculatePoissonPro({
          params: PARAMS,
          tracker,
          match: m,
          metaHome: metaByLeague[lid],
          metaAway: metaByLeague[lid],
          homeId: hID,
          awayId: aID,
          eloHome: hElo,
          eloAway: aElo,
        });
        if (res) {
          const actual = `${m.goals.home}-${m.goals.away}`;
          const actualH = m.goals.home;
          const actualA = m.goals.away;
  
          const errorVec = calculateErrorVector(res.pred, actual);
          globalStats.errorVectors.home.push(errorVec.home);
          globalStats.errorVectors.away.push(errorVec.away);
  
          const sdmPick = (res.H >= res.A) ? "1X" : "X2";
          const sdmConf = ((sdmPick === "1X") ? (res.H + res.D) : (res.A + res.D)) * 100;
          const isSdmOk = (sdmPick === "1X") ? (actualH >= actualA) : (actualA >= actualH);
  
          const isScoreExact = (res.pred === actual);
          const isTop3 = res.top3.some((s) => s.score === actual);
  
          const pOver25_raw = clamp(res.raw.over25, 1e-6, 1 - 1e-6);
          const pBTTS_raw = clamp(res.raw.btts, 1e-6, 1 - 1e-6);
          const pHomeOver15_raw = clamp(res.raw.homeOver15, 1e-6, 1 - 1e-6);
          const pAwayOver05_raw = clamp(res.raw.awayScores, 1e-6, 1 - 1e-6);
          const pHomeOver05_raw = clamp(res.raw.homeScores, 1e-6, 1 - 1e-6);
  
          const pOver25_cal = cal.ou25_over.predict(pOver25_raw);
          const pBTTS_cal = cal.btts.predict(pBTTS_raw);
          const pHomeOver15_cal = cal.homeOver15.predict(pHomeOver15_raw);
          const pAwayOver05_cal = cal.awayOver05.predict(pAwayOver05_raw);
          const pHomeOver05_cal = cal.homeOver05.predict(pHomeOver05_raw);
  
          const yOver25 = (actualH + actualA > 2) ? 1 : 0;
          const yBTTS = (actualH > 0 && actualA > 0) ? 1 : 0;
          const yHomeOver15 = (actualH > 1) ? 1 : 0;
          const yAwayOver05 = (actualA > 0) ? 1 : 0;
          const yHomeOver05 = (actualH > 0) ? 1 : 0;
  
          const ouPickOver = pOver25_cal >= 0.5;
          const ouOk = ouPickOver ? (yOver25 === 1) : (yOver25 === 0);
          const ouConf = Math.max(pOver25_cal, 1 - pOver25_cal) * 100;
  
          const bttsPickYes = pBTTS_cal >= 0.5;
          const bttsOk = bttsPickYes ? (yBTTS === 1) : (yBTTS === 0);
          const bttsConf = Math.max(pBTTS_cal, 1 - pBTTS_cal) * 100;
  
          const h15PickYes = pHomeOver15_cal >= 0.5;
          const h15Ok = h15PickYes ? (yHomeOver15 === 1) : (yHomeOver15 === 0);
          const h15Conf = Math.max(pHomeOver15_cal, 1 - pHomeOver15_cal) * 100;
  
          const a05PickYes = pAwayOver05_cal >= 0.5;
          const a05Ok = a05PickYes ? (yAwayOver05 === 1) : (yAwayOver05 === 0);
          const a05Conf = Math.max(pAwayOver05_cal, 1 - pAwayOver05_cal) * 100;
  
          const h05PickYes = pHomeOver05_cal >= 0.5;
          const h05Ok = h05PickYes ? (yHomeOver05 === 1) : (yHomeOver05 === 0);
          const h05Conf = Math.max(pHomeOver05_cal, 1 - pHomeOver05_cal) * 100;
  
          globalStats.total++;
          if (isSdmOk) globalStats.sdmW++;
          if (isScoreExact) globalStats.scoreExact++;
          if (isTop3) globalStats.scoreTop3++;
          if (ouOk) globalStats.ou25Correct++;
          if (bttsOk) globalStats.bttsCorrect++;
          if (h15Ok) globalStats.homeOver15Correct++;
          if (a05Ok) globalStats.awayOver05Correct++;
          if (h05Ok) globalStats.homeOver05Correct++;
  
          // walk-forward update
          cal.ou25_over.update(pOver25_raw, yOver25);
          cal.btts.update(pBTTS_raw, yBTTS);
          cal.homeOver15.update(pHomeOver15_raw, yHomeOver15);
          cal.awayOver05.update(pAwayOver05_raw, yAwayOver05);
          cal.homeOver05.update(pHomeOver05_raw, yHomeOver05);
  
          leagues[lid].matches.push({
            leagueId: lid,
            round: rKey,
            date: m.fixture?.date,
            home: hName,
            away: aName,
            actual,
            pred: res.pred,
            top3: res.top3,
            errorVec,
            sdmPick,
            sdmConf,
            isSdmOk,
            isScoreExact,
            isTop3,
            m1: {
              btts: (pBTTS_cal * 100).toFixed(1),
              over25: (pOver25_cal * 100).toFixed(1),
              under25: ((1 - pOver25_cal) * 100).toFixed(1),
              homeOver15: (pHomeOver15_cal * 100).toFixed(1),
              awayScores: (pAwayOver05_cal * 100).toFixed(1),
              homeScores: (pHomeOver05_cal * 100).toFixed(1),
            },
            rawPct: {
              btts: (pBTTS_raw * 100).toFixed(1),
              over25: (pOver25_raw * 100).toFixed(1),
              homeOver15: (pHomeOver15_raw * 100).toFixed(1),
              awayScores: (pAwayOver05_raw * 100).toFixed(1),
              homeScores: (pHomeOver05_raw * 100).toFixed(1),
            },
            submarkets: {
              over25: { actual: !!yOver25, m1: ouPickOver, conf: ouConf },
              btts: { actual: !!yBTTS, m1: bttsPickYes, conf: bttsConf },
              homeOver15: { actual: !!yHomeOver15, m1: h15PickYes, conf: h15Conf },
              awayScores: { actual: !!yAwayOver05, m1: a05PickYes, conf: a05Conf },
              homeScores: { actual: !!yHomeOver05, m1: h05PickYes, conf: h05Conf },
            },
            debug: res.debug,
          });
        }
      }
  
      // update tracker
      const xgH = safeFloat(m.stats?.home?.expected_goals);
      const xgA = safeFloat(m.stats?.away?.expected_goals);
      if (xgH != null && xgA != null) {
        tracker[hID].xg.push(xgH);
        tracker[hID].ga.push(m.goals.away);
        tracker[aID].xg.push(xgA);
        tracker[aID].ga.push(m.goals.home);
      }
    }
  
    printResults(globalStats, leagues, cal);
    startServer(globalStats, leagues);
  }
  
  function printResults(global, leagues, cal) {
    const avgErrorHome = global.errorVectors.home.reduce((a, b) => a + b, 0) / (global.errorVectors.home.length || 1);
    const avgErrorAway = global.errorVectors.away.reduce((a, b) => a + b, 0) / (global.errorVectors.away.length || 1);
  
    console.log("\n" + "=".repeat(90));
    console.log("📊 RÉSULTATS GLOBAUX");
    console.log("=".repeat(90));
    console.log(`Total Matchs          : ${global.total}`);
    console.log(`Précision SDM         : ${(global.sdmW / global.total * 100).toFixed(2)}% (${global.sdmW}/${global.total})`);
    console.log(`Score Exact (Top 1)   : ${(global.scoreExact / global.total * 100).toFixed(2)}% (${global.scoreExact}/${global.total})`);
    console.log(`Score Exact (Top 3)   : ${(global.scoreTop3 / global.total * 100).toFixed(2)}% (${global.scoreTop3}/${global.total})`);
    console.log("=".repeat(90));
  
    console.log("\n🧪 Submarkets (calibrated picks @ 50%)");
    console.log("=".repeat(90));
    console.log(`OU2.5 Correct      : ${(global.ou25Correct / global.total * 100).toFixed(2)}%`);
    console.log(`BTTS Correct       : ${(global.bttsCorrect / global.total * 100).toFixed(2)}%`);
    console.log(`Home >1.5 Correct  : ${(global.homeOver15Correct / global.total * 100).toFixed(2)}%`);
    console.log(`Away >0.5 Correct  : ${(global.awayOver05Correct / global.total * 100).toFixed(2)}%`);
    console.log(`Home >0.5 Correct  : ${(global.homeOver05Correct / global.total * 100).toFixed(2)}%`);
    console.log("=".repeat(90));
  
    console.log("\n🧯 Calibration parameters (end-of-run)");
    console.log("=".repeat(90));
    const show = (name, c) => console.log(`${name.padEnd(14)} : a=${c.a.toFixed(3)} b=${c.b.toFixed(3)} n=${c.n}`);
    show("OU2.5_over", cal.ou25_over);
    show("BTTS", cal.btts);
    show("Home>1.5", cal.homeOver15);
    show("Away>0.5", cal.awayOver05);
    show("Home>0.5", cal.homeOver05);
    console.log("=".repeat(90) + "\n");
  }
  
  // ============================================================================
  // SERVER UI (same design)
  // ============================================================================
  function startServer(global, leagues) {
    const clamp2 = (n, a, b) => Math.max(a, Math.min(b, n));
    const pct = (num, den, d = 1) => (den ? (num / den * 100).toFixed(d) : (0).toFixed(d));
    const fmt2 = (x) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "—");
  
    const BUCKETS = [
      { key: "90-100", label: "Tranche 90-100%", min: 90, max: 100, color: "#fbbf24" },
      { key: "80-90", label: "Tranche 80-90%", min: 80, max: 90, color: "#10b981" },
      { key: "70-80", label: "Tranche 70-80%", min: 70, max: 80, color: "#0ea5e9" },
      { key: "60-70", label: "Tranche 60-70%", min: 60, max: 70, color: "#f59e0b" },
      { key: "50-60", label: "Tranche 50-60%", min: 50, max: 60, color: "#94a3b8" },
    ];
  
    const allMatches = Object.values(leagues).flatMap((l) => l.matches || []);
  
    function bucketKeyFromConfidence(conf) {
      const c = clamp2(conf, 0, 100);
      for (const b of BUCKETS) {
        if (c >= b.min && (c < b.max || b.max === 100)) return b.key;
      }
      return null;
    }
  
    const sdmBuckets = Object.fromEntries(BUCKETS.map((b) => [b.key, { total: 0, win: 0, scoreExact: 0 }]));
    for (const m of allMatches) {
      if (typeof m.sdmConf !== "number") continue;
      const k = bucketKeyFromConfidence(m.sdmConf);
      if (!k) continue;
      sdmBuckets[k].total++;
      if (m.isSdmOk) sdmBuckets[k].win++;
      if (m.isScoreExact) sdmBuckets[k].scoreExact++;
    }
  
    const SUBMARKETS = [
      { id: "ou25", title: "⚽ OVER/UNDER 2.5 Goals", conf: (m) => m.submarkets?.over25?.conf ?? 0, ok: (m) => (m.submarkets?.over25?.m1 ? m.submarkets?.over25?.actual : !m.submarkets?.over25?.actual) },
      { id: "btts", title: "🎲 BTTS (Both Teams To Score)", conf: (m) => m.submarkets?.btts?.conf ?? 0, ok: (m) => (m.submarkets?.btts?.m1 ? m.submarkets?.btts?.actual : !m.submarkets?.btts?.actual) },
      { id: "home15", title: "🏠 HOME TEAM Over 1.5", conf: (m) => m.submarkets?.homeOver15?.conf ?? 0, ok: (m) => (m.submarkets?.homeOver15?.m1 ? m.submarkets?.homeOver15?.actual : !m.submarkets?.homeOver15?.actual) },
      { id: "away05", title: "✈️ AWAY TEAM Over 0.5", conf: (m) => m.submarkets?.awayScores?.conf ?? 0, ok: (m) => (m.submarkets?.awayScores?.m1 ? m.submarkets?.awayScores?.actual : !m.submarkets?.awayScores?.actual) },
      { id: "home05", title: "🏟️ HOME TEAM Over 0.5", conf: (m) => m.submarkets?.homeScores?.conf ?? 0, ok: (m) => (m.submarkets?.homeScores?.m1 ? m.submarkets?.homeScores?.actual : !m.submarkets?.homeScores?.actual) },
    ];
  
    const subBucketsByMarket = {};
    for (const sm of SUBMARKETS) {
      subBucketsByMarket[sm.id] = Object.fromEntries(BUCKETS.map((b) => [b.key, { total: 0, ok: 0 }]));
      for (const m of allMatches) {
        const conf = sm.conf(m);
        const k = bucketKeyFromConfidence(conf);
        if (!k) continue;
        subBucketsByMarket[sm.id][k].total++;
        if (sm.ok(m)) subBucketsByMarket[sm.id][k].ok++;
      }
    }
  
    const leaguesHtml = Object.entries(leagues).map(([lid, l]) => {
      const ms = l.matches || [];
      const total = ms.length || 0;
      const sdmW = ms.filter((x) => x.isSdmOk).length;
      const scoreExact = ms.filter((x) => x.isScoreExact).length;
      const avgDist = total ? (ms.reduce((acc, x) => acc + (x.errorVec?.manhattan ?? 0), 0) / total).toFixed(2) : "0.00";
      const bttsCal = total ? pct(ms.filter((x) => (x.submarkets?.btts?.m1 ? x.submarkets?.btts?.actual : !x.submarkets?.btts?.actual)).length, total, 1) : "0.0";
      const ou25Cal = total ? pct(ms.filter((x) => (x.submarkets?.over25?.m1 ? x.submarkets?.over25?.actual : !x.submarkets?.over25?.actual)).length, total, 1) : "0.0";
      return `
        <div class="league-card">
          <div class="league-header">⚽ ${escapeHtml(l.name)}</div>
          <div class="stat-row"><span class="stat-label">SDM (1X/X2)</span><span class="stat-value">${pct(sdmW, total, 1)}% (${sdmW}/${total})</span></div>
          <div class="stat-row"><span class="stat-label">Score Exact</span><span class="stat-value">${pct(scoreExact, total, 1)}% (${scoreExact}/${total})</span></div>
          <div class="stat-row"><span class="stat-label">Distance Moy.</span><span class="stat-value">${avgDist} buts</span></div>
          <div class="stat-row"><span class="stat-label">BTTS (cal)</span><span class="stat-value">${bttsCal}%</span></div>
          <div class="stat-row"><span class="stat-label">OU2.5 (cal)</span><span class="stat-value">${ou25Cal}%</span></div>
        </div>
      `;
    }).join("");
  
    function renderSubmarketCards(smId) {
      const bucketObj = subBucketsByMarket[smId];
      return BUCKETS.map((b) => {
        const s = bucketObj[b.key];
        return `
          <div class="kpi-card" style="color:${b.color};">
            <div class="label">${b.key}%</div>
            <div class="value">${pct(s.ok, s.total, 1)}%</div>
            <div class="sub">✅ ${s.ok}/${s.total}</div>
          </div>
        `;
      }).join("");
    }
  
    function formatConfBadge(conf) {
      const c = clamp2(conf, 0, 100);
      const bg = c >= 85 ? "#10b981" : c >= 75 ? "#0ea5e9" : c >= 65 ? "#fbbf24" : "#94a3b8";
      const fg = (bg === "#94a3b8") ? "#0f172a" : "#000";
      return `<span style="padding:5px 10px; border-radius:6px; background:${bg}; color:${fg}; font-weight:bold">${c.toFixed(0)}%</span>`;
    }
  
    function vectorClass(m) {
      const d = m.errorVec?.manhattan ?? 99;
      if (d === 0) return "vector-perfect";
      if (d <= 1) return "vector-close";
      return "vector-far";
    }
    function sdmResultLabel(m) {
      return m.isSdmOk ? `<span style="color:#4ade80; font-weight:bold;">✅ SDM</span>` : `<span style="color:#ef4444; font-weight:bold;">❌ FAIL</span>`;
    }
    function safeId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, "_"); }
  
    function renderLeagueLogs(lid, l) {
      const byRound = {};
      for (const m of (l.matches || [])) {
        const r = m.round || "N/A";
        byRound[r] = byRound[r] || [];
        byRound[r].push(m);
      }
  
      const roundsHtml = Object.keys(byRound).sort().map((r) => {
        const rows = byRound[r].map((m, idx) => {
          const matchId = `m_${safeId(lid)}_${safeId(r)}_${idx}`;
          const topScoresHtml = (m.top3 || []).map((s) => {
            const score = s.score;
            const prob = (s.prob * 100).toFixed(2);
            const cls = score === m.pred ? "score-item predicted" : (score === m.actual ? "score-item actual" : "score-item");
            const tag = score === m.pred ? `<div style="font-size:0.7em; color:#38bdf8; margin-top:5px;">⭐ PRÉDIT</div>`
              : score === m.actual ? `<div style="font-size:0.7em; color:#4ade80; margin-top:5px;">✅ RÉEL</div>` : "";
            return `<div class="${cls}"><div class="score">${score}</div><div class="prob">${prob}%</div>${tag}</div>`;
          }).join("");
  
          const debug = m.debug || {};
          const rowsSm = [
            { name: "BTTS (cal)", p: m.m1?.btts, conf: m.submarkets?.btts?.conf, actual: m.submarkets?.btts?.actual },
            { name: "Over 2.5 (cal)", p: m.m1?.over25, conf: m.submarkets?.over25?.conf, actual: m.submarkets?.over25?.actual },
            { name: "Home >1.5 (cal)", p: m.m1?.homeOver15, conf: m.submarkets?.homeOver15?.conf, actual: m.submarkets?.homeOver15?.actual },
            { name: "Away >0.5 (cal)", p: m.m1?.awayScores, conf: m.submarkets?.awayScores?.conf, actual: m.submarkets?.awayScores?.actual },
            { name: "Home >0.5 (cal)", p: m.m1?.homeScores, conf: m.submarkets?.homeScores?.conf, actual: m.submarkets?.homeScores?.actual },
          ].map((row) => {
            const resTxt = row.actual ? "✅ OUI" : "❌ NON";
            const confTxt = row.conf != null ? `${row.conf.toFixed(0)}%` : "—";
            return `<tr><td>${row.name}</td><td><strong>${row.p}%</strong></td><td>${confTxt}</td><td>${resTxt}</td></tr>`;
          }).join("");
  
          return `
            <tr class="match-row" onclick="toggleMatchDetails('${matchId}')">
              <td style="font-weight:500">${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</td>
              <td><span class="badge badge-info">${escapeHtml(m.actual)}</span></td>
              <td><span class="badge">${escapeHtml(m.sdmPick || "—")}</span></td>
              <td>${formatConfBadge(m.sdmConf ?? 0)}</td>
              <td><span class="vector ${vectorClass(m)}">[${m.errorVec?.home >= 0 ? "+" : ""}${m.errorVec?.home} | ${m.errorVec?.away >= 0 ? "+" : ""}${m.errorVec?.away}]</span></td>
              <td>${sdmResultLabel(m)}</td>
            </tr>
            <tr><td colspan="6" style="padding: 0; border: none;">
              <div id="${matchId}" class="match-details">
                <div style="background: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                  <h3 style="color: #38bdf8; margin-bottom: 15px;">🏟️ ${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</h3>
                  <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                    <div><div style="color:#64748b; font-size:0.8em;">Score Réel</div><div style="font-size:1.5em; font-weight:bold; color:#4ade80;">${escapeHtml(m.actual)}</div></div>
                    <div><div style="color:#64748b; font-size:0.8em;">Score Prédit</div><div style="font-size:1.5em; font-weight:bold; color:#38bdf8;">${escapeHtml(m.pred)}</div></div>
                    <div><div style="color:#64748b; font-size:0.8em;">Écart Vectoriel</div><div style="font-size:1.5em; font-weight:bold; color:#fbbf24;">[${m.errorVec?.home >= 0 ? "+" : ""}${m.errorVec?.home} | ${m.errorVec?.away >= 0 ? "+" : ""}${m.errorVec?.away}]</div></div>
                    <div><div style="color:#64748b; font-size:0.8em;">SDM</div><div style="font-size:0.9em; color:#94a3b8;">Pick ${escapeHtml(m.sdmPick)} • Confiance ${clamp2(m.sdmConf ?? 0, 0, 100).toFixed(0)}%</div></div>
                  </div>
                </div>
  
                
                <div class="detail-section">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                  <div class="detail-title" style="margin:0;">🧑‍⚕️ Impact Players — Absences & Effet sur λ</div>
                  <button class="toggle-btn" style="padding:6px 10px; border-radius:8px; font-size:0.85em;" onclick="toggleImpact(event, 'imp_${matchId}')">Afficher / Masquer</button>
                </div>
                <div id="imp_${matchId}" style="display:none; margin-top:12px;">
                  ${(() => {
                    const imp = (debug && debug.impact) ? debug.impact : null;
                    const h = imp && imp.home ? imp.home : null;
                    const a = imp && imp.away ? imp.away : null;
  
                    const lh0 = (typeof debug?.lh_base === "number") ? debug.lh_base : null;
                    const la0 = (typeof debug?.la_base === "number") ? debug.la_base : null;
                    const lh1 = (typeof debug?.lh === "number") ? debug.lh : null;
                    const la1 = (typeof debug?.la === "number") ? debug.la : null;
  
                    const pctDelta = (b, f) => {
                      if (!(typeof b === "number" && typeof f === "number" && b > 0)) return "—";
                      const d = (f - b) / b * 100;
                      return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
                    };
  
                    const renderSide = (sideName, obj) => {
                      const off = obj?.offensive ?? 0;
                      const deff = obj?.defensive ?? 0;
                      const abs = Array.isArray(obj?.absences) ? obj.absences : [];
  
                      const header = `
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px;">
                          <div style="font-weight:800; color:#e2e8f0;">${sideName}</div>
                          <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            <span class="badge" style="background:#0ea5e9; color:#000;">Off ${Number(off).toFixed(2)}</span>
                            <span class="badge" style="background:#f97316; color:#000;">Def ${Number(deff).toFixed(2)}</span>
                            <span class="badge" style="background:#334155; color:#e2e8f0;">Abs ${abs.length}</span>
                          </div>
                        </div>
                      `;
  
                      if (!abs.length) {
                        return header + `<div style="color:#94a3b8; font-size:0.9em;">Aucune absence clé détectée.</div>`;
                      }
  
                      const rows = abs.map(p => {
                        const tags = Array.isArray(p.tags) ? p.tags : [];
                        const tagsHtml = tags.length
                          ? tags.map(t => `<span class="badge" style="background:#334155; color:#e2e8f0; margin-right:6px;">${escapeHtml(t)}</span>`).join("")
                          : `<span style="color:#94a3b8;">—</span>`;
  
                        const rating = (p.rating != null && p.rating !== "" && !Number.isNaN(Number(p.rating)))
                          ? Number(p.rating).toFixed(2)
                          : "—";
  
                        const pos = p.position ? escapeHtml(p.position) : "—";
                        const reason = p.reason ? escapeHtml(p.reason) : "—";
  
                        const io = (p.impact_off != null) ? Number(p.impact_off).toFixed(1) : "0.0";
                        const idf = (p.impact_def != null) ? Number(p.impact_def).toFixed(1) : "0.0";
  
                        return `
                          <div style="padding:12px; border:1px solid #334155; border-radius:10px; background:#0b1220; margin-bottom:10px;">
                            <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
                              <div>
                                <div style="font-weight:700; color:#e2e8f0;">${escapeHtml(p.name || "—")}</div>
                                <div style="color:#94a3b8; font-size:0.85em; margin-top:2px;">${pos} • Rating ${rating}</div>
                                <div style="color:#94a3b8; font-size:0.85em; margin-top:4px;">${reason}</div>
                              </div>
                              <div style="text-align:right;">
                                <div style="color:#38bdf8; font-weight:800;">ΔOff ${io}</div>
                                <div style="color:#f97316; font-weight:800;">ΔDef ${idf}</div>
                              </div>
                            </div>
                            <div style="margin-top:10px;">${tagsHtml}</div>
                          </div>
                        `;
                      }).join("");
  
                      return header + rows;
                    };
  
                    const hasAny = (h && (h.absences?.length || h.offensive || h.defensive)) || (a && (a.absences?.length || a.offensive || a.defensive));
                    const lambdaBlock = `
                      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:12px; margin-bottom:16px;">
                        <div class="metric-item">
                          <div class="metric-label">λ Home (base → final)</div>
                          <div class="metric-value">${(lh0!=null && lh1!=null) ? `${lh0.toFixed(2)} → ${lh1.toFixed(2)}` : "—"}</div>
                          <div style="color:#94a3b8; font-size:0.85em; margin-top:6px;">Δ ${pctDelta(lh0, lh1)}</div>
                        </div>
                        <div class="metric-item">
                          <div class="metric-label">λ Away (base → final)</div>
                          <div class="metric-value">${(la0!=null && la1!=null) ? `${la0.toFixed(2)} → ${la1.toFixed(2)}` : "—"}</div>
                          <div style="color:#94a3b8; font-size:0.85em; margin-top:6px;">Δ ${pctDelta(la0, la1)}</div>
                        </div>
                        <div class="metric-item">
                          <div class="metric-label">Coefficients Impact</div>
                          <div class="metric-value">${(typeof PARAMS?.impact_offensive === "number" && typeof PARAMS?.impact_defensive === "number")
                            ? `Off ${PARAMS.impact_offensive.toFixed(3)} • Def ${PARAMS.impact_defensive.toFixed(3)}`
                            : "—"}</div>
                          <div style="color:#94a3b8; font-size:0.85em; margin-top:6px;">(appliqués en multiplicatif sur λ)</div>
                        </div>
                      </div>
                    `;
  
                    if (!hasAny) {
                      return lambdaBlock + `<div style="color:#94a3b8;">Aucun signal “impact player” disponible (pas de contexte blessures ou meta manquante).</div>`;
                    }
  
                    return lambdaBlock + `
                      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:14px;">
                        <div style="background:#0f172a; padding:14px; border-radius:12px; border:1px solid #334155;">
                          ${renderSide("🏠 Domicile", h)}
                        </div>
                        <div style="background:#0f172a; padding:14px; border-radius:12px; border:1px solid #334155;">
                          ${renderSide("✈️ Extérieur", a)}
                        </div>
                      </div>
                    `;
                  })()}
                </div>
                </div>
  
  <div class="detail-section">
                  <div class="detail-title">📈 Sous-marchés (calibrés walk-forward)</div>
                  <table class="comparison-table">
                    <thead><tr><th>Marché</th><th>Probabilité</th><th>Confiance</th><th>Résultat</th></tr></thead>
                    <tbody>${rowsSm}</tbody>
                  </table>
                </div>
  
                <div class="detail-section">
                  <div class="detail-title">📊 Top Scores</div>
                  <div class="top-scores">${topScoresHtml || `<div style="color:#94a3b8;">—</div>`}</div>
                </div>
  
                <div class="detail-section">
                  <div class="detail-title">🔬 Métriques Techniques</div>
                  <div class="metrics-grid">
                    <div class="metric-item"><div class="metric-label">λ Domicile</div><div class="metric-value">${fmt2(debug?.lh)}</div></div>
                    <div class="metric-item"><div class="metric-label">λ Extérieur</div><div class="metric-value">${fmt2(debug?.la)}</div></div>
                    <div class="metric-item"><div class="metric-label">Rho</div><div class="metric-value">${debug?.rho ?? "—"}</div></div>
                    <div class="metric-item"><div class="metric-label">HFA</div><div class="metric-value">${debug?.hfa != null ? `+${fmt2(Number(debug.hfa))}` : "—"}</div></div>
                    <div class="metric-item"><div class="metric-label">Matrix Σ raw</div><div class="metric-value">${debug?.matrix_sum_raw != null ? fmt2(Number(debug.matrix_sum_raw)) : "—"}</div></div>
                    <div class="metric-item"><div class="metric-label">Matrix min raw</div><div class="metric-value">${debug?.matrix_min_raw != null ? fmt2(Number(debug.matrix_min_raw)) : "—"}</div></div>
                  </div>
                </div>
              </div>
            </td></tr>
          `;
        }).join("");
  
        return `
          <div style="margin-top:25px; font-weight:bold; color:#94a3b8; font-size:0.9em; padding:8px; background:#0f172a; border-radius:6px">📅 ${escapeHtml(r)}</div>
          <table>
            <thead><tr><th>Match</th><th>Score</th><th>Pari SDM</th><th>Confiance</th><th>Écart Vectoriel</th><th>Résultat</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }).join("");
  
      return `<div class="round-box"><h2 style="margin:0 0 20px 0; font-size:1.3em; color:#38bdf8">⚽ ${escapeHtml(l.name)} - Logs Détaillés</h2>${roundsHtml || `<div style="color:#94a3b8;">Aucun match</div>`}</div>`;
    }
  
    const logsHtml = Object.entries(leagues).map(([lid, l]) => renderLeagueLogs(lid, l)).join("");
  
    const html = `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SDM Ultra - Backtest</title>
  <style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f172a; color:white; font-family:'Inter', -apple-system, BlinkMacSystemFont, sans-serif; padding:30px; }
  .container { max-width: 1800px; margin:auto; }
  h1 { color:#38bdf8; border-left:5px solid #38bdf8; padding-left:15px; margin-bottom:30px; font-size:2em; }
  h2 { color:#38bdf8; margin:40px 0 20px 0; font-size:1.5em; }
  .kpi-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px; margin:30px 0; }
  .kpi-card { background:#1e293b; padding:20px; border-radius:12px; text-align:center; border:1px solid #334155; position:relative; transition: transform .2s; }
  .kpi-card:hover { transform: translateY(-3px); }
  .kpi-card::after { content:''; position:absolute; bottom:0; left:0; width:100%; height:4px; background: currentColor; border-radius:0 0 12px 12px; }
  .kpi-card .label { font-size:0.75em; color:#64748b; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px; }
  .kpi-card .value { font-size:2.2em; font-weight:800; color:#38bdf8; }
  .kpi-card .sub { font-size:0.85em; color:#94a3b8; margin-top:8px; }
  .submarkets-section { background:#1e293b; border-radius:12px; padding:25px; margin:30px 0; border:1px solid #334155; }
  .submarket-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
  .submarket-title { font-size:1.3em; color:#38bdf8; font-weight:bold; }
  .toggle-btn { background:#38bdf8; color:#000; border:none; padding:10px 20px; border-radius:8px; font-weight:bold; cursor:pointer; transition: all .3s; }
  .toggle-btn:hover { background:#0ea5e9; transform: scale(1.05); }
  .submarkets-visible { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px; }
  .submarkets-hidden { display:none; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:15px; margin-top:20px; padding-top:20px; border-top:1px solid #334155; }
  .submarkets-hidden.active { display:grid; }
  .league-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap:20px; margin-bottom:50px; }
  .league-card { background:#1e293b; padding:20px; border-radius:12px; border:1px solid #334155; }
  .league-header { font-weight:bold; color:#38bdf8; font-size:1.1em; margin-bottom:15px; border-bottom:2px solid #334155; padding-bottom:10px; }
  .stat-row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:0.9em; }
  .stat-label { color:#94a3b8; } .stat-value { font-weight:bold; color:#4ade80; }
  .round-box { background:#1e293b; border-radius:12px; padding:25px; margin-bottom:35px; border:1px solid #334155; }
  table { width:100%; border-collapse:collapse; margin:20px 0; background:#1e293b; border-radius:12px; overflow:hidden; }
  th { text-align:left; color:#64748b; font-size:0.8em; text-transform:uppercase; padding:15px; border-bottom:2px solid #0f172a; background:#1e293b; }
  td { padding:12px 15px; border-bottom:1px solid #334155; font-size:0.9em; }
  tr:hover { background:#334155; cursor:pointer; }
  tr.match-row.expanded { background:#334155; }
  .match-details { display:none; background:#0f172a; padding:25px; border-radius:8px; margin:15px 0; }
  .match-details.active { display:block; animation: slideDown .3s ease-out; }
  @keyframes slideDown { from { opacity:0; transform: translateY(-10px);} to { opacity:1; transform: translateY(0);} }
  .detail-section { margin:20px 0; }
  .detail-title { color:#38bdf8; font-weight:bold; font-size:1.1em; margin-bottom:15px; border-bottom:2px solid #334155; padding-bottom:8px; }
  .comparison-table { width:100%; background:#1e293b; border-radius:8px; overflow:hidden; }
  .comparison-table th { background:#1e293b; color:#38bdf8; font-size:0.85em; }
  .badge { padding:5px 10px; border-radius:6px; font-weight:bold; font-size:0.85em; display:inline-block; }
  .badge-info { background:#38bdf8; color:#000; }
  .vector { font-weight:bold; padding:5px 10px; border-radius:5px; font-family:'Courier New', monospace; }
  .vector-perfect { background:#4ade80; color:#000; }
  .vector-close { background:#fbbf24; color:#000; }
  .vector-far { background:#ef4444; color:#fff; }
  .top-scores { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-top:10px; }
  .score-item { background:#1e293b; padding:10px; border-radius:6px; text-align:center; border:2px solid transparent; }
  .score-item.predicted { border-color:#38bdf8; } .score-item.actual { border-color:#4ade80; }
  .score-item .score { font-size:1.5em; font-weight:bold; color:#38bdf8; }
  .score-item .prob { font-size:0.8em; color:#94a3b8; margin-top:5px; }
  .metrics-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:15px; margin-top:15px; }
  .metric-item { background:#1e293b; padding:15px; border-radius:8px; border-left:3px solid #38bdf8; }
  .metric-label { font-size:0.8em; color:#64748b; margin-bottom:5px; }
  .metric-value { font-size:1.3em; font-weight:bold; color:#38bdf8; }
  </style>
  </head>
  <body>
  <div class="container">
  <h1>🎯 SDM ULTRA — Backtest (Calibration walk-forward)</h1>
  
  <h2>📊 Marché Principal : SDM (1X/X2) - Tranches de Confiance</h2>
  <div class="kpi-grid">
  ${BUCKETS.map(b => {
    const s = sdmBuckets[b.key];
    return `
    <div class="kpi-card" style="color:${b.color};">
      <div class="label">${b.label}</div>
      <div class="value">${pct(s.win, s.total, 1)}%</div>
      <div class="sub">🎯 ${s.win}/${s.total} paris | Score Exact: ${s.scoreExact}/${s.total}</div>
    </div>`;
  }).join("")}
  </div>
  
  <div class="submarkets-section">
  <div class="submarket-header">
  <div class="submarket-title">📈 Sous-Marchés : Performance par Tranche de Confiance (calibrée)</div>
  <button class="toggle-btn" onclick="toggleSubmarkets()"><span id="toggleText">Afficher tous les sous-marchés</span></button>
  </div>
  
  <div style="margin-bottom:30px;">
  <div style="color:#38bdf8; font-weight:bold; font-size:1.1em; margin-bottom:15px;">⚽ OVER/UNDER 2.5 Goals</div>
  <div class="submarkets-visible">${renderSubmarketCards("ou25")}</div>
  </div>
  
  <div id="hiddenSubmarkets" class="submarkets-hidden">
  ${SUBMARKETS.filter(s => s.id !== "ou25").map(sm => `
    <div style="grid-column:1 / -1; margin:20px 0 15px 0;">
      <div style="color:#38bdf8; font-weight:bold; font-size:1.1em;">${sm.title}</div>
    </div>
    ${renderSubmarketCards(sm.id)}
  `).join("")}
  </div>
  </div>
  
  <h2>🏆 Performance par Ligue</h2>
  <div class="league-grid">${leaguesHtml}</div>
  
  ${logsHtml}
  </div>
  
  <script>
  function toggleSubmarkets() {
    const hidden = document.getElementById('hiddenSubmarkets');
    const btn = document.getElementById('toggleText');
    if (hidden.classList.contains('active')) { hidden.classList.remove('active'); btn.textContent = 'Afficher tous les sous-marchés'; }
    else { hidden.classList.add('active'); btn.textContent = 'Masquer les sous-marchés'; }
  }
  function toggleMatchDetails(matchId) {
    const detail = document.getElementById(matchId);
    const row = event.currentTarget;
    document.querySelectorAll('.match-details').forEach(d => { if (d.id !== matchId) d.classList.remove('active'); });
    document.querySelectorAll('.match-row').forEach(r => { if (r !== row) r.classList.remove('expanded'); });
    detail.classList.toggle('active');
    row.classList.toggle('expanded');
  }
  
  function toggleImpact(ev, id) {
    try { if (ev) ev.stopPropagation(); } catch(e) {}
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = (el.style.display === 'none' || el.style.display === '') ? 'block' : 'none';
  }
  
  </script>
  </body>
  </html>
  `;
  
    http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    }).listen(PORT, () => console.log(`\n🌍 Dashboard : http://localhost:${PORT}\n`));
  }
  
  runBacktest();
  