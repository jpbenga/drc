const fs = require('fs');
const http = require('http');
const PORT = 3000;

// ============================================================================
// CHEMINS DES FICHIERS (STRUCTURE RÉORGANISÉE)
// ============================================================================
const PATHS = {
    elo: './data/elo/elo_history_archive.json',
    history: (lid) => `./data/history/history_${lid}.json`,
    meta: (lid) => `./data/meta/league_${lid}_meta.json`,
    params: './data/params/optimized_params.json',
    results: './data/results/'
};

// PARAMÈTRES OPTIMISÉS
let PARAMS = {
    w_xg: 1.0591,
    w_elo: 0.6315,
    rho: -0.1319,
    hfa: 75.4065,
    impact_offensive: 0.0569,
    impact_defensive: 0.2140,
    min_matches: 3
};

// Charger les paramètres optimisés si disponibles
if (fs.existsSync(PATHS.params)) {
    try {
        const optimized = JSON.parse(fs.readFileSync(PATHS.params, 'utf8'));
        PARAMS = { ...PARAMS, ...optimized.best_params };
        console.log('✅ Paramètres optimisés chargés depuis', PATHS.params);
    } catch (err) {
        console.log('⚠️  Utilisation des paramètres par défaut');
    }
}

const ELO_HISTORY = JSON.parse(fs.readFileSync(PATHS.elo, 'utf8'));

const LEAGUES_CONFIG = {
    '39': { name: "Premier League" }, 
    '61': { name: "Ligue 1" }, 
    '78': { name: "Bundesliga" },
    '140': { name: "La Liga" }, 
    '135': { name: "Serie A" }, 
    '94': { name: "Liga Portugal" },
    '88': { name: "Eredivisie" }, 
    '197': { name: "Super League (GRE)" }, 
    '203': { name: "Süper Lig" }
};

const BUCKET_COLORS = { 
    '90-100%': '#fbbf24', 
    '80-90%': '#10b981', 
    '70-80%': '#0ea5e9', 
    '60-70%': '#f59e0b', 
    '50-60%': '#94a3b8' 
};

// ============================================================================
// UTILITAIRES MATHÉMATIQUES
// ============================================================================

function fact(n) { 
    return n <= 1 ? 1 : n * fact(n - 1); 
}

function clubEloWinProb(deltaElo) { 
    return 1 / (Math.pow(10, -deltaElo / 400) + 1); 
}

function bayesianShrinkage(teamStats, leagueAvg, confidence = 15) {
    const n = teamStats.length;
    if (n === 0) return leagueAvg;
    
    const teamMean = teamStats.reduce((a, b) => a + b, 0) / n;
    return (confidence * leagueAvg + n * teamMean) / (confidence + n);
}

// ============================================================================
// DÉTECTION DES IMPACT PLAYERS
// ============================================================================

function detectImpactAbsences(match, meta, side) {
    const injuries = side === 'home' ? match.context?.injuries_home : match.context?.injuries_away;
    if (!injuries || !meta) return { offensive: 0, defensive: 0 };

    let offensiveImpact = 0;
    let defensiveImpact = 0;

    injuries.forEach(inj => {
        if (inj.type !== "Missing Fixture") return;

        const isTopScorer = meta.top_scorers?.some(vip => vip.id === inj.player_id);
        if (isTopScorer) offensiveImpact++;

        const isTopAssist = meta.top_assists?.some(vip => vip.id === inj.player_id);
        if (isTopAssist) offensiveImpact += 0.5;

        const playerRatings = side === 'home' ? 
            match.context?.player_ratings_home : 
            match.context?.player_ratings_away;
        
        const player = playerRatings?.find(p => p.id === inj.player_id);
        if (player && (player.position === 'Defender' || player.position === 'Goalkeeper')) {
            if (player.rating > 7.0) defensiveImpact++;
        }
    });

    return { offensive: offensiveImpact, defensive: defensiveImpact };
}

// ============================================================================
// CALCUL POISSON PRO
// ============================================================================

