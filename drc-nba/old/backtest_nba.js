const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// =========================================================
// 🧠 CONFIGURATION DU MODÈLE NBA
// =========================================================
const SDM_CONFIG = {
    START_GAME: 8,         
    HOME_ADVANTAGE: 3.5,   
    B2B_PENALTY: 8.0,      
    PORT: 3005             
};

function runBacktestNBA() {
    if (!fs.existsSync('nba_season_data.json')) {
        return console.log("❌ Erreur : nba_season_data.json introuvable.");
    }

    const games = JSON.parse(fs.readFileSync('nba_season_data.json'));
    let teamStats = {};
    let history = [];

    // Compteurs par tranche
    let statsByTier = {
        'SUPREME': { wins: 0, total: 0 },
        'SOLID':   { wins: 0, total: 0 },
        'VALUE':   { wins: 0, total: 0 }
    };

    console.log(`🚀 Analyse de la performance par tranche...`);

    games.forEach(game => {
        const hID = game.teams.home.id;
        const aID = game.teams.away.id;
        const status = game.status.short;

        if (!teamStats[hID]) teamStats[hID] = { name: game.teams.home.name, played: 0, ptsS: 0, ptsC: 0, wins: 0, lastDate: null };
        if (!teamStats[aID]) teamStats[aID] = { name: game.teams.away.name, played: 0, ptsS: 0, ptsC: 0, wins: 0, lastDate: null };

        const h = teamStats[hID];
        const a = teamStats[aID];

        if (h.played >= SDM_CONFIG.START_GAME && a.played >= SDM_CONFIG.START_GAME && status === 'FT') {
            
            const hNet = (h.ptsS - h.ptsC) / h.played;
            const aNet = (a.ptsS - a.ptsC) / a.played;
            const hForm = (h.wins / h.played) * 10;
            const aForm = (a.wins / a.played) * 10;
            
            const hIsB2B = isB2B(h.lastDate, game.date);
            const aIsB2B = isB2B(a.lastDate, game.date);

            let scoreH = hNet + hForm + SDM_CONFIG.HOME_ADVANTAGE + (hIsB2B ? -SDM_CONFIG.B2B_PENALTY : 0);
            let scoreA = aNet + aForm + (aIsB2B ? -SDM_CONFIG.B2B_PENALTY : 0);

            const sdmDiff = scoreH - scoreA;

            if (Math.abs(sdmDiff) > 5) {
                const predHome = sdmDiff > 0;
                const homeScore = game.scores.home.total;
                const awayScore = game.scores.away.total;
                const actualHomeWin = homeScore > awayScore;
                const win = (predHome === actualHomeWin);

                let tier = 'VALUE';
                if (Math.abs(sdmDiff) >= 15) tier = 'SUPREME';
                else if (Math.abs(sdmDiff) >= 10) tier = 'SOLID';

                // MAJ Stats par tranche
                statsByTier[tier].total++;
                if (win) statsByTier[tier].wins++;

                history.push({
                    date: game.date,
                    match: `${game.teams.home.name} vs ${game.teams.away.name}`,
                    home: game.teams.home.name,
                    away: game.teams.away.name,
                    sdm: Math.abs(sdmDiff).toFixed(1),
                    tier: tier,
                    pred: predHome ? '1' : '2',
                    score: `${homeScore}-${awayScore}`,
                    res: win ? 'WON' : 'LOST'
                });
            }
        }

        if (status === 'FT') {
            updateStats(h, game.scores.home.total, game.scores.away.total, game.date);
            updateStats(a, game.scores.away.total, game.scores.home.total, game.date);
        }
    });

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(history, statsByTier));
    });

    server.listen(SDM_CONFIG.PORT, () => {
        console.log(`✅ DASHBOARD NBA : http://localhost:${SDM_CONFIG.PORT}`);
        const s = (process.platform=='darwin'?'open':process.platform=='win32'?'start':'xdg-open');
        exec(`${s} http://localhost:${SDM_CONFIG.PORT}`);
    });
}

