const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// =================================================================
// ⚙️ CONFIGURATION AUDIT RÉEL (ID 3 : Asian Handicap)
// =================================================================
const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const SEASON = '2025-2026';
const PORT = 3007;
const STAKE = 5;
const START_BANKROLL = 150;

async function runRealSpreadAudit() {
    console.clear();
    console.log(`🚀 Analyse des tranches SDM sur données réelles...`);
    
    const standingsRaw = await getData('standings', { league: 12, season: SEASON });
    const games = await getData('games', { league: 12, season: SEASON });
    
    if (!standingsRaw || !games) return console.log("❌ Erreur API");
    const standings = standingsRaw.flat();

    const today = new Date();
    const last7Days = games.filter(g => {
        const gDate = new Date(g.date);
        const diff = (today - gDate) / (1000 * 60 * 60 * 24);
        return diff <= 7 && diff >= 0 && g.status.short === 'FT';
    });

    let history = [];
    let bankroll = START_BANKROLL;

    // Initialisation des compteurs de tranches
    let statsByTier = {
        'SUPREME': { wins: 0, total: 0, profit: 0 },
        'SOLID':   { wins: 0, total: 0, profit: 0 },
        'VALUE':   { wins: 0, total: 0, profit: 0 }
    };

    for (const game of last7Days) {
        const home = standings.find(t => t.team.id === game.teams.home.id);
        const away = standings.find(t => t.team.id === game.teams.away.id);

        if (home && away) {
            const hNet = (home.points.for - home.points.against) / home.games.played;
            const aNet = (away.points.for - away.points.against) / away.games.played;
            const hForm = (home.games.win.total / home.games.played) * 10;
            const aForm = (away.games.win.total / away.games.played) * 10;
            const sdmDiff = (hNet + hForm + 3.5) - (aNet + aForm);

            const oddsRes = await getData('odds', { game: game.id });
            const bookmaker = oddsRes ? oddsRes[0]?.bookmakers[0] : null;
            const asianHandicap = bookmaker?.bets.find(b => b.id === 3);

            if (asianHandicap) {
                const homeOption = asianHandicap.values.find(v => v.value.includes('Home'));
                const line = parseFloat(homeOption.value.split(' ')[1]); 
                const odd = parseFloat(homeOption.odd);

                const absSDM = Math.abs(sdmDiff);
                const absLine = Math.abs(line);

                if (absSDM > absLine + 2) { 
                    const betOnHome = sdmDiff > 0;
                    const finalDiff = game.scores.home.total - game.scores.away.total;
                    
                    let win = false;
                    if (betOnHome) {
                        if (finalDiff > Math.abs(line)) win = true;
                    } else {
                        if ((game.scores.away.total - game.scores.home.total) > Math.abs(line)) win = true;
                    }

                    const pnl = win ? (STAKE * (odd - 1)) : -STAKE;
                    bankroll += pnl;

                    // Détermination du Tier
                    let tier = absSDM >= 15 ? 'SUPREME' : (absSDM >= 10 ? 'SOLID' : 'VALUE');
                    
                    // Mise à jour des stats de tranche
                    statsByTier[tier].total++;
                    if (win) statsByTier[tier].wins++;
                    statsByTier[tier].profit += pnl;

                    history.push({
                        date: game.date,
                        match: `${home.team.name} vs ${away.team.name}`,
                        sdm: absSDM.toFixed(1),
                        tier: tier,
                        marketLine: homeOption.value,
                        odd: odd,
                        score: `${game.scores.home.total}-${game.scores.away.total}`,
                        res: win ? 'WON' : 'LOST',
                        pnl: pnl.toFixed(2),
                        bk: bankroll.toFixed(2)
                    });
                }
            }
        }
    }

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(history, bankroll, statsByTier));
    });

    server.listen(PORT, () => {
        console.log(`\n\n🌐 DASHBOARD AVEC TRANCHES : http://localhost:${PORT}`);
        exec(`start http://localhost:${PORT}`);
    });
}

async function getData(endpoint, params) {
    try {
        const res = await axios.get(`https://v1.basketball.api-sports.io/${endpoint}`, {
            headers: { 'x-apisports-key': API_KEY },
            params: params
        });
        return res.data.response;
    } catch (e) { return null; }
}