function calculatePoissonPro(hID, aID, hElo, aElo, tracker, match, metaHome, metaAway) {
    const minMatches = PARAMS.min_matches;
    
    if (tracker[hID].xg.length < minMatches || tracker[aID].xg.length < minMatches) {
        return null;
    }

    const allXG = [...tracker[hID].xg, ...tracker[aID].xg];
    const leagueAvgXG = allXG.reduce((a, b) => a + b, 0) / allXG.length;

    const attH = bayesianShrinkage(tracker[hID].xg, leagueAvgXG);
    const defA = bayesianShrinkage(tracker[aID].ga, leagueAvgXG);
    const attA = bayesianShrinkage(tracker[aID].xg, leagueAvgXG);
    const defH = bayesianShrinkage(tracker[hID].ga, leagueAvgXG);

    const pWinH = clubEloWinProb((hElo - aElo) + PARAMS.hfa);
    const pWinA = 1 - pWinH;

    let lh = (attH * 0.6 + defA * 0.4) * PARAMS.w_xg * Math.pow((pWinH / 0.5), PARAMS.w_elo);
    let la = (attA * 0.6 + defH * 0.4) * PARAMS.w_xg * Math.pow((pWinA / 0.5), PARAMS.w_elo);

    // AJUSTEMENT IMPACT PLAYERS
    if (match.context) {
        const impactH = detectImpactAbsences(match, metaHome, 'home');
        const impactA = detectImpactAbsences(match, metaAway, 'away');

        if (impactH.offensive > 0) {
            lh *= (1 - PARAMS.impact_offensive * impactH.offensive);
        }

        if (impactA.defensive > 0) {
            lh *= (1 + PARAMS.impact_defensive * impactA.defensive);
        }

        if (impactA.offensive > 0) {
            la *= (1 - PARAMS.impact_offensive * impactA.offensive);
        }

        if (impactH.defensive > 0) {
            la *= (1 + PARAMS.impact_defensive * impactH.defensive);
        }
    }

    lh = Math.max(lh, 0.01); 
    la = Math.max(la, 0.01);

    let pH = 0, pD = 0, pA = 0;
    let probBTTS = 0;
    let probOver25 = 0;
    let probUnder25 = 0;
    let bestProb = 0;
    let predictedScore = "0-0";

    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
            let corr = 1;
            if (i === 0 && j === 0) corr = 1 - (lh * la * PARAMS.rho);
            else if (i === 0 && j === 1) corr = 1 + (la * PARAMS.rho);
            else if (i === 1 && j === 0) corr = 1 + (lh * PARAMS.rho);
            else if (i === 1 && j === 1) corr = 1 - PARAMS.rho;

            const p = (Math.exp(-lh) * Math.pow(lh, i) / fact(i)) * 
                      (Math.exp(-la) * Math.pow(la, j) / fact(j)) * corr;

            if (p > bestProb) { 
                bestProb = p; 
                predictedScore = `${i}-${j}`; 
            }

            if (i > j) pH += p; 
            else if (i === j) pD += p; 
            else pA += p;

            if (i > 0 && j > 0) probBTTS += p;
            if (i + j > 2) probOver25 += p;
            if (i + j < 3) probUnder25 += p;
        }
    }

    return { 
        H: pH, D: pD, A: pA, 
        pred: predictedScore, 
        pScore: (bestProb * 100).toFixed(1),
        btts: (probBTTS * 100).toFixed(1),
        over25: (probOver25 * 100).toFixed(1),
        under25: (probUnder25 * 100).toFixed(1)
    };
}

// ============================================================================
// BACKTEST PRINCIPAL
// ============================================================================

