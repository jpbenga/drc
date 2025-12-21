const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// =========================================================
// 🧠 CONFIGURATION DU TEST DE VALUE (SPREAD)
// =========================================================
const SDM_CONFIG = {
    START_GAME: 8,
    HOME_ADVANTAGE: 3.5,
    B2B_PENALTY: 8.0,
    PORT: 3006
};

// Définition des "Lignes de Handicap" à couvrir selon le SDM
const SPREAD_TARGETS = {
    'SUPREME': 9.5, // Doit gagner de 10 pts ou +
    'SOLID':   4.5, // Doit gagner de 5 pts ou +
    'VALUE':   1.5  // Doit gagner de 2 pts ou +
};

function runSpreadBacktest() {
    if (!fs.existsSync('nba_season_data.json')) return console.log("Fichier manquant.");

    const games = JSON.parse(fs.readFileSync('nba_season_data.json'));
    let teamStats = {};
    let history = [];
    let statsByTier = {
        'SUPREME': { wins: 0, total: 0 },
        'SOLID':   { wins: 0, total: 0 },
        'VALUE':   { wins: 0, total: 0 }
    };

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
            const absSDM = Math.abs(sdmDiff);

            if (absSDM > 5) {
                let tier = absSDM >= 15 ? 'SUPREME' : (absSDM >= 10 ? 'SOLID' : 'VALUE');
                const targetHandicap = SPREAD_TARGETS[tier];
                
                const homeScore = game.scores.home.total;
                const awayScore = game.scores.away.total;
                const actualDiff = homeScore - awayScore;

                // LOGIQUE DE VALIDATION DU SPREAD :
                // On vérifie si l'équipe désignée couvre le handicap cible
                let isWin = false;
                if (sdmDiff > 0) { // On parie sur Home
                    if (actualDiff > targetHandicap) isWin = true;
                } else { // On parie sur Away
                    if ((awayScore - homeScore) > targetHandicap) isWin = true;
                }

                statsByTier[tier].total++;
                if (isWin) statsByTier[tier].wins++;

                history.push({
                    date: game.date,
                    match: `${h.name} vs ${a.name}`,
                    sdm: absSDM.toFixed(1),
                    tier: tier,
                    target: targetHandicap,
                    score: `${homeScore}-${awayScore}`,
                    actualDiff: Math.abs(actualDiff),
                    res: isWin ? 'WON' : 'LOST'
                });
            }
        }

        if (status === 'FT') {
            updateStats(h, game.scores.home.total, game.scores.away.total, game.date);
            updateStats(a, game.scores.away.total, game.scores.home.total, game.date);
        }
    });

    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(history, statsByTier));
    }).listen(SDM_CONFIG.PORT, () => {
        console.log(`✅ DASHBOARD SPREAD NBA : http://localhost:${SDM_CONFIG.PORT}`);
        exec(`start http://localhost:${SDM_CONFIG.PORT}`);
    });
}

function generateHTML(history, statsByTier) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    const total = history.length;
    const wins = history.filter(h => h.res === 'WON').length;
    const winRate = ((wins / total) * 100).toFixed(1);

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NBA Spread Audit</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --border: #334155; }
        body { background: var(--bg); color: #f1f5f9; font-family: 'Roboto', sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 30px; }
        .kpi-row, .tier-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px; }
        .kpi-card, .tier-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; text-align: center; }
        .tier-card { border-top: 4px solid currentColor; }
        .kpi-title { color: ${cMuted}; font-size: 0.8em; text-transform: uppercase; margin-bottom: 5px; }
        .kpi-val { font-size: 2em; font-weight: 900; }
        table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; }
        th { background: #020617; color: ${cMuted}; padding: 12px; text-align: left; font-size: 0.8em; text-transform: uppercase; }
        td { padding: 15px 12px; border-bottom: 1px solid var(--border); }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 0.75em; font-weight: bold; border: 1px solid currentColor; }
        .status-WON { color: ${cGreen}; background: rgba(74, 222, 128, 0.1); }
        .status-LOST { color: ${cRed}; background: rgba(248, 113, 113, 0.1); }
        .b-15 { color: ${cGold}; } .b-10 { color: #cbd5e1; } .b-5 { color: #fb923c; }
        .date-sep { background: #334155; color: white; padding: 10px 15px; font-size: 0.85em; font-weight: bold; text-transform: uppercase; }
    </style></head><body>
        <div class="header">
            <div><h1>🏀 NBA SPREAD VALIDATION</h1><div style="color:${cMuted}">Test de Couverture de Handicap • 24/25</div></div>
            <div style="font-size:2em; font-weight:bold; color:${cGold}">${winRate}%</div>
        </div>
        <div class="tier-row">
            ${Object.entries(statsByTier).map(([tier, data]) => {
                const rate = ((data.wins / data.total) * 100).toFixed(1);
                const color = tier === 'SUPREME' ? cGold : (tier === 'SOLID' ? '#cbd5e1' : '#fb923c');
                return `<div class="tier-card" style="color:${color}"><div class="kpi-title" style="color:inherit">${tier} (Cible >${SPREAD_TARGETS[tier]})</div><div class="kpi-val">${rate}%</div><small>${data.wins}/${data.total}</small></div>`;
            }).join('')}
        </div>
        <table><thead><tr><th>Date</th><th>Match</th><th>SDM (Tier)</th><th>Cible</th><th>Score Final (Diff)</th><th>Résultat</th></tr></thead>
        <tbody>${[...history].reverse().map(h => `
            <tr>
                <td>${new Date(h.date).toLocaleDateString()}</td>
                <td>${h.match}</td>
                <td><span class="badge b-${h.sdm >= 15 ? '15' : (h.sdm >= 10 ? '10' : '5')}">${h.tier} (SDM ${h.sdm})</span></td>
                <td><strong>H : -${h.target}</strong></td>
                <td>${h.score} (Diff: ${h.actualDiff})</td>
                <td><span class="badge status-${h.res}">${h.res === 'WON' ? 'COUVER' : 'ÉCHEC'}</span></td>
            </tr>`).join('')}
        </tbody></table>
    </body></html>`;
}

function updateStats(team, s, c, date) { team.played++; team.ptsS += s; team.ptsC += c; if (s > c) team.wins++; team.lastDate = date; }
function isB2B(last, current) { if (!last) return false; return (new Date(current) - new Date(last)) / (1000 * 60 * 60 * 24) <= 1.1; }

runSpreadBacktest();