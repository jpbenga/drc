const axios = require('axios');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');

// --- CONFIGURATION ---
const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const SEASON = 2025; 
const PORT = 3000;

// STRATÉGIE
const STRATEGY = {
    'SUPREME': { minScore: 15, minOdd: 1.43, stake: 10, color: '#FFD700', label: 'SUPRÊME' },
    'SOLID':   { minScore: 10, minOdd: 1.67, stake: 7,  color: '#C0C0C0', label: 'SOLIDE' },
    'VALUE':   { minScore: 5,  minOdd: 2.00, stake: 4,  color: '#CD7F32', label: 'VALUE' }
};

const LEAGUES = [
    { id: 61, name: "Ligue 1" },
    { id: 39, name: "Premier League" },
    { id: 140, name: "La Liga" },
    { id: 78, name: "Bundesliga" },
    { id: 135, name: "Serie A" },
    { id: 94, name: "Liga Portugal" },
    { id: 88, name: "Eredivisie" }
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- 1. SERVER START ---
async function startServer() {
    console.clear();
    console.log(`\n🎲 DRC ULTIMATE V3 - AVEC CALCUL DE MARGE BOOKMAKER`);
    console.log(`===================================================`);
    
    const historicalData = loadHistoricalData();
    console.log(`✅ Historique chargé.\n`);

    const server = http.createServer(async (req, res) => {
        if (req.url === '/') {
            console.log(`\n🔄 ANALYSE WEB LANCÉE...`);
            const html = await runAnalysis(historicalData);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            console.log(`📤 Rapport envoyé au navigateur.`);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    server.listen(PORT, () => {
        console.log(`🌐 SERVEUR ACTIF : http://localhost:${PORT}`);
        const start = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
        exec(`${start} http://localhost:${PORT}`);
    });
}

// --- 2. DATA LOADING ---
function loadHistoricalData() {
    let snapshots = {};
    let nameToId = {};
    let lastRoundMap = {};

    for (const league of LEAGUES) {
        const hFile = `history_${league.id}.json`;
        if (fs.existsSync(hFile)) {
            const hist = JSON.parse(fs.readFileSync(hFile));
            hist.sort((a,b)=>new Date(a.fixture.date)-new Date(b.fixture.date));
            hist.forEach(m => {
                nameToId[m.teams.home.name] = m.teams.home.id;
                nameToId[m.teams.away.name] = m.teams.away.id;
            });
            let current = {};
            const update = (m) => {
                const r = parseInt(m.league.round.replace(/[^0-9]/g, '')||0);
                const h=m.teams.home.id, a=m.teams.away.id;
                if(!current[h]) current[h]={id:h, pts:0, gf:0, ga:0};
                if(!current[a]) current[a]={id:a, pts:0, gf:0, ga:0};
                let pH=1, pA=1;
                if(m.goals.home > m.goals.away) {pH=3; pA=0;} else if(m.goals.home < m.goals.away) {pH=0; pA=3;}
                current[h].pts+=pH; current[h].gf+=m.goals.home; current[h].ga+=m.goals.away;
                current[a].pts+=pA; current[a].gf+=m.goals.away; current[a].ga+=m.goals.home;
                if(!snapshots[league.id]) snapshots[league.id] = {};
                snapshots[league.id][r] = JSON.parse(JSON.stringify(current));
            };
            hist.forEach(m => update(m));
            const rounds = Object.keys(snapshots[league.id]).map(Number).sort((a,b)=>a-b);
            lastRoundMap[league.id] = rounds[rounds.length-1];
        }
    }
    return { snapshots, nameToId, lastRoundMap };
}

// --- 3. ANALYSE & FETCHING ---
async function runAnalysis(history) {
    let displayData = {};

    for (const league of LEAGUES) {
        displayData[league.name] = { matches: [], round: '' };
        try {
            const rRes = await axios.get('https://v3.football.api-sports.io/fixtures/rounds', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, current: 'true' }
            });
            if (rRes.data.response.length === 0) continue;
            const currentRound = rRes.data.response[0];
            displayData[league.name].round = currentRound;
            
            console.log(`\n🏆 ${league.name} [${currentRound}]`);

            const mRes = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, round: currentRound }
            });
            
            for (const m of mRes.data.response) {
                const hName = m.teams.home.name;
                const aName = m.teams.away.name;
                
                const sdmData = calculateSDM(hName, aName, history.snapshots[league.id], history.lastRoundMap[league.id], history.nameToId);
                let tier = 'NEUTRE';
                let predSide = 'N/A';
                let exactScore = 0;

                if (sdmData) {
                    exactScore = Math.abs(sdmData.val).toFixed(1);
                    const val = Math.abs(sdmData.val);
                    if (val >= STRATEGY.SUPREME.minScore) tier = 'SUPREME';
                    else if (val >= STRATEGY.SOLID.minScore) tier = 'SOLID';
                    else if (val >= STRATEGY.VALUE.minScore) tier = 'VALUE';
                    predSide = sdmData.val > 0 ? 'Home' : 'Away';
                }

                // C. ODDS FETCHING
                let finalOdd = null;
                let bookieName = '-';
                let breakeven = 0;
                let valueMargin = -999;
                let stake = 0;
                let bookieOverround = 0; // La marge du bookmaker

                if (['NS', 'PST'].includes(m.fixture.status.short) && tier !== 'NEUTRE') {
                    process.stdout.write(`   > ${hName} vs ${aName} (Pred: ${predSide})... `);
                    await delay(120);

                    try {
                        const oRes = await axios.get('https://v3.football.api-sports.io/odds', {
                            headers: { 'x-apisports-key': API_KEY },
                            params: { fixture: m.fixture.id }
                        });

                        const books = oRes.data.response[0]?.bookmakers || [];
                        
                        if (books.length > 0) {
                            const bookieNames = books.map(b => b.name);
                            const hasBetclic = bookieNames.some(n => n.toLowerCase().includes('betclic'));
                            
                            const shortList = bookieNames.slice(0, 4).join(', ') + (bookieNames.length > 4 ? '...' : '');
                            console.log(`\n      🔎 ${books.length} Bookmakers: [${shortList}]`);
                            if (hasBetclic) console.log(`      ✅ Betclic PRÉSENT.`);
                            else console.log(`      ⚠️ Betclic ABSENT.`);

                            let bestOddFound = 0;
                            let bestBookie = '';
                            let bestBookieObj = null; // On garde l'objet pour calculer la marge après

                            for (const bm of books) {
                                const bets = bm.bets.find(b => b.id === 1);
                                if (bets) {
                                    const oddVal = bets.values.find(v => v.value === predSide);
                                    if (oddVal) {
                                        const oddFloat = parseFloat(oddVal.odd);
                                        if (oddFloat > bestOddFound) {
                                            bestOddFound = oddFloat;
                                            bestBookie = bm.name;
                                            bestBookieObj = bets; // On stocke les cotes de ce bookmaker
                                        }
                                    }
                                }
                            }

                            if (bestOddFound > 0) {
                                finalOdd = bestOddFound;
                                bookieName = bestBookie;
                                breakeven = ((1 / finalOdd) * 100).toFixed(1);
                                const minReq = STRATEGY[tier].minOdd;
                                valueMargin = ((finalOdd / minReq) - 1) * 100;
                                stake = STRATEGY[tier].stake;

                                // --- CALCUL DE LA MARGE DU BOOKMAKER ---
                                // On récupère Home, Draw, Away du MEILLEUR bookmaker trouvé
                                if(bestBookieObj) {
                                    const oH = parseFloat(bestBookieObj.values.find(v=>v.value==='Home')?.odd || 0);
                                    const oD = parseFloat(bestBookieObj.values.find(v=>v.value==='Draw')?.odd || 0);
                                    const oA = parseFloat(bestBookieObj.values.find(v=>v.value==='Away')?.odd || 0);
                                    
                                    if(oH > 0 && oD > 0 && oA > 0) {
                                        // Formule: (1/H + 1/D + 1/A) - 1
                                        const rawMargin = ((1/oH) + (1/oD) + (1/oA)) - 1;
                                        bookieOverround = (rawMargin * 100).toFixed(1);
                                    }
                                }

                                console.log(`      💰 Meilleure: ${finalOdd} (@ ${bookieName}) | Marge Bookie: ${bookieOverround}%`);
                            } else {
                                console.log(`      ❌ Pas de cote trouvée.`);
                            }
                        } else {
                            console.log(`[VIDE] API OK mais 0 cotes.`);
                        }
                    } catch (err) { console.log(`[ERREUR API]`); }
                }

                displayData[league.name].matches.push({
                    date: new Date(m.fixture.date),
                    hName, hLogo: m.teams.home.logo,
                    aName, aLogo: m.teams.away.logo,
                    tier, score: exactScore, pred: predSide,
                    odd: finalOdd, bookie: bookieName, be: breakeven, margin: valueMargin, stake,
                    bkMargin: bookieOverround // Nouvelle donnée
                });
            }
        } catch (e) { console.log(`Erreur globale sur ${league.name}: ${e.message}`); }
    }

    return generateHTML(displayData);
}

