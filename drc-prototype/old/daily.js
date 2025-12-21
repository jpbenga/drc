const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const SEASON = 2025; 
const PORT = 3000;

// CONFIGURATION "TEST GRANDEUR NATURE"
const CONFIG = {
    FIXED_STAKE: 5,        // Mise fixe demandée
    MIN_ODD_CUTOFF: 10.0,  // Sécurité
    // DATES CIBLÉES (Selon votre contexte "19/12/25")
    DATE_TODAY: "2025-12-19",
    DATE_TOMORROW: "2025-12-20"
};

const LEAGUES = [
    { id: 39, name: "Premier League" }, { id: 61, name: "Ligue 1" }, { id: 140, name: "La Liga" },
    { id: 78, name: "Bundesliga" }, { id: 135, name: "Serie A" }, { id: 94, name: "Liga Portugal" },
    { id: 88, name: "Eredivisie" }, { id: 144, name: "Jupiler Pro" }, { id: 179, name: "Premiership" },
    { id: 203, name: "Süper Lig" }, { id: 197, name: "Super League (GRE)" }, { id: 119, name: "Superliga (DAN)" },
    { id: 207, name: "Super League (SUI)" }, { id: 218, name: "Bundesliga (AUT)" }, { id: 40, name: "Championship" },
    { id: 62, name: "Ligue 2" }, { id: 136, name: "Serie B" }, { id: 79, name: "2. Bundesliga" },
    { id: 141, name: "La Liga 2" }, { id: 106, name: "Ekstraklasa" }, { id: 210, name: "HNL" },
    { id: 209, name: "Czech Liga" }, { id: 283, name: "Liga I" }, { id: 253, name: "MLS" },
    { id: 71, name: "Brasileiro A" }, { id: 128, name: "Liga Prof" }, { id: 262, name: "Liga MX" },
    { id: 307, name: "Saudi Pro" }, { id: 98, name: "J1 League" }, { id: 188, name: "A-League" }
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runLiveAction() {
    console.clear();
    console.log(`🚀 TEST GRANDEUR NATURE (MISE FIXE 5€)`);
    console.log(`📅 Cible : ${CONFIG.DATE_TODAY} et ${CONFIG.DATE_TOMORROW}`);
    
    // --- 1. CALIBRATION (Indispensable pour connaître la "Value") ---
    console.log(`1️⃣  Calibration des cotes (Historique)...`);
    let strategyMap = {}; let leagueMem = {};   
    
    for (const league of LEAGUES) {
        try {
            const hFile = `history_${league.id}.json`;
            if (!fs.existsSync(hFile)) continue;
            const history = JSON.parse(fs.readFileSync(hFile));
            history.sort((a,b) => new Date(a.fixture.date) - new Date(b.fixture.date));
            
            let stats = { '0-5': {b:0, w:0}, '5-10': {b:0, w:0}, '10-15': {b:0, w:0}, '15+': {b:0, w:0} };
            let standings = {}; let nameToId = {};

            for (const m of history) {
                const hID = m.teams.home.id; const aID = m.teams.away.id;
                nameToId[m.teams.home.name] = hID; nameToId[m.teams.away.name] = aID;
                if(!standings[hID]) standings[hID] = { id:hID, pts:0, history:[] };
                if(!standings[aID]) standings[aID] = { id:aID, pts:0, history:[] };

                const sdm = calculateRobustSDM(hID, aID, standings);
                const absScore = Math.abs(sdm.val);
                let range = absScore < 5 ? '0-5' : (absScore < 10 ? '5-10' : (absScore < 15 ? '10-15' : '15+'));
                const pred = sdm.val > 0 ? 'Home' : 'Away';
                
                let winner = 'Draw';
                if(m.goals.home > m.goals.away) winner = 'Home';
                else if(m.goals.away > m.goals.home) winner = 'Away';

                stats[range].b++;
                if(pred === winner) stats[range].w++;

                let pH=1, pA=1;
                if(m.goals.home > m.goals.away) { pH=3; pA=0; } else if(m.goals.home < m.goals.away) { pH=0; pA=3; }
                standings[hID].pts+=pH; standings[hID].history.push(standings[hID].pts);
                standings[aID].pts+=pA; standings[aID].history.push(standings[aID].pts);
            }
            strategyMap[league.id] = {};
            for(const r in stats) {
                const wr = stats[r].b > 0 ? stats[r].w / stats[r].b : 0;
                strategyMap[league.id][r] = wr > 0 ? (1 / wr) : 999;
            }
            leagueMem[league.id] = { standings, nameToId };
        } catch (e) {}
    }

    // --- 2. SCAN DES MATCHS (Tout statut confondu) ---
    console.log(`2️⃣  Scan des opportunités (Compris: En Cours / Terminé)...`);
    
    let opportunities = [];

    for (const league of LEAGUES) {
        if (!strategyMap[league.id]) continue;
        process.stdout.write(`.`); 

        try {
            // Note: On ne met PAS de filtre 'status' pour tout récupérer
            const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { 
                    league: league.id, 
                    season: SEASON, 
                    from: CONFIG.DATE_TODAY, 
                    to: CONFIG.DATE_TOMORROW 
                }
            });
            
            const matches = res.data.response;
            if(matches.length === 0) continue;

            for (const m of matches) {
                const mem = leagueMem[league.id];
                const hID = mem.nameToId[m.teams.home.name];
                const aID = mem.nameToId[m.teams.away.name];

                if(hID && aID && mem.standings[hID] && mem.standings[aID]) {
                    
                    const sdm = calculateRobustSDM(hID, aID, mem.standings);
                    const absScore = Math.abs(sdm.val);
                    
                    let range = '0-5';
                    if (absScore >= 15) range = '15+';
                    else if (absScore >= 10) range = '10-15';
                    else if (absScore >= 5) range = '5-10';

                    // FILTRE : On ignore les 0-5 (Trop risqué)
                    if (range === '0-5') continue;

                    const pred = sdm.val > 0 ? 'Home' : 'Away';
                    const minOdd = strategyMap[league.id][range];

                    if(minOdd > CONFIG.MIN_ODD_CUTOFF) continue;

                    // Récupération cote
                    await delay(120);
                    const oRes = await axios.get('https://v3.football.api-sports.io/odds', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { fixture: m.fixture.id }
                    });

                    if(oRes.data.response.length > 0) {
                        const b = oRes.data.response[0].bookmakers[0];
                        const betObj = b.bets.find(x=>x.id===1);
                        if(betObj) {
                            const v = betObj.values.find(x=>x.value===pred);
                            if(v) {
                                const realOdd = parseFloat(v.odd);
                                if(realOdd > minOdd) {
                                    const valuePct = ((realOdd / minOdd) - 1) * 100;
                                    
                                    // Statut du match pour l'affichage
                                    let statusDisplay = m.fixture.status.short; // NS, 1H, FT...
                                    if(m.fixture.status.elapsed) statusDisplay += ` (${m.fixture.status.elapsed}')`;

                                    opportunities.push({
                                        date: new Date(m.fixture.date),
                                        league: league.name,
                                        match: `${m.teams.home.name} vs ${m.teams.away.name}`,
                                        selection: pred === 'Home' ? m.teams.home.name : m.teams.away.name,
                                        score: absScore.toFixed(1),
                                        range: range,
                                        stake: CONFIG.FIXED_STAKE,
                                        odd: realOdd,
                                        minOdd: minOdd.toFixed(2),
                                        value: valuePct.toFixed(1),
                                        status: statusDisplay
                                    });
                                }
                            }
                        }
                    }
                }
            }
        } catch(e) {}
    }

    console.log(`\n✅ GÉNÉRATION LISTE...`);
    generateTipsHTML(opportunities);
}

