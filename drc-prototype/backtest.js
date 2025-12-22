const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// =================================================================
// ⚙️ CONFIGURATION DU BACKTEST
// =================================================================
const PORT = 3000;
const SIMULATED_DATE = new Date('2025-12-21T18:00:00');

const LEAGUES = [
    { id: 39, name: "Premier League" }, { id: 61, name: "Ligue 1" }, { id: 140, name: "La Liga" },
    { id: 78, name: "Bundesliga" }, { id: 135, name: "Serie A" }, { id: 94, name: "Liga Portugal" },
    { id: 88, name: "Eredivisie" }, { id: 144, name: "Jupiler Pro" }, { id: 179, name: "Premiership" },
    { id: 203, name: "Süper Lig" }, { id: 197, name: "Super League (GRE)" }, { id: 119, name: "Superliga (DAN)" },
    { id: 207, name: "Super League (SUI)" }, { id: 218, name: "Bundesliga (AUT)" }, { id: 40, name: "Championship" },
    { id: 62, name: "Ligue 2" }, { id: 136, name: "Serie B" }, { id: 79, name: "2. Bundesliga" },
    { id: 141, name: "La Liga 2" }, { id: 106, name: "Ekstraklasa" }, { id: 210, name: "HNL" },
    { id: 283, name: "Liga I" }, { id: 253, name: "MLS" },
    { id: 71, name: "Brasileiro A" }, { id: 128, name: "Liga Prof" }, { id: 262, name: "Liga MX" },
    { id: 307, name: "Saudi Pro" }, { id: 98, name: "J1 League" }, { id: 188, name: "A-League" }
];

function runBacktest() {
    let globalStats = { 
        win: 0, loss: 0, 
        SUPREME: { win: 0, loss: 0 }, SOLID: { win: 0, loss: 0 }, 
        VALUE: { win: 0, loss: 0 }, FAIBLE: { win: 0, loss: 0 } 
    };
    let leagueReports = [];

    LEAGUES.forEach(league => {
        const hFile = `history_${league.id}.json`;
        if (!fs.existsSync(hFile)) return;

        let history = JSON.parse(fs.readFileSync(hFile));
        history.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

        let snapshots = {}; let currentStandings = {}; let nameToId = {};
        let leagueMatches = [];
        let leagueStats = { 
            win: 0, loss: 0, 
            SUPREME: { win: 0, loss: 0 }, SOLID: { win: 0, loss: 0 }, 
            VALUE: { win: 0, loss: 0 }, FAIBLE: { win: 0, loss: 0 }
        };

        history.forEach(m => {
            nameToId[m.teams.home.name] = m.teams.home.id;
            nameToId[m.teams.away.name] = m.teams.away.id;
        });

        history.forEach(m => {
            const date = new Date(m.fixture.date);
            if (date > SIMULATED_DATE) return;
            const round = parseInt(m.league.round.replace(/[^0-9]/g, '') || 0);
            const hId = m.teams.home.id; const aId = m.teams.away.id;

            if (round >= 6 && snapshots[round - 1] && snapshots[round - 5]) {
                const sdmVal = calculateSDM(m.teams.home.name, m.teams.away.name, snapshots, round - 1, nameToId);
                if (sdmVal !== null) {
                    const absSdm = Math.abs(sdmVal);
                    let tier = absSdm >= 15 ? 'SUPREME' : (absSdm >= 10 ? 'SOLID' : (absSdm >= 5 ? 'VALUE' : 'FAIBLE'));
                    const pred = sdmVal > 0 ? 'Home' : 'Away';
                    const actual = m.goals.home > m.goals.away ? 'Home' : (m.goals.away > m.goals.home ? 'Away' : 'Draw');
                    const isWin = (pred === actual);

                    leagueMatches.push({ round, date: m.fixture.date, match: `${m.teams.home.name} vs ${m.teams.away.name}`, sdm: absSdm.toFixed(1), tier, pred, result: `${m.goals.home}-${m.goals.away}`, status: isWin ? 'WON' : 'LOST' });
                    leagueStats[isWin ? 'win' : 'loss']++; leagueStats[tier][isWin ? 'win' : 'loss']++;
                    globalStats[isWin ? 'win' : 'loss']++; globalStats[tier][isWin ? 'win' : 'loss']++;
                }
            }
            if (!currentStandings[hId]) currentStandings[hId] = { id: hId, pts: 0, gf: 0, ga: 0 };
            if (!currentStandings[aId]) currentStandings[aId] = { id: aId, pts: 0, gf: 0, ga: 0 };
            let ph = 3, pa = 0; if (m.goals.home === m.goals.away) { ph = 1; pa = 1; } else if (m.goals.home < m.goals.away) { ph = 0; pa = 3; }
            currentStandings[hId].pts += ph; currentStandings[hId].gf += m.goals.home; currentStandings[hId].ga += m.goals.away;
            currentStandings[aId].pts += pa; currentStandings[aId].gf += m.goals.away; currentStandings[aId].ga += m.goals.home;
            snapshots[round] = JSON.parse(JSON.stringify(currentStandings));
        });

        if (leagueMatches.length > 0) leagueReports.push({ name: league.name, stats: leagueStats, matches: leagueMatches });
    });

    startServer(globalStats, leagueReports);
}

