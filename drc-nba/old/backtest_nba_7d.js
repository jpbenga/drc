const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const SDM_CONFIG = { HOME_ADVANTAGE: 3.5, B2B_PENALTY: 8.0, PORT: 3005, STAKE: 5 };
const START_BANKROLL = 150;

async function runBacktestWithRealOdds() {
    if (!fs.existsSync('nba_recent_7d.json')) return console.log("Lancer d'abord le download.");

    const games = JSON.parse(fs.readFileSync('nba_recent_7d.json'));
    const standings = JSON.parse(fs.readFileSync('nba_current_standings.json'));
    let history = [];
    let currentBankroll = START_BANKROLL;

    console.log(`🚀 Analyse SDM + Récupération des cotes réelles sur ${games.length} matchs...`);

    for (const game of games) {
        const home = standings.find(t => t.team.id === game.teams.home.id);
        const away = standings.find(t => t.team.id === game.teams.away.id);

        if (home && away) {
            // SDM Macro
            const hNet = (home.points.for - home.points.against) / home.games.played;
            const aNet = (away.points.for - away.points.against) / away.games.played;
            const hForm = (home.games.win.total / home.games.played) * 10;
            const aForm = (away.games.win.total / away.games.played) * 10;

            const diff = (hNet + hForm + SDM_CONFIG.HOME_ADVANTAGE) - (aNet + aForm);

            if (Math.abs(diff) > 5) {
                const predHome = diff > 0;
                const win = (predHome === (game.scores.home.total > game.scores.away.total));

                // --- RÉCUPÉRATION DE LA COTE RÉELLE ---
                let realOdd = 1.0;
                try {
                    const oRes = await axios.get('https://v1.basketball.api-sports.io/odds', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { game: game.id }
                    });
                    // On prend la meilleure cote Moneyline (id: 1) chez le premier bookmaker dispo (ex: Pinnacle)
                    const book = oRes.data.response[0]?.bookmakers[0];
                    if (book) {
                        const market = book.bets.find(b => b.id === 1);
                        const oddValue = market.values.find(v => v.value === (predHome ? 'Home' : 'Away'));
                        realOdd = parseFloat(oddValue.odd);
                    }
                } catch (e) { realOdd = 1.85; } // Fallback prudent si pas de cote

                const pnl = win ? (SDM_CONFIG.STAKE * (realOdd - 1)) : -SDM_CONFIG.STAKE;
                currentBankroll += pnl;

                history.push({
                    date: game.date,
                    match: `${game.teams.home.name} vs ${game.teams.away.name}`,
                    sdm: Math.abs(diff).toFixed(1),
                    tier: Math.abs(diff) >= 15 ? 'SUPREME' : (Math.abs(diff) >= 10 ? 'SOLID' : 'VALUE'),
                    pred: predHome ? '1' : '2',
                    odd: realOdd,
                    score: `${game.scores.home.total}-${game.scores.away.total}`,
                    res: win ? 'WON' : 'LOST',
                    pnl: pnl.toFixed(2),
                    bk: currentBankroll.toFixed(2)
                });
                process.stdout.write(win ? "✅" : "❌");
            }
        }
    }

    // Serveur Web (Design Gold & Blue)
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(history, currentBankroll));
    }).listen(SDM_CONFIG.PORT, () => {
        console.log(`\n🌐 DASHBOARD : http://localhost:${SDM_CONFIG.PORT}`);
        exec(`start http://localhost:${SDM_CONFIG.PORT}`);
    });
}

function generateHTML(history, finalBk) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    const wins = history.filter(h => h.res === 'WON').length;
    const profit = finalBk - START_BANKROLL;

    let rows = '';
    [...history].reverse().forEach(b => {
        const d = new Date(b.date);
        let tCls = b.tier === 'SUPREME' ? 'b-15' : (b.tier === 'SOLID' ? 'b-10' : 'b-5');
        rows += `<tr>
            <td>${d.toLocaleDateString()} ${d.getHours()}:00</td>
            <td>${b.match}</td>
            <td><span class="badge ${tCls}">${b.tier}</span> <small>SDM ${b.sdm}</small></td>
            <td>${b.score}</td>
            <td><span class="badge" style="color:${cGold}">@${b.odd}</span></td>
            <td style="font-weight:bold; color:${b.pnl > 0 ? cGreen : cRed}">${b.pnl > 0 ? '+' : ''}${b.pnl} €</td>
        </tr>`;
    });

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
        body { background: #0f172a; color: #f1f5f9; font-family: 'Roboto', sans-serif; padding: 40px; }
        .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 40px; }
        .card { background: #1e293b; padding: 20px; border-radius: 10px; text-align: center; border: 1px solid #334155; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; }
        th { background: #020617; padding: 15px; color: ${cMuted}; text-align: left; text-transform: uppercase; font-size: 0.8em; }
        td { padding: 15px; border-bottom: 1px solid #334155; }
        .badge { padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 0.7em; border: 1px solid currentColor; }
        .b-15 { color: ${cGold}; } .b-10 { color: #cbd5e1; } .b-5 { color: #fb923c; }
        h1 { color: ${cGold}; text-transform: uppercase; }
    </style></head><body>
        <h1>🏀 NBA REAL-ODDS AUDIT (7 JOURS)</h1>
        <div class="kpi-row">
            <div class="card"><small>PROFIT RÉEL</small><div style="font-size:2em; color:${cGreen}">${profit.toFixed(2)} €</div></div>
            <div class="card"><small>RÉUSSITE</small><div style="font-size:2em">${((wins/history.length)*100).toFixed(1)}%</div></div>
            <div class="card"><small>PARIS</small><div style="font-size:2em">${history.length}</div></div>
            <div class="card"><small>SOLDE</small><div style="font-size:2em; color:${cGold}">${finalBk.toFixed(2)}€</div></div>
        </div>
        <table><thead><tr><th>Date</th><th>Match</th><th>Tranche</th><th>Score</th><th>Cote Réelle</th><th>PnL</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
}

runBacktestWithRealOdds();