function generateHTML(history, statsByTier) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    
    const total = history.length;
    const wins = history.filter(h => h.res === 'WON').length;
    const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;

    const calcRate = (tier) => {
        const t = statsByTier[tier];
        return t.total > 0 ? ((t.wins / t.total) * 100).toFixed(1) : "0.0";
    };

    let rows = '';
    let lastDay = '';

    [...history].reverse().forEach(b => {
        const dObj = new Date(b.date);
        const day = dObj.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
        if(day !== lastDay) {
            rows += `<tr><td colspan="6" class="date-sep">${day}</td></tr>`;
            lastDay = day;
        }

        let tCls = b.tier === 'SUPREME' ? 'b-15' : (b.tier === 'SOLID' ? 'b-10' : 'b-5');

        rows += `<tr>
            <td>${dObj.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})}</td>
            <td>
                <div>
                    <span style="${b.pred==='1'?'color:'+cGreen+';font-weight:bold;text-decoration:underline':''}">${b.home}</span>
                    <span style="font-size:0.8em; opacity:0.3; margin:0 5px">vs</span>
                    <span style="${b.pred==='2'?'color:'+cGreen+';font-weight:bold;text-decoration:underline':''}">${b.away}</span>
                </div>
            </td>
            <td><span class="badge ${tCls}">${b.tier}</span><br><small style="color:${cMuted}">SDM ${b.sdm}</small></td>
            <td><strong style="font-size:1.1em">${b.score}</strong></td>
            <td><span class="badge status-${b.res}">${b.res === 'WON' ? 'GAGNÉ' : 'PERDU'}</span></td>
            <td style="font-size:1.5em; text-align:center">${b.res === 'WON' ? '✅' : '❌'}</td>
        </tr>`;
    });

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NBA SDM Analytics</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --border: #334155; }
        body { background: var(--bg); color: #f1f5f9; font-family: 'Roboto', sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 30px; }
        .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 20px; }
        .tier-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px; }
        .kpi-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 15px; text-align: center; }
        .tier-card { background: rgba(2, 6, 23, 0.5); border: 1px solid var(--border); border-radius: 8px; padding: 15px; text-align: center; border-top: 4px solid currentColor; }
        .kpi-title { color: ${cMuted}; font-size: 0.75em; text-transform: uppercase; margin-bottom: 5px; }
        .kpi-val { font-size: 2em; font-weight: 900; }
        .section-title { font-weight: bold; color: ${cGold}; text-transform: uppercase; margin-bottom: 15px; font-size: 0.9em; border-left: 3px solid ${cGold}; padding-left: 10px; }
        table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; }
        th { background: #020617; color: ${cMuted}; padding: 12px; text-align: left; font-size: 0.8em; text-transform: uppercase; }
        td { padding: 15px 12px; border-bottom: 1px solid var(--border); }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 0.75em; font-weight: bold; border: 1px solid currentColor; display:inline-block; }
        .status-WON { color: ${cGreen}; background: rgba(74, 222, 128, 0.1); }
        .status-LOST { color: ${cRed}; background: rgba(248, 113, 113, 0.1); }
        .b-15 { color: ${cGold}; }
        .b-10 { color: #cbd5e1; }
        .b-5  { color: #fb923c; }
        .date-sep { background: #334155; color: white; padding: 10px 15px; font-size: 0.85em; font-weight: bold; text-transform: uppercase; }
    </style></head><body>
        <div class="header">
            <div><h1>🏀 NBA PERFORMANCE REPORT</h1><div style="color:${cMuted}">Validation Hit-Rate • Saison 2024/2025</div></div>
            <div style="text-align:right"><div style="color:${cMuted}">Hit-Rate Global</div><div style="font-size:2em; font-weight:bold; color:${cGold}">${winRate}%</div></div>
        </div>

        <div class="section-title">Résumé Global</div>
        <div class="kpi-row">
            <div class="kpi-card"><div class="kpi-title">Validés</div><div class="kpi-val" style="color:${cGreen}">${wins}</div></div>
            <div class="kpi-card"><div class="kpi-title">Échecs</div><div class="kpi-val" style="color:${cRed}">${total-wins}</div></div>
            <div class="kpi-card"><div class="kpi-title">Total Analysés</div><div class="kpi-val">${total}</div></div>
        </div>

        <div class="section-title">Performance par Tranche SDM</div>
        <div class="tier-row">
            <div class="tier-card b-15"><div class="kpi-title" style="color:inherit">SUPREME (15+)</div><div class="kpi-val">${calcRate('SUPREME')}%</div><div style="font-size:0.7em;opacity:0.6">${statsByTier['SUPREME'].wins}/${statsByTier['SUPREME'].total}</div></div>
            <div class="tier-card b-10"><div class="kpi-title" style="color:inherit">SOLID (10-15)</div><div class="kpi-val">${calcRate('SOLID')}%</div><div style="font-size:0.7em;opacity:0.6">${statsByTier['SOLID'].wins}/${statsByTier['SOLID'].total}</div></div>
            <div class="tier-card b-5"><div class="kpi-title" style="color:inherit">VALUE (5-10)</div><div class="kpi-val">${calcRate('VALUE')}%</div><div style="font-size:0.7em;opacity:0.6">${statsByTier['VALUE'].wins}/${statsByTier['VALUE'].total}</div></div>
        </div>

        <div class="section-title">Historique des Prédictions</div>
        <table><thead><tr><th>Heure</th><th>Match</th><th>Tier SDM</th><th>Score</th><th>Résultat</th><th>Validation</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
}

function updateStats(team, s, c, date) {
    team.played++; team.ptsS += s; team.ptsC += c;
    if (s > c) team.wins++; team.lastDate = date;
}
function isB2B(last, current) {
    if (!last) return false;
    const diff = (new Date(current) - new Date(last)) / (1000 * 60 * 60 * 24);
    return diff <= 1.1;
}

runBacktestNBA();