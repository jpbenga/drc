const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const SEASON = '2025-2026';
const PORT = 3000;
const FILE_PICKS = 'nba_picks.json';

async function runScanner() {
    console.clear();
    console.log("🏀 SCANNER NBA - FILTRE VALUE STRICT (5-10)");
    
    const standingsRes = await axios.get('https://v1.basketball.api-sports.io/standings', {
        headers: { 'x-apisports-key': API_KEY }, params: { league: 12, season: SEASON }
    });
    const teams = standingsRes.data.response[0].flat();

    const dates = [new Date().toISOString().split('T')[0], new Date(Date.now() + 86400000).toISOString().split('T')[0]];
    let opportunities = [];
    let savedPicks = fs.existsSync(FILE_PICKS) ? JSON.parse(fs.readFileSync(FILE_PICKS)) : [];

    for (const date of dates) {
        const gamesRes = await axios.get('https://v1.basketball.api-sports.io/games', {
            headers: { 'x-apisports-key': API_KEY }, params: { league: 12, season: SEASON, date: date }
        });

        for (const m of gamesRes.data.response) {
            const h = teams.find(t => t.team.id === m.teams.home.id);
            const a = teams.find(t => t.team.id === m.teams.away.id);
            if (!h || !a) continue;

            const hNet = (h.points.for - h.points.against) / h.games.played;
            const aNet = (a.points.for - a.points.against) / a.games.played;
            const sdmDiff = (hNet + (h.games.win.total/h.games.played)*10 + 3.5) - (aNet + (a.games.win.total/a.games.played)*10);
            const absSDM = Math.abs(sdmDiff);

            // 🔥 FILTRE UNIQUE : VALUE UNIQUEMENT (5 à 10)
            if (absSDM >= 5 && absSDM < 10) {
                const oddsRes = await axios.get('https://v1.basketball.api-sports.io/odds', {
                    headers: { 'x-apisports-key': API_KEY }, params: { game: m.id }
                });
                const spread = oddsRes.data.response[0]?.bookmakers[0]?.bets.find(b => b.id === 3);

                if (spread) {
                    const opt = spread.values.find(v => v.value.includes('Home'));
                    const line = parseFloat(opt.value.split(' ')[1]);
                    const betTeam = sdmDiff > 0 ? h.team.name : a.team.name;
                    const hText = sdmDiff > 0 ? (line > 0 ? '+'+line : line) : (line > 0 ? '-'+line : '+'+Math.abs(line));

                    const opp = {
                        id: m.id, date: m.date, match: `${h.team.name} vs ${a.team.name}`,
                        sdm: absSDM.toFixed(1), tier: 'VALUE', odd: opt.odd, 
                        instruction: `${betTeam} (${hText})`, status: 'PENDING'
                    };
                    opportunities.push(opp);
                    if (!savedPicks.find(p => p.id === m.id)) savedPicks.push(opp);
                }
            }
        }
    }
    fs.writeFileSync(FILE_PICKS, JSON.stringify(savedPicks, null, 2));
    serveScanner(opportunities);
}

function serveScanner(opps) {
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(opps));
    }).listen(PORT, () => {
        console.log(`\n🌐 DASHBOARD : http://localhost:${PORT}`);
        exec(`xdg-open http://localhost:${PORT}`);
    });
}

function generateHTML(opps) {
    const cGreen = '#4ade80'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    let rows = ''; let lastDate = '';
    opps.forEach(o => {
        const d = new Date(o.date);
        const dateStr = d.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
        if(dateStr !== lastDate) { rows += `<tr><td colspan="5" class="date-sep">${dateStr}</td></tr>`; lastDate = dateStr; }
        rows += `<tr>
            <td>${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}</td>
            <td><b>${o.match}</b><br><small style="color:${cMuted}">NBA League</small></td>
            <td><span class="badge" style="color:#fb923c">VALUE</span><br><small style="color:${cMuted}">Score ${o.sdm}</small></td>
            <td><strong>${o.odd}</strong><br><small style="color:${cMuted}">Pinnacle</small></td>
            <td><b style="color:${cGreen}">${o.instruction}</b><br><small style="color:${cMuted}">Mise: 5 €</small></td>
        </tr>`;
    });
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;900&display=swap" rel="stylesheet"><style>
    body { background: #0f172a; color: white; font-family: 'Roboto', sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }
    .header { border-bottom: 1px solid #334155; padding-bottom: 20px; margin-bottom: 20px; }
    .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
    .card { background: #1e293b; padding: 15px; border-radius: 8px; text-align: center; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }
    th { background: #020617; color: ${cMuted}; padding: 12px; text-align: left; font-size: 0.8em; text-transform: uppercase; }
    td { padding: 15px 12px; border-bottom: 1px solid #334155; }
    .date-sep { background: #1e293b; color: ${cGold}; padding: 10px; font-weight: bold; text-transform: uppercase; border-bottom: 2px solid #334155; }
    </style></head><body>
        <div class="header"><h1>OPPORTUNITÉS DÉTECTÉES</h1><div style="color:${cMuted}">Scan Live • Jours J & J+1</div></div>
        <div class="kpi-row">
            <div class="card"><small style="color:${cMuted}">Total Paris</small><div style="font-size:1.5em; font-weight:900">${opps.length}</div></div>
            <div class="card"><small style="color:${cMuted}">Mise Totale Engagée</small><div style="font-size:1.5em; font-weight:900">${opps.length * 5} €</div></div>
            <div class="card"><small style="color:${cMuted}">Cote Moyenne</small><div style="font-size:1.5em; font-weight:900">1.92</div></div>
        </div>
        <table><thead><tr><th>Heure</th><th>Match</th><th>Confiance</th><th>Cote & Bookie</th><th>Mise (Config)</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
}
runScanner();