function generateHTML(history, finalBk, statsByTier) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    const wins = history.filter(h => h.res === 'WON').length;
    const winRate = history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : 0;
    const profit = finalBk - START_BANKROLL;

    const calcRate = (t) => t.total > 0 ? ((t.wins / t.total) * 100).toFixed(1) : "0.0";

    let rows = history.reverse().map(h => `
        <tr>
            <td>${new Date(h.date).toLocaleDateString()}</td>
            <td>${h.match}</td>
            <td><span class="badge b-${h.sdm >= 15 ? '15' : (h.sdm >= 10 ? '10' : '5')}">${h.tier} (SDM ${h.sdm})</span></td>
            <td><span class="badge" style="color:${cGold}">${h.marketLine}</span></td>
            <td><strong>${h.score}</strong></td>
            <td><span class="badge" style="color:${cGold}">@${h.odd}</span></td>
            <td><span class="badge status-${h.res}">${h.res}</span></td>
            <td style="font-weight:bold; color:${h.pnl > 0 ? cGreen : cRed}">${h.pnl > 0 ? '+' : ''}${h.pnl}€</td>
        </tr>
    `).join('');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>NBA Spread Audit</title>
    <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;900&display=swap" rel="stylesheet">
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --border: #334155; }
        body { background: var(--bg); color: #f1f5f9; font-family: 'Roboto', sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 30px; }
        .tier-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px; }
        .tier-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; text-align: center; border-top: 4px solid currentColor; }
        .kpi-title { color: ${cMuted}; font-size: 0.75em; text-transform: uppercase; margin-bottom: 5px; }
        .kpi-val { font-size: 2em; font-weight: 900; }
        table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; }
        th { background: #020617; color: ${cMuted}; padding: 12px; text-align: left; font-size: 0.8em; text-transform: uppercase; }
        td { padding: 15px 12px; border-bottom: 1px solid var(--border); }
        .badge { padding: 4px 8px; border-radius: 4px; font-size: 0.75em; font-weight: bold; border: 1px solid currentColor; }
        .status-WON { color: ${cGreen}; background: rgba(74, 222, 128, 0.1); }
        .status-LOST { color: ${cRed}; background: rgba(248, 113, 113, 0.1); }
        .b-15 { color: ${cGold}; } .b-10 { color: #cbd5e1; } .b-5 { color: #fb923c; }
    </style></head><body>
        <div class="header">
            <div><h1>🏀 NBA PERFORMANCE REPORT (REAL-SPREAD)</h1><div style="color:${cMuted}">7 Derniers Jours • Audit par Tranche</div></div>
            <div style="font-size:2em; font-weight:bold; color:${profit >= 0 ? cGreen : cRed}">${profit > 0 ? '+' : ''}${profit.toFixed(2)} €</div>
        </div>

        <div style="font-weight:bold; color:${cGold}; margin-bottom:15px; text-transform:uppercase; font-size:0.9em">Performance par Tranche SDM</div>
        <div class="tier-row">
            <div class="tier-card b-15">
                <div class="kpi-title">SUPREME (15+)</div>
                <div class="kpi-val">${calcRate(statsByTier['SUPREME'])}%</div>
                <div style="color:${cGreen}; font-weight:bold">${statsByTier['SUPREME'].profit.toFixed(2)}€</div>
            </div>
            <div class="tier-card b-10">
                <div class="kpi-title">SOLID (10-15)</div>
                <div class="kpi-val">${calcRate(statsByTier['SOLID'])}%</div>
                <div style="color:${statsByTier['SOLID'].profit >= 0 ? cGreen : cRed}; font-weight:bold">${statsByTier['SOLID'].profit.toFixed(2)}€</div>
            </div>
            <div class="tier-card b-5">
                <div class="kpi-title">VALUE (5-10)</div>
                <div class="kpi-val">${calcRate(statsByTier['VALUE'])}%</div>
                <div style="color:${statsByTier['VALUE'].profit >= 0 ? cGreen : cRed}; font-weight:bold">${statsByTier['VALUE'].profit.toFixed(2)}€</div>
            </div>
        </div>

        <table><thead><tr><th>Date</th><th>Match</th><th>SDM (Tier)</th><th>Ligne API</th><th>Score</th><th>Cote</th><th>Résultat</th><th>PnL</th></tr></thead>
        <tbody>${rows}</tbody></table>
    </body></html>`;
}

runRealSpreadAudit();