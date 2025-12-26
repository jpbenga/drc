const fs = require('fs');
const http = require('http');
const PORT = 3000;

// PARAMÈTRES OPTIMISÉS
const PARAMS = {
    w_xg: 0.6439,
    w_elo: 1.9255,
    rho: -0.0529,
    hfa: 34.4303,
    window: 8
};

const ELO_HISTORY = JSON.parse(fs.readFileSync('./elo_history_archive.json', 'utf8'));

const LEAGUES_CONFIG = {
    '39': { name: "Premier League" }, '61': { name: "Ligue 1" }, '78': { name: "Bundesliga" },
    '140': { name: "La Liga" }, '135': { name: "Serie A" }, '94': { name: "Liga Portugal" },
    '88': { name: "Eredivisie" }, '197': { name: "Super League (GRE)" }, '203': { name: "Süper Lig" }
};

const BUCKET_COLORS = { '90-100%': '#fbbf24', '80-90%': '#10b981', '70-80%': '#0ea5e9', '60-70%': '#f59e0b', '50-60%': '#94a3b8' };

function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
function clubEloWinProb(deltaElo) { return 1 / (Math.pow(10, -deltaElo / 400) + 1); }

function calculatePoissonPro(hID, aID, hElo, aElo, tracker) {
    const w = PARAMS.window;
    const attH = tracker[hID].xg.slice(-w).reduce((a, b) => a + b, 0) / w;
    const defA = tracker[aID].ga.slice(-w).reduce((a, b) => a + b, 0) / w;
    const attA = tracker[aID].xg.slice(-w).reduce((a, b) => a + b, 0) / w;
    const defH = tracker[hID].ga.slice(-w).reduce((a, b) => a + b, 0) / w;

    const pWinH = clubEloWinProb((hElo - aElo) + PARAMS.hfa);
    const pWinA = 1 - pWinH;

    let lh = (attH * 0.6 + defA * 0.4) * PARAMS.w_xg * Math.pow((pWinH / 0.5), PARAMS.w_elo);
    let la = (attA * 0.6 + defH * 0.4) * PARAMS.w_xg * Math.pow((pWinA / 0.5), PARAMS.w_elo);
    lh = Math.max(lh, 0.01); la = Math.max(la, 0.01);

    let pH = 0, pD = 0, pA = 0;
    let bestProb = 0;
    let predictedScore = "0-0";

    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
            let corr = 1;
            if (i === 0 && j === 0) corr = 1 - (lh * la * PARAMS.rho);
            else if (i === 0 && j === 1) corr = 1 + (la * PARAMS.rho);
            else if (i === 1 && j === 0) corr = 1 + (lh * PARAMS.rho);
            else if (i === 1 && j === 1) corr = 1 - PARAMS.rho;

            const p = (Math.exp(-lh) * Math.pow(lh, i) / fact(i)) * (Math.exp(-la) * Math.pow(la, j) / fact(j)) * corr;
            if (p > bestProb) { bestProb = p; predictedScore = `${i}-${j}`; }
            if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
        }
    }
    return { H: pH, D: pD, A: pA, pred: predictedScore, pScore: (bestProb * 100).toFixed(1) };
}