function calculateRobustSDM(hID, aID, standings) {
    const sH = standings[hID]; const sA = standings[aID];
    if(!sH || !sA) return { val: 0 }; 
    const allTeams = Object.values(standings).sort((a,b) => b.pts - a.pts);
    const rH = allTeams.findIndex(t => t.id === hID) + 1;
    const rA = allTeams.findIndex(t => t.id === aID) + 1;
    let formH = sH.pts, formA = sA.pts;
    if (sH.history.length >= 5) formH = sH.pts - (sH.history[sH.history.length - 5] || 0);
    if (sA.history.length >= 5) formA = sA.pts - (sA.history[sA.history.length - 5] || 0);
    const virtualRH = rH - (formH / 2);
    const virtualRA = rA - (formA / 2);
    return { val: (virtualRA - virtualRH) * 1.2 };
}

function generateTipsHTML(opportunities) {
    opportunities.sort((a,b) => a.date - b.date);

    let html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Liste Paris - Live Action</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --green: #4ade80; --gold: #facc15; --red: #f87171; }
            body { background: var(--bg); color: var(--text); font-family: 'Roboto', sans-serif; padding: 30px; }
            h1 { text-align:center; color:#38bdf8; margin-bottom:10px; }
            .subtitle { text-align:center; color:#94a3b8; margin-bottom:40px; }
            
            table { width: 100%; max-width: 1100px; margin: 0 auto; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; }
            th { background: #020617; padding: 15px; text-align: left; color: #94a3b8; font-size: 0.85em; text-transform:uppercase; }
            td { padding: 15px; border-bottom: 1px solid #334155; vertical-align: middle; }
            
            .badge { padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 0.8em; }
            .b-15 { background: rgba(250,204,21,0.2); color: var(--gold); border: 1px solid var(--gold); }
            .b-10 { background: rgba(203,213,225,0.2); color: #cbd5e1; border: 1px solid #cbd5e1; }
            .b-5 { background: rgba(251,146,60,0.2); color: #fb923c; border: 1px solid #fb923c; }

            .odd-box { background: #334155; padding: 5px 10px; border-radius: 4px; font-weight: bold; font-size: 1.2em; display: inline-block; }
            .stake-box { border: 1px solid white; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold; background: rgba(255,255,255,0.1); }
            
            .sel { font-size: 1.1em; font-weight: 900; color: var(--green); text-decoration: underline; text-underline-offset: 3px; }
            .match-row:hover { background: rgba(255,255,255,0.02); }
            .date-header { background: #334155; color: white; font-weight: bold; padding: 10px 15px; margin-top: 10px; display: table-cell; }
            
            .status-live { color: var(--red); font-weight: bold; animation: pulse 2s infinite; }
            .status-ns { color: #94a3b8; }
            .status-ft { color: var(--green); }
            @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
        </style>
    </head>
    <body>
        <h1>FEUILLE DE MATCH (TEST 5€)</h1>
        <div class="subtitle">Paris Détectés • 19 & 20 Décembre 2025 • Tout Statut</div>

        <table>
            <thead>
                <tr>
                    <th width="10%">Heure</th>
                    <th width="10%">Statut</th>
                    <th width="30%">Match</th>
                    <th width="15%">Confiance</th>
                    <th width="20%">Pari & Cote</th>
                    <th width="15%">Mise Fixe</th>
                </tr>
            </thead>
            <tbody>
                ${(() => {
                    if(opportunities.length === 0) return `<tr><td colspan="6" style="text-align:center;padding:40px">Aucun pari "Value" détecté pour ces dates.</td></tr>`;
                    
                    let rows = '';
                    let lastDay = '';
                    opportunities.forEach(o => {
                        const day = o.date.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric'});
                        if(day !== lastDay) {
                            rows += `<tr><td colspan="6" style="background:#475569; color:white; font-weight:bold; padding:8px;">${day}</td></tr>`;
                            lastDay = day;
                        }

                        let bCls = o.range === '15+' ? 'b-15' : (o.range === '10-15' ? 'b-10' : 'b-5');
                        
                        // Style Statut
                        let statCls = 'status-ns';
                        if(['1H','HT','2H','ET','P','LIVE'].includes(o.status.split(' ')[0])) statCls = 'status-live';
                        if(o.status.includes('FT')) statCls = 'status-ft';

                        rows += `
                        <tr class="match-row">
                            <td>${o.date.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})}</td>
                            <td class="${statCls}">${o.status}</td>
                            <td>
                                <div style="font-weight:bold; font-size:1.1em; margin-bottom:4px;">${o.match}</div>
                                <div style="font-size:0.8em; color:#94a3b8">${o.league}</div>
                            </td>
                            <td>
                                <span class="badge ${bCls}">Score ${o.score}</span>
                                <div style="font-size:0.7em; margin-top:4px; color:#94a3b8">Min: ${o.minOdd}</div>
                            </td>
                            <td>
                                <div style="margin-bottom:4px">Vainqueur: <span class="sel">${o.selection}</span></div>
                                <div class="odd-box">${o.odd.toFixed(2)}</div>
                                <span style="font-size:0.8em; color:#4ade80; margin-left:8px">+${o.value}% Val.</span>
                            </td>
                            <td>
                                <div class="stake-box">${o.stake} €</div>
                            </td>
                        </tr>`;
                    });
                    return rows;
                })()}
            </tbody>
        </table>
    </body>
    </html>`;

    const server = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'}); res.end(html); });
    server.listen(PORT, () => { 
        console.log(`✅ LISTE LIVE PRÊTE : http://localhost:${PORT}`);
        const s = (process.platform=='darwin'?'open':process.platform=='win32'?'start':'xdg-open');
        exec(`${s} http://localhost:${PORT}`);
    });
}

runLiveAction();