function runBacktest() {
    let globalStats = { total: 0, sdmW: 0, scoreW: 0, bttsW: 0 };
    let globalBuckets = { 
        '90-100%': { m: 0, sdm: 0, score: 0 }, 
        '80-90%': { m: 0, sdm: 0, score: 0 }, 
        '70-80%': { m: 0, sdm: 0, score: 0 }, 
        '60-70%': { m: 0, sdm: 0, score: 0 }, 
        '50-60%': { m: 0, sdm: 0, score: 0 } 
    };
    let leagues = {};

    console.log('\n' + '='.repeat(70));
    console.log('🚀 BACKTEST SDM ULTRA - Impact Players Analysis');
    console.log('='.repeat(70));
    console.log(`📊 Paramètres : w_xg=${PARAMS.w_xg.toFixed(4)}, w_elo=${PARAMS.w_elo.toFixed(4)}`);
    console.log(`   Impact Offensive: ${PARAMS.impact_offensive.toFixed(4)}, Défensive: ${PARAMS.impact_defensive.toFixed(4)}`);
    console.log('='.repeat(70) + '\n');

    for (const lid of Object.keys(LEAGUES_CONFIG)) {
        const file = PATHS.history(lid);
        const metaFile = PATHS.meta(lid);
        
        if (!fs.existsSync(file)) {
            console.log(`⚠️  ${file} introuvable, skip.`);
            continue;
        }

        let meta = null;
        if (fs.existsSync(metaFile)) {
            meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
            console.log(`✅ Meta chargée pour Ligue ${lid}`);
        } else {
            console.log(`⚠️  Meta manquante pour Ligue ${lid}, Impact Players désactivé.`);
        }

        leagues[lid] = { 
            name: LEAGUES_CONFIG[lid].name, 
            total: 0, sdmW: 0, scoreW: 0, bttsW: 0,
            buckets: JSON.parse(JSON.stringify(globalBuckets)), 
            rounds: {} 
        };

        const history = JSON.parse(fs.readFileSync(file))
            .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
        
        let tracker = {};

        for (const m of history) {
            const rKey = m.league.round;
            const rIdx = parseInt(rKey.replace(/[^0-9]/g, '') || 0);
            const hID = m.teams.home.id; 
            const aID = m.teams.away.id;
            const hName = m.teams.home.name; 
            const aName = m.teams.away.name;

            if (!tracker[hID]) tracker[hID] = { xg: [], ga: [] };
            if (!tracker[aID]) tracker[aID] = { xg: [], ga: [] };

            if (tracker[hID].xg.length >= PARAMS.min_matches && 
                tracker[aID].xg.length >= PARAMS.min_matches) {
                
                const hElo = ELO_HISTORY[lid]?.[rKey]?.[hName] || 1500;
                const aElo = ELO_HISTORY[lid]?.[rKey]?.[aName] || 1500;

                const res = calculatePoissonPro(hID, aID, hElo, aElo, tracker, m, meta, meta);
                
                if (res) {
                    const actual = `${m.goals.home}-${m.goals.away}`;
                    let choice, sdmProb, isSdmOk;

                    if ((res.H + res.D) >= (res.A + res.D)) { 
                        choice = "1X"; 
                        sdmProb = res.H + res.D; 
                        isSdmOk = (m.goals.home >= m.goals.away); 
                    } else { 
                        choice = "X2"; 
                        sdmProb = res.A + res.D; 
                        isSdmOk = (m.goals.away >= m.goals.home); 
                    }
                    
                    const isScoreOk = (res.pred === actual);
                    const isBttsOk = (m.goals.home > 0 && m.goals.away > 0);
                    const bKey = getBucketKey(sdmProb);

                    if (bKey) {
                        if (!leagues[lid].rounds[rIdx]) leagues[lid].rounds[rIdx] = [];
                        leagues[lid].rounds[rIdx].push({
                            home: hName, away: aName, score: actual, pred: res.pred, choice,
                            prob: (sdmProb * 100).toFixed(1) + "%", 
                            sProb: res.pScore + "%",
                            btts: res.btts + "%",
                            over25: res.over25 + "%",
                            color: BUCKET_COLORS[bKey], 
                            isSdmOk, isScoreOk, isBttsOk
                        });

                        globalStats.total++; 
                        if (isSdmOk) globalStats.sdmW++; 
                        if (isScoreOk) globalStats.scoreW++;
                        if (isBttsOk) globalStats.bttsW++;
                        
                        globalBuckets[bKey].m++; 
                        if (isSdmOk) globalBuckets[bKey].sdm++; 
                        if (isScoreOk) globalBuckets[bKey].score++;

                        leagues[lid].total++; 
                        if (isSdmOk) leagues[lid].sdmW++; 
                        if (isScoreOk) leagues[lid].scoreW++;
                        if (isBttsOk) leagues[lid].bttsW++;
                        
                        leagues[lid].buckets[bKey].m++; 
                        if (isSdmOk) leagues[lid].buckets[bKey].sdm++; 
                        if (isScoreOk) leagues[lid].buckets[bKey].score++;
                    }
                }
            }

            if (m.stats?.home && m.goals.home !== null) {
                tracker[hID].xg.push(parseFloat(m.stats.home.expected_goals || 0)); 
                tracker[hID].ga.push(m.goals.away);
                tracker[aID].xg.push(parseFloat(m.stats.away.expected_goals || 0)); 
                tracker[aID].ga.push(m.goals.home);
            }
        }
    }

    console.log("\n" + "=".repeat(70));
    console.log("📊 RÉSULTATS GLOBAUX");
    console.log("=".repeat(70));
    console.log(`Total Prédictions : ${globalStats.total}`);
    console.log(`Précision SDM     : ${globalStats.sdmW}/${globalStats.total} (${(globalStats.sdmW / globalStats.total * 100).toFixed(2)}%)`);
    console.log(`Précision Score   : ${globalStats.scoreW}/${globalStats.total} (${(globalStats.scoreW / globalStats.total * 100).toFixed(2)}%)`);
    console.log(`Précision BTTS    : ${globalStats.bttsW}/${globalStats.total} (${(globalStats.bttsW / globalStats.total * 100).toFixed(2)}%)`);
    console.log("=".repeat(70) + "\n");

    // Sauvegarder les résultats
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const resultsFile = `${PATHS.results}backtest_${timestamp}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        params: PARAMS,
        globalStats,
        globalBuckets,
        leagues
    }, null, 2));
    console.log(`💾 Résultats sauvegardés : ${resultsFile}\n`);

    startServer(globalBuckets, leagues, globalStats);
}

function getBucketKey(p) {
    if (p >= 0.9) return '90-100%'; 
    if (p >= 0.8) return '80-90%';
    if (p >= 0.7) return '70-80%'; 
    if (p >= 0.6) return '60-70%';
    if (p >= 0.5) return '50-60%'; 
    return null;
}

// ============================================================================
// SERVEUR WEB
// ============================================================================

function startServer(global, leagues, stats) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>SDM Ultra - Quantum Analysis</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { background: #0f172a; color: white; font-family: 'Inter', -apple-system, sans-serif; padding: 30px; }
            .container { max-width: 1600px; margin: auto; }
            h1 { color: #38bdf8; border-left: 5px solid #38bdf8; padding-left: 15px; margin-bottom: 30px; }
            .kpi-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 30px 0; }
            .card { background: #1e293b; padding: 20px; border-radius: 12px; text-align: center; border: 1px solid #334155; position: relative; }
            .card::after { content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: currentColor; }
            .card .val { font-size: 2.5em; font-weight: 800; margin: 10px 0; }
            .card .sub { font-size: 0.85em; color: #64748b; margin-top: 5px; }
            .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; margin-bottom: 50px; }
            .league-mini { background: #1e293b; padding: 18px; border-radius: 12px; border: 1px solid #334155; }
            .league-header { display: flex; justify-content: space-between; border-bottom: 1px solid #334155; padding-bottom: 10px; margin-bottom: 12px; }
            .badge { padding: 5px 10px; border-radius: 6px; font-weight: bold; font-size: 0.85em; background: #334155; }
            .round-box { background: #1e293b; border-radius: 12px; padding: 25px; margin-bottom: 35px; border: 1px solid #334155; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th { text-align: left; color: #64748b; font-size: 0.8em; text-transform: uppercase; padding: 12px; border-bottom: 2px solid #0f172a; }
            td { padding: 12px; border-bottom: 1px solid #334155; font-size: 0.9em; }
            .win { color: #4ade80; font-weight: bold; }
            .loss { color: #ef4444; }
            .score-exact { background: #38bdf8; color: #000; padding: 3px 8px; border-radius: 5px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 SDM ULTRA - Impact Players Analysis</h1>
            
            <div class="kpi-row">
                ${Object.entries(global).map(([k, v]) => `
                    <div class="card" style="color: ${BUCKET_COLORS[k]}">
                        <div style="font-size:0.75em; text-transform:uppercase; letter-spacing:1px">Tranche ${k}</div>
                        <div class="val">${v.m > 0 ? (v.sdm / v.m * 100).toFixed(1) : '0.0'}%</div>
                        <div class="sub">🎯 ${v.sdm}/${v.m} paris réussis | Score Exact: ${v.score}/${v.m}</div>
                    </div>
                `).join('')}
            </div>

            <div class="summary-grid">
                ${Object.values(leagues).map(l => `
                    <div class="league-mini">
                        <div class="league-header">
                            <span style="font-weight:bold; color:#38bdf8; font-size:1.05em">${l.name}</span>
                            <span class="badge" style="color:#4ade80">${(l.sdmW / (l.total || 1) * 100).toFixed(1)}%</span>
                        </div>
                        <div style="font-size:0.8em; color:#94a3b8; margin-bottom:12px">
                            📊 SDM: ${l.sdmW}/${l.total} | Score: ${l.scoreW}/${l.total} | BTTS: ${l.bttsW}/${l.total}
                        </div>
                        ${Object.entries(l.buckets).reverse().map(([k, v]) => `
                            <div style="display:flex; justify-content:space-between; font-size:0.82em; padding:4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                                <span style="color:${BUCKET_COLORS[k]}">${k}</span>
                                <span>${v.m > 0 ? (v.sdm/v.m*100).toFixed(0)+'%' : '--'} <small style="color:#64748b">(${v.score}🎯)</small></span>
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            </div>

            ${Object.values(leagues).map(l => `
                <div class="round-box">
                    <h2 style="margin:0 0 20px 0; font-size:1.3em; color:#38bdf8">⚽ ${l.name} - Logs Détaillés</h2>
                    ${Object.entries(l.rounds).sort((a,b)=>a[0]-b[0]).map(([r, ms]) => `
                        <div style="margin-top:25px; font-weight:bold; color:#94a3b8; font-size:0.9em; padding:8px; background:#0f172a; border-radius:6px">
                            📅 JOURNÉE ${r}
                        </div>
                        <table>
                            <tr>
                                <th>Match</th>
                                <th>Score</th>
                                <th>Pari SDM</th>
                                <th>Confiance</th>
                                <th>Pred Score</th>
                                <th>BTTS</th>
                                <th>Over 2.5</th>
                                <th>Résultat</th>
                            </tr>
                            ${ms.map(m => `
                                <tr>
                                    <td style="font-weight:500">${m.home} vs ${m.away}</td>
                                    <td><span style="background:#0f172a; padding:4px 10px; border-radius:5px; font-weight:bold">${m.score}</span></td>
                                    <td><span class="badge">${m.choice}</span></td>
                                    <td><span style="padding:5px 10px; border-radius:6px; background:${m.color}; color:#000; font-weight:bold">${m.prob}</span></td>
                                    <td><span class="${m.isScoreOk ? 'score-exact' : ''}">${m.pred}</span> <small style="color:#64748b">(${m.sProb})</small></td>
                                    <td style="color:#94a3b8">${m.btts}</td>
                                    <td style="color:#94a3b8">${m.over25}</td>
                                    <td class="${m.isSdmOk ? 'win' : 'loss'}">${m.isScoreOk ? '🎯 EXACT' : (m.isSdmOk ? '✅ SDM' : '❌ FAIL')}</td>
                                </tr>
                            `).join('')}
                        </table>
                    `).join('')}
                </div>
            `).join('')}
        </div>
    </body>
    </html>`;

    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }).listen(PORT, () => console.log(`\n✅ DASHBOARD : http://localhost:${PORT}\n`));
}

runBacktest();