function runBacktest() {
    let globalStats = { total: 0, sdmW: 0, scoreW: 0 };
    let globalBuckets = { '90-100%': { m: 0, sdm: 0, score: 0 }, '80-90%': { m: 0, sdm: 0, score: 0 }, '70-80%': { m: 0, sdm: 0, score: 0 }, '60-70%': { m: 0, sdm: 0, score: 0 }, '50-60%': { m: 0, sdm: 0, score: 0 } };
    let leagues = {};

    for (const lid of Object.keys(LEAGUES_CONFIG)) {
        const file = `history_${lid}.json`;
        if (!fs.existsSync(file)) continue;

        leagues[lid] = { name: LEAGUES_CONFIG[lid].name, total: 0, sdmW: 0, scoreW: 0, buckets: JSON.parse(JSON.stringify(globalBuckets)), rounds: {} };
        const history = JSON.parse(fs.readFileSync(file)).sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
        let tracker = {};

        for (const m of history) {
            const rKey = m.league.round;
            const rIdx = parseInt(rKey.replace(/[^0-9]/g, '') || 0);
            const hID = m.teams.home.id; const aID = m.teams.away.id;
            const hName = m.teams.home.name; const aName = m.teams.away.name;

            if (!tracker[hID]) tracker[hID] = { xg: [], ga: [] };
            if (!tracker[aID]) tracker[aID] = { xg: [], ga: [] };

            if (tracker[hID].xg.length >= PARAMS.window && tracker[aID].xg.length >= PARAMS.window) {
                const hElo = ELO_HISTORY[lid]?.[rKey]?.[hName] || 1500;
                const aElo = ELO_HISTORY[lid]?.[rKey]?.[aName] || 1500;

                const res = calculatePoissonPro(hID, aID, hElo, aElo, tracker);
                const actual = `${m.goals.home}-${m.goals.away}`;
                let choice, sdmProb, isSdmOk;

                if ((res.H + res.D) >= (res.A + res.D)) { choice = "1X"; sdmProb = res.H + res.D; isSdmOk = (m.goals.home >= m.goals.away); }
                else { choice = "X2"; sdmProb = res.A + res.D; isSdmOk = (m.goals.away >= m.goals.home); }
                
                const isScoreOk = (res.pred === actual);
                const bKey = getBucketKey(sdmProb);

                if (bKey) {
                    if (!leagues[lid].rounds[rIdx]) leagues[lid].rounds[rIdx] = [];
                    leagues[lid].rounds[rIdx].push({
                        home: hName, away: aName, score: actual, pred: res.pred, choice,
                        prob: (sdmProb * 100).toFixed(1) + "%", sProb: res.pScore + "%",
                        color: BUCKET_COLORS[bKey], isSdmOk, isScoreOk
                    });
                    // Maj Global
                    globalStats.total++; if (isSdmOk) globalStats.sdmW++; if (isScoreOk) globalStats.scoreW++;
                    globalBuckets[bKey].m++; if (isSdmOk) globalBuckets[bKey].sdm++; if (isScoreOk) globalBuckets[bKey].score++;
                    // Maj Ligue
                    leagues[lid].total++; if (isSdmOk) leagues[lid].sdmW++; if (isScoreOk) leagues[lid].scoreW++;
                    leagues[lid].buckets[bKey].m++; if (isSdmOk) leagues[lid].buckets[bKey].sdm++; if (isScoreOk) leagues[lid].buckets[bKey].score++;
                }
            }
            if (m.stats?.home && m.goals.home !== null) {
                tracker[hID].xg.push(parseFloat(m.stats.home.expected_goals || 0)); tracker[hID].ga.push(m.goals.away);
                tracker[aID].xg.push(parseFloat(m.stats.away.expected_goals || 0)); tracker[aID].ga.push(m.goals.home);
            }
        }
    }
    startServer(globalBuckets, leagues, globalStats);
}

function getBucketKey(p) {
    if (p >= 0.9) return '90-100%'; if (p >= 0.8) return '80-90%';
    if (p >= 0.7) return '70-80%'; if (p >= 0.6) return '60-70%';
    if (p >= 0.5) return '50-60%'; return null;
}

