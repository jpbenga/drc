const fs = require('fs');
const http = require('http');

const PORT = 3000;

// PARAMÈTRES RÉÉQUILIBRÉS (À mettre à jour via les résultats d'Optuna)
const PARAMS = {
    w_xg: 0.85,    // Poids des Expected Goals
    w_rank: 0.15,  // Poids du classement
    rho: 0.05,     // Ajustement Dixon-Coles
    window: 6      // Fenêtre glissante
};

const LEAGUES_CONFIG = {
    '39': { name: "Premier League", size: 20 },
    '61': { name: "Ligue 1", size: 18 },
    '78': { name: "Bundesliga", size: 18 },
    '140': { name: "La Liga", size: 20 },
    '135': { name: "Serie A", size: 20 },
    '94': { name: "Liga Portugal", size: 18 },
    '88': { name: "Eredivisie", size: 18 },
    '197': { name: "Super League (GRE)", size: 14 },
    '203': { name: "Süper Lig", size: 19 }
};

const BUCKET_COLORS = {
    '90-100%': '#fbbf24', '80-90%': '#10b981', '70-80%': '#0ea5e9', '60-70%': '#f59e0b', '50-60%': '#94a3b8'
};

function fact(n) { return n <= 1 ? 1 : n * fact(n-1); }

function calculatePoissonPro(hID, aID, standings, tracker, size) {
    const w = PARAMS.window;
    const attH = tracker[hID].xg.slice(-w).reduce((a,b)=>a+b,0)/w;
    const defA = tracker[aID].ga.slice(-w).reduce((a,b)=>a+b,0)/w;
    const attA = tracker[aID].xg.slice(-w).reduce((a,b)=>a+b,0)/w;
    const defH = tracker[hID].ga.slice(-w).reduce((a,b)=>a+b,0)/w;

    const lh = Math.max((attH * 0.6 + defA * 0.4) * PARAMS.w_xg, 0.01);
    const la = Math.max((attA * 0.6 + defH * 0.4) * PARAMS.w_xg, 0.01);

    let pH = 0, pD = 0, pA = 0;
    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
            let corr = 1; // Correction Dixon-Coles
            if (i === 0 && j === 0) corr = 1 - (lh * la * PARAMS.rho);
            else if (i === 0 && j === 1) corr = 1 + (la * PARAMS.rho);
            else if (i === 1 && j === 0) corr = 1 + (lh * PARAMS.rho);
            else if (i === 1 && j === 1) corr = 1 - PARAMS.rho;

            const p = (Math.exp(-lh) * Math.pow(lh, i) / fact(i)) * (Math.exp(-la) * Math.pow(la, j) / fact(j)) * corr;
            if (i > j) pH += p; else if (i === j) pD += p; else pA += p;
        }
    }
    return { H: pH, D: pD, A: pA };
}

function runBacktest() {
    let globalBuckets = { '90-100%': {m:0,w:0}, '80-90%': {m:0,w:0}, '70-80%': {m:0,w:0}, '60-70%': {m:0,w:0}, '50-60%': {m:0,w:0} };
    let leagueData = {}; 

    for (const [id, config] of Object.entries(LEAGUES_CONFIG)) {
        const hFile = `history_${id}.json`;
        if (!fs.existsSync(hFile)) continue;

        leagueData[id] = { name: config.name, buckets: JSON.parse(JSON.stringify(globalBuckets)), total: 0, wins: 0, rounds: {} };
        const history = JSON.parse(fs.readFileSync(hFile)).sort((a,b) => new Date(a.fixture.date) - new Date(b.fixture.date));

        let standings = {}; let tracker = {};

        for (const m of history) {
            const r = parseInt(m.league.round.replace(/[^0-9]/g, '') || 0);
            const hID = m.teams.home.id; const aID = m.teams.away.id;

            if (!standings[hID]) standings[hID] = { id: hID, pts: 0, gf: 0, ga: 0 };
            if (!standings[aID]) standings[aID] = { id: aID, pts: 0, gf: 0, ga: 0 };
            if (!tracker[hID]) tracker[hID] = { xg: [], ga: [] };
            if (!tracker[aID]) tracker[aID] = { xg: [], ga: [] };

            if (tracker[hID].xg.length >= PARAMS.window) {
                const outcomes = calculatePoissonPro(hID, aID, standings, tracker, config.size);
                
                let choice, prob, isCorrect;
                // Logique Double Chance (Favori ne perd pas)
                if ((outcomes.H + outcomes.D) >= (outcomes.A + outcomes.D)) {
                    choice = "1X"; prob = outcomes.H + outcomes.D;
                    isCorrect = (m.goals.home >= m.goals.away);
                } else {
                    choice = "X2"; prob = outcomes.A + outcomes.D;
                    isCorrect = (m.goals.away >= m.goals.home);
                }

                const bKey = getBucketKey(prob);
                if (bKey) {
                    if (!leagueData[id].rounds[r]) leagueData[id].rounds[r] = [];
                    leagueData[id].rounds[r].push({
                        home: m.teams.home.name, away: m.teams.away.name,
                        score: `${m.goals.home}-${m.goals.away}`,
                        prob: (prob * 100).toFixed(1) + "%",
                        drawProb: (outcomes.D * 100).toFixed(1) + "%",
                        color: BUCKET_COLORS[bKey],
                        choice: choice,
                        isCorrect: isCorrect
                    });
                    globalBuckets[bKey].m++; if(isCorrect) globalBuckets[bKey].w++;
                    leagueData[id].buckets[bKey].m++; if(isCorrect) leagueData[id].buckets[bKey].w++;
                    leagueData[id].total++; if(isCorrect) leagueData[id].wins++;
                }
            }
            updateData(standings, m, tracker);
        }
    }
    startServer(globalBuckets, leagueData);
}