function calculateSDM(hName, aName, snapshots, lastRound, dict) {
    const hID = dict[hName]; const aID = dict[aName];
    if (!hID || !aID) return null;
    const getRank = (r, id) => {
        if (!snapshots[r]) return 15;
        const s = Object.values(snapshots[r]).sort((a, b) => (b.pts - a.pts) || ((b.gf - b.ga) - (a.gf - a.ga)));
        const rk = s.findIndex(t => t.id === id) + 1;
        return rk > 0 ? rk : 15;
    };
    const rH = getRank(lastRound, hID); const rA = getRank(lastRound, aID);
    const vH = (getRank(lastRound - 5, hID) - rH) / 5;
    const vA = (getRank(lastRound - 5, aID) - rA) / 5;
    return (rA - vA * 1.2) - (rH - vH * 1.2);
}

function generateHTML(globalStats, reports) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    const rate = (s) => (s.win + s.loss > 0) ? ((s.win / (s.win + s.loss)) * 100).toFixed(1) : "0.0";
    const detail = (s) => `${rate(s)}% (${s.win}W/${s.loss}L)`;

    let html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Backtest Stratégique SDM</title>
        <style>
            body { background: #0f172a; color: #f1f5f9; font-family: sans-serif; padding: 20px; max-width: 1400px; margin: 0 auto; }
            .section-title { font-weight: 900; font-size: 1.4em; color: ${cGold}; text-transform: uppercase; margin: 40px 0 15px 0; display: flex; align-items: center; }
            .section-title::before { content: ""; width: 4px; height: 24px; background: ${cGold}; margin-right: 12px; border-radius: 2px; }
            
            .kpi-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 30px; }
            .kpi-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 15px; text-align: center; }
            
            .bilan-table, .match-table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 40px; border: 1px solid #334155; }
            th { text-align: left; padding: 12px; background: #020617; color: ${cMuted}; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.5px; }
            td { padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 0.9em; }
            
            .league-section { margin-bottom: 100px; }
            .league-banner { background: #020617; padding: 20px; border-radius: 8px 8px 0 0; border: 1px solid #334155; border-bottom: none; }
            .round-separator { background: #334155; color: #fff; padding: 8px 15px; font-weight: 900; font-size: 0.85em; text-transform: uppercase; }
            
            .badge { padding: 2px 6px; border-radius: 4px; font-size: 0.7em; font-weight: bold; border: 1px solid currentColor; }
            .status-WON { color: ${cGreen}; font-weight: bold; } .status-LOST { color: ${cRed}; font-weight: bold; }
            .team-sel { color: ${cGreen}; font-weight: bold; text-decoration: underline; text-underline-offset: 3px; }
            .summary-val { font-weight: bold; }
        </style>
    </head>
    <body>
        <h1 style="text-transform:uppercase; letter-spacing:-1px;">📈 Rapport de Backtest SDM 2025</h1>
        
        <div class="kpi-row">
            <div class="kpi-card"><div>GLOBAL</div><div style="font-size:1.5em; font-weight:900;">${detail(globalStats)}</div></div>
            <div class="kpi-card"><div>SUPREME</div><div style="color:${cGold}; font-size:1.5em; font-weight:900;">${detail(globalStats.SUPREME)}</div></div>
            <div class="kpi-card"><div>SOLID</div><div style="font-size:1.5em; font-weight:900;">${detail(globalStats.SOLID)}</div></div>
            <div class="kpi-card"><div>VALUE</div><div style="font-size:1.5em; font-weight:900;">${detail(globalStats.VALUE)}</div></div>
            <div class="kpi-card"><div>FAIBLE</div><div style="color:${cMuted}; font-size:1.5em; font-weight:900;">${detail(globalStats.FAIBLE)}</div></div>
        </div>

        <div class="section-title">📊 BILAN COMPARATIF PAR CHAMPIONNAT</div>
        <table class="bilan-table">
            <thead>
                <tr>
                    <th>Championnat</th>
                    <th>Global</th>
                    <th style="color:${cGold}">Supreme</th>
                    <th>Solid</th>
                    <th style="color:#fb923c">Value</th>
                    <th style="color:${cMuted}">Faible</th>
                    <th>Volume</th>
                </tr>
            </thead>
            <tbody>
                ${reports.map(r => `
                    <tr>
                        <td style="font-weight:bold; color:${cGold}">${r.name}</td>
                        <td class="summary-val">${rate(r.stats)}%</td>
                        <td class="summary-val">${detail(r.stats.SUPREME)}</td>
                        <td class="summary-val">${detail(r.stats.SOLID)}</td>
                        <td class="summary-val">${detail(r.stats.VALUE)}</td>
                        <td class="summary-val">${detail(r.stats.FAIBLE)}</td>
                        <td style="color:${cMuted}">${r.stats.win + r.stats.loss} matchs</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>

        <div class="section-title">🕒 HISTORIQUE DÉTAILLÉ</div>
        ${reports.map(report => `
            <div class="league-section">
                <div class="league-banner">
                    <div style="font-size:1.5em; font-weight:900; text-transform:uppercase; margin-bottom:10px;">${report.name}</div>
                    <div style="display:flex; gap:20px; font-size:0.85em; font-weight:bold;">
                        <span style="color:${cGold}">SUP: ${detail(report.stats.SUPREME)}</span>
                        <span>SOL: ${detail(report.stats.SOLID)}</span>
                        <span style="color:#fb923c">VAL: ${detail(report.stats.VALUE)}</span>
                        <span style="color:${cMuted}">FAI: ${detail(report.stats.FAIBLE)}</span>
                    </div>
                </div>
                <table class="match-table">
                    <thead><tr><th width="10%">Heure</th><th width="40%">Match</th><th width="15%">Score SDM</th><th width="10%">Prono</th><th width="15%">Score Final</th><th width="10%">État</th></tr></thead>
                    <tbody>
                        ${(() => {
                            let rows = ''; let lastRound = -1;
                            report.matches.forEach(m => {
                                if (m.round !== lastRound) { rows += `<tr><td colspan="6" class="round-separator">JOURNÉE ${m.round}</td></tr>`; lastRound = m.round; }
                                const d = new Date(m.date);
                                rows += `<tr>
                                    <td style="color:${cMuted}">${d.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})}</td>
                                    <td><span class="${m.pred==='Home'?'team-sel':''}">${m.match.split(' vs ')[0]}</span> vs <span class="${m.pred==='Away'?'team-sel':''}">${m.match.split(' vs ')[1]}</span></td>
                                    <td><span class="badge" style="border-color:${m.tier==='SUPREME'?cGold:m.tier==='SOLID'?'#cbd5e1':m.tier==='VALUE'?'#fb923c':cMuted}">${m.tier}</span> <small>${m.sdm}</small></td>
                                    <td><strong>${m.pred}</strong></td><td style="font-family:monospace; font-weight:bold;">${m.result}</td><td class="status-${m.status}">${m.status === 'WON' ? '✅' : '❌'}</td>
                                </tr>`;
                            });
                            return rows;
                        })()}
                    </tbody>
                </table>
            </div>
        `).join('')}
    </body>
    </html>`;
    return html;
}

function startServer(globalStats, reports) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(globalStats, reports));
    });
    server.listen(PORT, () => {
        console.log(`\n✅ BACKTEST STRATÉGIQUE PRÊT`);
        console.log(`🌐 ACCÉDER AU BILAN ET AUX DÉTAILS : http://localhost:${PORT}`);
        const s = (process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open');
        exec(`${s} http://localhost:${PORT}`);
    });
}

runBacktest();