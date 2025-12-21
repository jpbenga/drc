const axios = require('axios');
const fs = require('fs');
const http = require('http');

const FILE_PICKS = 'nba_picks.json';
const FILE_CASH = 'nba_portfolio.json';
const API_KEY = '7f7700a471beeeb52aecde406a3870ba';

async function runCash() {
    console.clear();
    console.log("🛠️  AUDIT STRATÉGIQUE NBA\n");

    if (!fs.existsSync(FILE_PICKS)) return console.log("❌ Fichier nba_picks.json absent.");
    let picks = JSON.parse(fs.readFileSync(FILE_PICKS));
    let portfolio = fs.existsSync(FILE_CASH) ? JSON.parse(fs.readFileSync(FILE_CASH)) : { bankroll: 150, history: [] };

    // Filtrage : On ne traite que les matchs qui sont encore PENDING dans ton fichier
    const pendingToProcess = picks.filter(x => x.status === 'PENDING');

    for (let p of pendingToProcess) {
        try {
            const res = await axios.get(`https://v1.basketball.api-sports.io/games`, {
                headers: { 'x-apisports-key': API_KEY }, 
                params: { id: p.id }
            });

            const game = res.data.response[0];
            if (!game) continue;

            // Si le match est fini, on le bascule dans l'historique
            if (game.status.short === 'FT') {
                console.log(`--------------------------------------------------`);
                console.log(`🏀 MATCH TERMINÉ : ${p.match}`);
                
                const matchParsing = p.instruction.match(/(.*) \(([-+]?[\d.]+)\)/);
                if (!matchParsing) continue;

                const targetTeam = matchParsing[1].trim(); 
                const handicap = parseFloat(matchParsing[2]);
                const scoreH = game.scores.home.total;
                const scoreA = game.scores.away.total;
                const nameH = game.teams.home.name;

                const isHome = nameH.toLowerCase().includes(targetTeam.toLowerCase());
                const teamScore = isHome ? scoreH : scoreA;
                const oppScore = isHome ? scoreA : scoreH;
                
                const totalPointEquipe = teamScore + handicap;
                const win = totalPointEquipe > oppScore;

                // Log console pour ton suivi
                console.log(`⚖️ CALCUL : ${teamScore} + (${handicap}) = ${totalPointEquipe} vs ${oppScore}`);
                console.log(`🏆 RÉSULTAT : ${win ? "✅ WON" : "❌ LOST"}`);

                p.status = 'SETTLED';
                const profit = win ? (5 * (parseFloat(p.odd) - 1)).toFixed(2) : -5;
                
                portfolio.history.push({ 
                    ...p, 
                    res: win ? 'WON' : 'LOST', 
                    score: `${scoreH}-${scoreA}`, 
                    profit: parseFloat(profit) 
                });
                portfolio.bankroll += parseFloat(profit);
            } else {
                console.log(`⏳ MATCH EN ATTENTE : ${p.match} (${game.status.short})`);
            }
        } catch (e) {
            console.log(`❌ Erreur API match ${p.id}`);
        }
    }

    // Sauvegarde des fichiers
    fs.writeFileSync(FILE_PICKS, JSON.stringify(picks, null, 2));
    fs.writeFileSync(FILE_CASH, JSON.stringify(portfolio, null, 2));

    // On passe les matchs restants en "PENDING" au dashboard
    servePortfolio(portfolio, picks.filter(x => x.status === 'PENDING'));
}

function generatePortfolioHTML(port, pending) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    const profitTotal = (port.bankroll - 150).toFixed(2);
    const rate = port.history.length > 0 ? ((port.history.filter(h => h.res === 'WON').length / port.history.length) * 100).toFixed(1) : 0;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body { background: #0f172a; color: white; font-family: sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }
    .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
    .card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #334155; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 30px; }
    th { background: #020617; color: ${cMuted}; padding: 12px; text-align: left; font-size: 0.75em; text-transform: uppercase; }
    td { padding: 12px; border-bottom: 1px solid #334155; font-size: 0.9em; }
    .title { color: ${cGold}; text-transform: uppercase; font-weight: 900; margin: 20px 0 10px 0; }
    </style></head><body>
        <h1>📊 PORTFOLIO MANAGER</h1>
        <div class="kpi-row">
            <div class="card"><small>Profit Net</small><div style="color:${profitTotal >= 0 ? cGreen : cRed}">${profitTotal} €</div></div>
            <div class="card"><small>Réussite</small><div>${rate}%</div></div>
            <div class="card"><small>En Attente</small><div>${pending.length}</div></div>
            <div class="card"><small>Bankroll</small><div>${port.bankroll.toFixed(2)} €</div></div>
        </div>

        ${pending.length > 0 ? `
        <div class="title">⏳ Paris en cours</div>
        <table><thead><tr><th>Match</th><th>Instruction</th><th>Cote / Mise</th><th>Gain Potentiel</th></tr></thead>
        <tbody>${pending.map(p => `<tr>
            <td><b>${p.match}</b></td>
            <td style="color:${cGold}">${p.instruction}</td>
            <td>${p.odd} / 5€</td>
            <td style="color:${cGreen}">+${(5 * (parseFloat(p.odd) - 1)).toFixed(2)}€</td>
        </tr>`).join('')}</tbody></table>` : ''}

        <div class="title">📜 Historique des paris</div>
        <table><thead><tr><th>Date</th><th>Match</th><th>Pari</th><th>Cote</th><th>Résultat</th><th>Score</th><th>Profit</th></tr></thead>
        <tbody>${port.history.slice().reverse().map(h => `<tr>
            <td>${new Date(h.date).toLocaleDateString()}</td>
            <td><b>${h.match}</b></td>
            <td style="color:${cGold}">${h.instruction}</td>
            <td>${h.odd}</td>
            <td style="color:${h.res==='WON'?cGreen:cRed}; font-weight:bold">${h.res}</td>
            <td>${h.score}</td>
            <td style="color:${h.profit > 0 ? cGreen : cRed}">${h.profit > 0 ? '+' : ''}${h.profit} €</td>
        </tr>`).join('')}</tbody></table>
    </body></html>`;
}

function servePortfolio(port, pending) {
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generatePortfolioHTML(port, pending));
    }).listen(3008, () => console.log("🌐 Dashboard : http://localhost:3008"));
}

runCash();