function updateData(standings, m, tracker) {
    const hID = m.teams.home.id; const aID = m.teams.away.id;
    standings[hID].gf += m.goals.home; standings[hID].ga += m.goals.away;
    standings[aID].gf += m.goals.away; standings[aID].ga += m.goals.home;
    if (m.stats) {
        tracker[hID].xg.push(parseFloat(m.stats.home.expected_goals || 0));
        tracker[hID].ga.push(m.goals.away);
        tracker[aID].xg.push(parseFloat(m.stats.away.expected_goals || 0));
        tracker[aID].ga.push(m.goals.home);
    }
}

function getBucketKey(p) {
    if (p >= 0.9) return '90-100%'; if (p >= 0.8) return '80-90%';
    if (p >= 0.7) return '70-80%'; if (p >= 0.6) return '60-70%';
    if (p >= 0.5) return '50-60%'; return null;
}

function startServer(global, leagues) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>SDM Expert Dashboard</title>
        <style>
            body { background: #0f172a; color: white; font-family: 'Inter', sans-serif; padding: 30px; }
            .container { max-width: 1400px; margin: auto; }
            h1 { color: #38bdf8; font-size: 2em; border-left: 5px solid #38bdf8; padding-left: 15px; margin-bottom: 30px; }
            .kpi-row { display: flex; justify-content: space-between; gap: 15px; margin-bottom: 40px; }
            .card { background: #1e293b; padding: 20px; border-radius: 12px; flex: 1; text-align: center; border: 1px solid #334155; position: relative; overflow: hidden; }
            .card::after { content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 4px; background: currentColor; }
            .card .val { font-size: 2.2em; font-weight: 800; margin: 10px 0; }
            .card .label { color: #94a3b8; text-transform: uppercase; font-size: 0.75em; letter-spacing: 1px; }
            .summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; margin-bottom: 50px; }
            .league-mini { background: #1e293b; padding: 20px; border-radius: 12px; border: 1px solid #334155; }
            .league-header { display: flex; justify-content: space-between; border-bottom: 1px solid #334155; padding-bottom: 10px; margin-bottom: 10px; }
            .round-box { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 30px; border: 1px solid #334155; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th { text-align: left; color: #64748b; font-size: 0.8em; text-transform: uppercase; padding: 12px; border-bottom: 2px solid #0f172a; }
            td { padding: 12px; border-bottom: 1px solid #334155; font-size: 0.9em; }
            .badge { padding: 4px 10px; border-radius: 6px; font-weight: bold; font-size: 0.8em; }
            .win-icon { color: #4ade80; font-weight: bold; }
            .loss-icon { color: #ef4444; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🏆 BILAN SDM EXCELLENCE (Optimisé Poisson)</h1>
            <div class="kpi-row">
                ${Object.entries(global).map(([k, v]) => `
                    <div class="card" style="color: ${BUCKET_COLORS[k]}">
                        <div class="label">Tranche ${k}</div>
                        <div class="val">${v.m > 0 ? (v.w/v.m*100).toFixed(1) : '0.0'}%</div>
                        <div style="font-size:0.8em; color:#64748b">${v.w} / ${v.m} succès</div>
                    </div>
                `).join('')}
            </div>
            <div class="summary-grid">
                ${Object.values(leagues).map(l => `
                    <div class="league-mini">
                        <div class="league-header">
                            <span style="font-weight:bold; color:#38bdf8">${l.name}</span>
                            <span class="badge" style="background:#334155; color:#4ade80">${(l.wins/(l.total||1)*100).toFixed(1)}%</span>
                        </div>
                        ${Object.entries(l.buckets).reverse().map(([k, v]) => `
                            <div style="display:flex; justify-content:space-between; font-size:0.85em; padding:5px 0; border-bottom: 1px solid rgba(255,255,255,0.03);">
                                <span style="color:${BUCKET_COLORS[k]}">${k}</span>
                                <span>${v.m > 0 ? (v.w/v.m*100).toFixed(1) + '%' : '--'} (${v.w}/${v.m})</span>
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            </div>
            ${Object.values(leagues).map(l => `
                <div class="round-box">
                    <h2 style="margin:0; font-size:1.2em; color:#38bdf8">⚽ MATCH LOGS : ${l.name}</h2>
                    ${Object.entries(l.rounds).sort((a,b)=>a[0]-b[0]).map(([r, matches]) => `
                        <div style="margin-top:25px; font-weight:bold; color:#94a3b8; font-size:0.9em; border-left:3px solid #334155; padding-left:10px;">JOURNÉE ${r}</div>
                        <table>
                            <tr><th>Match</th><th>Score</th><th>Pronostic</th><th>Confiance</th><th>Nul</th><th>Résultat</th></tr>
                            ${matches.map(m => `
                                <tr>
                                    <td>${m.home} vs ${m.away}</td>
                                    <td>${m.score}</td>
                                    <td><span class="badge" style="background:#334155">${m.choice}</span></td>
                                    <td><span style="color:${m.color}; font-weight:bold;">${m.prob}</span></td>
                                    <td style="color:#64748b">${m.drawProb}</td>
                                    <td class="${m.isCorrect ? 'win-icon' : 'loss-icon'}">${m.isCorrect ? '✅ SUCCÈS' : '❌ ÉCHEC'}</td>
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
    }).listen(PORT, () => console.log(`✅ INTERFACE ACTIVE : http://localhost:${PORT}`));
}

runBacktest();