// --- 4. HTML GENERATION ---
function generateHTML(allLeaguesData) {
    let html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>DRC Ultimate V3</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #0f172a; --card: #1e293b; --text: #f1f5f9; --accent: #38bdf8; }
            body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 0; margin: 0; }
            .header { background: #020617; border-bottom: 1px solid #334155; padding: 25px 0; text-align: center; }
            .stats-container { display: flex; justify-content: center; gap: 20px; margin-top: 15px; flex-wrap: wrap;}
            .stat-box { background: #1e293b; padding: 12px 25px; border-radius: 8px; border: 1px solid #334155; min-width: 160px; }
            .stat-title { font-size: 0.75rem; font-weight: 800; letter-spacing: 1px; margin-bottom: 5px; }
            .stat-val { font-weight: 700; font-size: 0.9rem; }
            .container { max-width: 1200px; margin: 40px auto; padding: 0 20px; }
            .league-section { background: var(--card); border-radius: 12px; margin-bottom: 40px; border: 1px solid #334155; overflow: hidden; }
            .league-header { background: #0f172a; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
            .league-name { font-weight: 800; font-size: 1.2rem; color: white; }
            table { width: 100%; border-collapse: collapse; }
            th { text-align: left; padding: 15px; font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; background: rgba(0,0,0,0.2); }
            td { padding: 15px; border-bottom: 1px solid #334155; vertical-align: middle; font-size: 0.9rem; }
            .score-cell { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1.1rem; }
            .bookie-info { display: flex; flex-direction: column; font-size: 0.75rem; color: #94a3b8; margin-top: 4px; }
            .odd-big { font-size: 1.2rem; font-weight: 700; color: #f1f5f9; }
            .be-tag { font-size: 0.7rem; padding: 3px 8px; border-radius: 4px; background: #334155; color: #cbd5e1; font-family: monospace; }
            .stake-box { font-weight: 800; padding: 8px 16px; border-radius: 6px; text-align: center; display: inline-block; min-width: 50px; }
            .stake-high { background: rgba(255, 215, 0, 0.15); color: #FFD700; border: 1px solid #FFD700; }
            .stake-mid { background: rgba(192, 192, 192, 0.15); color: #C0C0C0; border: 1px solid #C0C0C0; }
            .stake-low { background: rgba(205, 127, 50, 0.15); color: #fbbf24; border: 1px solid #CD7F32; }
            .margin-pos { color: #34d399; font-weight: 700; }
            .margin-neg { color: #64748b; font-size: 0.8rem; }
            .team-row { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
            .team-logo { width: 22px; height: 22px; object-fit: contain; }
            .pred-highlight { color: var(--accent); font-weight: 700; }
            
            /* Styles pour la Marge Bookmaker */
            .bk-margin-good { color: #34d399; font-weight: 700; } /* Vert */
            .bk-margin-avg { color: #facc15; } /* Jaune */
            .bk-margin-bad { color: #f87171; } /* Rouge */
            .bk-margin-tag { font-size: 0.75rem; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1 style="margin:0; color:#38bdf8; font-size: 2.2rem;">DRC ULTIMATE V3</h1>
            <div style="font-size:0.9rem; color:#64748b; margin-top:8px;">Analyse Value & Marge Bookmaker</div>
            <div class="stats-container">
                <div class="stat-box" style="border-color: #FFD700;">
                    <div class="stat-title" style="color:#FFD700;">SUPRÊME</div>
                    <div class="stat-val">Score > 15 | WinRate 70%</div>
                    <div style="font-size:0.75rem; margin-top:5px;">Mise Max: 10 €</div>
                </div>
                <div class="stat-box" style="border-color: #C0C0C0;">
                    <div class="stat-title" style="color:#C0C0C0;">SOLIDE</div>
                    <div class="stat-val">Score > 10 | WinRate 60%</div>
                    <div style="font-size:0.75rem; margin-top:5px;">Mise: 7 €</div>
                </div>
                <div class="stat-box" style="border-color: #CD7F32;">
                    <div class="stat-title" style="color:#CD7F32;">VALUE</div>
                    <div class="stat-val">Score > 5 | WinRate 50%</div>
                    <div style="font-size:0.75rem; margin-top:5px;">Mise: 4 €</div>
                </div>
            </div>
        </div>

        <div class="container">
    `;

    for (const [lName, leagueData] of Object.entries(allLeaguesData)) {
        if (leagueData.matches.length === 0) continue;
        
        leagueData.matches.sort((a,b) => {
            const aValid = a.odd && a.margin > 0 ? 1 : 0;
            const bValid = b.odd && b.margin > 0 ? 1 : 0;
            if (aValid !== bValid) return bValid - aValid;
            if (a.odd && !b.odd) return -1;
            if (!a.odd && b.odd) return 1;
            return b.stake - a.stake;
        });

        html += `
            <div class="league-section">
                <div class="league-header">
                    <span class="league-name">${lName} <span style="font-weight:400; font-size:0.9rem; color:#64748b; margin-left:10px;">${leagueData.round}</span></span>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th width="8%">Heure</th>
                            <th width="30%">Rencontre</th>
                            <th width="10%">Score (SDM)</th>
                            <th width="15%">Cote & Bookie</th>
                            <th width="8%">Marge Bookie</th>
                            <th width="10%">Breakeven</th>
                            <th width="10%">Value</th>
                            <th width="9%" style="text-align:center;">Mise</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        leagueData.matches.forEach(m => {
            const dateStr = m.date.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
            let scoreStyle = 'color: #64748b';
            if(m.tier === 'SUPREME') scoreStyle = 'color: #FFD700';
            if(m.tier === 'SOLID') scoreStyle = 'color: #e2e8f0';
            if(m.tier === 'VALUE') scoreStyle = 'color: #fbbf24';

            let stakeHtml = '-';
            if(m.stake === 10) stakeHtml = `<div class="stake-box stake-high">10 €</div>`;
            else if(m.stake === 7) stakeHtml = `<div class="stake-box stake-mid">7 €</div>`;
            else if(m.stake === 4) stakeHtml = `<div class="stake-box stake-low">4 €</div>`;

            let marginHtml = '-';
            if(m.margin > -900) {
                if(m.margin > 0) marginHtml = `<span class="margin-pos">+${m.margin.toFixed(1)}%</span>`;
                else marginHtml = `<span class="margin-neg">${m.margin.toFixed(1)}%</span>`;
            }

            let oddBlock = '<span style="color:#475569; font-size:0.8rem; font-style:italic;">Indisponible</span>';
            if(m.odd) {
                oddBlock = `
                    <span class="odd-big">${m.odd}</span>
                    <div class="bookie-info">${m.bookie}</div>
                `;
            }

            // Gestion de l'affichage de la Marge Bookmaker
            let bkMarginHtml = '-';
            if(m.bkMargin > 0) {
                let marginClass = 'bk-margin-avg';
                if(m.bkMargin < 5.0) marginClass = 'bk-margin-good';
                if(m.bkMargin > 7.5) marginClass = 'bk-margin-bad';
                bkMarginHtml = `<span class="${marginClass} bk-margin-tag">${m.bkMargin}%</span>`;
            }

            const hClass = m.pred === 'Home' ? 'pred-highlight' : '';
            const aClass = m.pred === 'Away' ? 'pred-highlight' : '';

            html += `
                <tr>
                    <td style="color:#64748b; font-size:0.85rem;">${dateStr}</td>
                    <td>
                        <div class="team-row ${hClass}">
                            <img src="${m.hLogo}" class="team-logo"> ${m.hName}
                        </div>
                        <div class="team-row ${aClass}">
                            <img src="${m.aLogo}" class="team-logo"> ${m.aName}
                        </div>
                    </td>
                    <td>
                        <div class="score-cell" style="${scoreStyle}">${m.score}</div>
                        <div style="font-size:0.65rem; color:#64748b; margin-top:2px;">${STRATEGY[m.tier]?.label || ''}</div>
                    </td>
                    <td>${oddBlock}</td>
                    <td>${bkMarginHtml}</td>
                    <td>${m.be > 0 ? `<span class="be-tag">BE: ${m.be}%</span>` : '-'}</td>
                    <td>${marginHtml}</td>
                    <td style="text-align:center;">${stakeHtml}</td>
                </tr>
            `;
        });
        html += `</tbody></table></div>`;
    }
    html += `</div></body></html>`;
    return html;
}

// Helper SDM
function calculateSDM(hName, aName, leagueSnaps, round, dict) {
    if(!leagueSnaps || !round) return null;
    const hID = dict[hName]; const aID = dict[aName];
    if(!hID || !aID) return null;
    const getR = (r, id) => {
        if(!leagueSnaps[r]) return 15;
        const s = Object.values(leagueSnaps[r]).sort((a,b) => (b.pts-a.pts) || ((b.gf-b.ga)-(a.gf-a.ga)));
        const rk = s.findIndex(t => t.id === id)+1;
        return rk>0?rk:18;
    };
    const rH = getR(round, hID); const rA = getR(round, aID);
    const vH = ((getR(round-3,hID)-rH)/3 + (getR(round-5,hID)-rH)/5)/2;
    const vA = ((getR(round-3,aID)-rA)/3 + (getR(round-5,aID)-rA)/5)/2;
    return { val: (rA - vA*1.2) - (rH - vH*1.2) };
}

startServer();