function startServer(global, leagues, stats) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>SDM Expert - Quantum Score Bilan</title>
        <style>
            body { background: #0f172a; color: white; font-family: 'Inter', sans-serif; padding: 30px; margin: 0; }
            .container { max-width: 1400px; margin: auto; }
            h1 { color: #38bdf8; border-left: 5px solid #38bdf8; padding-left: 15px; }
            .kpi-row { display: flex; justify-content: space-between; gap: 15px; margin: 30px 0; }
            .card { background: #1e293b; padding: 20px; border-radius: 12px; flex: 1; text-align: center; border: 1px solid #334155; position: relative; overflow: hidden; }
            .card::after { content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: currentColor; }
            .card .val { font-size: 2em; font-weight: 800; margin: 5px 0; }
            .card .sub { font-size: 0.8em; color: #64748b; }
            .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; margin-bottom: 50px; }
            .league-mini { background: #1e293b; padding: 15px; border-radius: 12px; border: 1px solid #334155; }
            .league-header { display: flex; justify-content: space-between; border-bottom: 1px solid #334155; padding-bottom: 8px; margin-bottom: 10px; }
            .round-box { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 30px; border: 1px solid #334155; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th { text-align: left; color: #64748b; font-size: 0.8em; text-transform: uppercase; padding: 10px; border-bottom: 2px solid #0f172a; }
            td { padding: 10px; border-bottom: 1px solid #334155; font-size: 0.9em; }
            .badge { padding: 4px 8px; border-radius: 6px; font-weight: bold; font-size: 0.8em; background: #334155; }
            .win { color: #4ade80; font-weight: bold; }
            .loss { color: #ef4444; }
            .score-exact { background: #38bdf8; color: #000; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🏆 BILAN SDM EXCELLENCE & SCORES (Quantum Elo)</h1>
            
            <div class="kpi-row">
                ${Object.entries(global).map(([k, v]) => `
                    <div class="card" style="color: ${BUCKET_COLORS[k]}">
                        <div style="font-size:0.7em; text-transform:uppercase">Tranche ${k}</div>
                        <div class="val">${v.m > 0 ? (v.sdm / v.m * 100).toFixed(1) : '0.0'}%</div>
                        <div class="sub">🎯 Score: ${(v.score / (v.m || 1) * 100).toFixed(1)}% (${v.score}/${v.m})</div>
                    </div>
                `).join('')}
            </div>

            <div class="summary-grid">
                ${Object.values(leagues).map(l => `
                    <div class="league-mini">
                        <div class="league-header">
                            <span style="font-weight:bold; color:#38bdf8">${l.name}</span>
                            <span class="badge" style="color:#4ade80">${(l.sdmW / (l.total || 1) * 100).toFixed(1)}%</span>
                        </div>
                        <div style="font-size:0.75em; color:#64748b; margin-bottom:10px">Précision Scores: ${(l.scoreW / (l.total || 1) * 100).toFixed(1)}%</div>
                        ${Object.entries(l.buckets).reverse().map(([k, v]) => `
                            <div style="display:flex; justify-content:space-between; font-size:0.8em; padding:3px 0; border-bottom: 1px solid rgba(255,255,255,0.03);">
                                <span style="color:${BUCKET_COLORS[k]}">${k}</span>
                                <span>${v.m > 0 ? (v.sdm/v.m*100).toFixed(0)+'%' : '--'} <small>(${v.score}🎯)</small></span>
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            </div>

            ${Object.values(leagues).map(l => `
                <div class="round-box">
                    <h2 style="margin:0; font-size:1.2em; color:#38bdf8">⚽ LOGS : ${l.name}</h2>
                    ${Object.entries(l.rounds).sort((a,b)=>a[0]-b[0]).map(([r, ms]) => `
                        <div style="margin-top:20px; font-weight:bold; color:#94a3b8; font-size:0.85em;">JOURNÉE ${r}</div>
                        <table>
                            <tr><th>Match</th><th>Score</th><th>Pari</th><th>Confiance</th><th>Pred Score</th><th>Bilan</th></tr>
                            ${ms.map(m => `
                                <tr>
                                    <td>${m.home} vs ${m.away}</td>
                                    <td><span style="background:#0f172a; padding:2px 6px; border-radius:4px;">${m.score}</span></td>
                                    <td><span class="badge">${m.choice}</span></td>
                                    <td><span style="padding:3px 8px; border-radius:4px; background:${m.color}; color:#000; font-weight:bold;">${m.prob}</span></td>
                                    <td><span class="${m.isScoreOk ? 'score-exact' : ''}">${m.pred}</span> <small style="color:#64748b">(${m.sProb})</small></td>
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
    }).listen(PORT, () => console.log(`✅ DASHBOARD COMPLET : http://localhost:${PORT}`));
}

runBacktest();