const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// =================================================================
// 🧠 CONFIGURATION "MONEY MANAGEMENT" (KELLY & COMPOSÉS)
// =================================================================
const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const SEASON = 2025; 
const PORT = 3000;
const PENDING_FILE = 'bets_pending.json';
const HISTORY_FILE = 'bets_history.json';

const STRATEGY = {
    START_BANKROLL: 150, // Votre capital de départ initial
    
    // FRACTION DE KELLY (Sécurité)
    // 1.0 = Kelly Pur (Très agressif, risque de grosses variations)
    // 0.1 à 0.2 = Recommandé pour la sécurité (10% à 20% de la mise "idéale")
    KELLY_FRACTION: 0.15, 

    // TAUX DE RÉUSSITE ESTIMÉ (p) POUR LE CALCUL DE KELLY
    // Ajustez ces % en fonction de vos rapports d'Audit passés
    WIN_PROBABILITY: {
        'SUPREME': 0.75, // On estime qu'on gagne 75% du temps sur les scores 15+
        'SOLID':   0.60, // On estime 60% de réussite sur les scores 10-15
        'VALUE':   0.45  // On estime 45% de réussite sur les scores 5-10
    },

    MIN_ODDS: {
        'SUPREME': 1.40,
        'SOLID':   1.60,
        'VALUE':   1.90
    },

    // Limites de mise (Sécurité supplémentaire)
    MAX_STAKE_PCT: 0.05 // On ne mise jamais plus de 5% de la bankroll sur un seul match
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

// =================================================================

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startScanner() {
    console.clear();
    console.log(`\n🧠 SCANNER PRO - INTELLIGENT BANKROLL`);
    
    // 1. Calcul de la Bankroll Dynamique (Intérêts Composés)
    const currentBankroll = calculateCurrentBankroll();
    console.log(`💰 Bankroll Actuelle : ${currentBankroll.toFixed(2)} € (Départ: ${STRATEGY.START_BANKROLL} €)`);

    // 2. Charger l'historique Algo
    let history = loadHistory();
    console.log(`✅ Historique Algo chargé.`);

    // 3. Scan avec calcul de mise Kelly
    console.log(`\n🔄 ANALYSE & CALCUL DES MISES OPTIMALES...`);
    const newBets = await runScan(history, currentBankroll);
    
    saveBets(newBets);

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(newBets, currentBankroll));
    });

    server.listen(PORT, () => {
        console.log(`\n🌐 RAPPORT STRATÉGIQUE : http://localhost:${PORT}`);
        const s = (process.platform=='darwin'?'open':process.platform=='win32'?'start':'xdg-open');
        exec(`${s} http://localhost:${PORT}`);
    });
}

function calculateCurrentBankroll() {
    let bankroll = STRATEGY.START_BANKROLL;
    
    // On lit l'historique des paris terminés
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            const bets = JSON.parse(fs.readFileSync(HISTORY_FILE));
            // On ajoute tous les PnL (Profits and Losses)
            // On ignore les paris VOID (annulés) car PnL = 0
            bets.forEach(b => {
                if (b.status !== 'VOID' && b.pnl) {
                    bankroll += b.pnl;
                }
            });
        } catch(e) {}
    }
    
    // On peut aussi déduire les mises engagées (paris en cours) pour être prudent
    // (Optionnel : ici on considère la bankroll disponible totale)
    return bankroll > 0 ? bankroll : 0; // Sécurité anti-négatif
}

function calculateKellyStake(tier, odd, bankroll) {
    const p = STRATEGY.WIN_PROBABILITY[tier] || 0.5; // Probabilité de gain estimée
    const b = odd - 1; // Cote nette (ex: cote 1.50 -> b = 0.50)
    const q = 1 - p;   // Probabilité de perte

    if (b <= 0) return 0;

    // Formule de Kelly : f = (bp - q) / b
    let f = ((b * p) - q) / b;

    // Si Kelly est négatif (espérance négative), on ne parie pas
    if (f <= 0) return 0;

    // Application de la Fraction de Sécurité (Kelly Fraction)
    f = f * STRATEGY.KELLY_FRACTION;

    // Application de la Limite Max (ex: max 5% de la bankroll)
    if (f > STRATEGY.MAX_STAKE_PCT) f = STRATEGY.MAX_STAKE_PCT;

    // Calcul de la mise en Euros
    let stake = bankroll * f;

    // Arrondi à 0.50€ près ou 1€ pour être propre
    return Math.max(1, Math.round(stake)); 
}

function loadHistory() {
    let snapshots = {}; let nameToId = {}; let lastRoundMap = {};
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

async function runScan(history, bankroll) {
    let detectedBets = [];
    const datesToScan = [new Date(), new Date(new Date().setDate(new Date().getDate() + 1))];

    for (const d of datesToScan) {
        const dateStr = d.toISOString().split('T')[0];
        console.log(`\n📅 Date: ${dateStr}`);

        for (const league of LEAGUES) {
            try {
                const mRes = await axios.get('https://v3.football.api-sports.io/fixtures', {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { league: league.id, season: SEASON, date: dateStr, status: 'NS' }
                });
                
                if (mRes.data.response.length === 0) continue;
                process.stdout.write(`Scanning ${league.name}... `);

                for (const m of mRes.data.response) {
                    const hName = m.teams.home.name; const aName = m.teams.away.name;
                    const sdmData = calculateSDM(hName, aName, history.snapshots[league.id], history.lastRoundMap[league.id], history.nameToId);
                    
                    if (sdmData && Math.abs(sdmData.val) >= 5) { 
                        let tier = 'VALUE';
                        if(Math.abs(sdmData.val) >= 15) tier = 'SUPREME';
                        else if(Math.abs(sdmData.val) >= 10) tier = 'SOLID';
                        
                        const predSide = sdmData.val > 0 ? 'Home' : 'Away';
                        const minOddReq = STRATEGY.MIN_ODDS[tier];

                        let oddInfo = { val: 0, bookie: '-', valuePct: 0 };
                        await delay(120); 
                        
                        try {
                            const oRes = await axios.get('https://v3.football.api-sports.io/odds', {
                                headers: { 'x-apisports-key': API_KEY },
                                params: { fixture: m.fixture.id }
                            });
                            
                            const books = oRes.data.response[0]?.bookmakers || [];
                            if (books.length > 0) {
                                for (const bm of books) {
                                    const bets = bm.bets.find(b => b.id === 1);
                                    if(bets) {
                                        const v = bets.values.find(x => x.value === predSide);
                                        if(v && parseFloat(v.odd) > oddInfo.val) {
                                            oddInfo.val = parseFloat(v.odd);
                                            oddInfo.bookie = bm.name;
                                        }
                                    }
                                }
                            }
                        } catch(e) {}

                        // FILTRE FINAL
                        if (oddInfo.val >= minOddReq) {
                            oddInfo.valuePct = ((oddInfo.val/minOddReq)-1)*100;
                            
                            // --- CALCUL INTELLIGENT DE LA MISE (KELLY) ---
                            const smartStake = calculateKellyStake(tier, oddInfo.val, bankroll);
                            
                            if (smartStake > 0) {
                                detectedBets.push({
                                    id: m.fixture.id,
                                    date: m.fixture.date,
                                    league: league.name,
                                    match: `${hName} vs ${aName}`,
                                    score: Math.abs(sdmData.val).toFixed(1),
                                    tier: tier,
                                    pred: predSide,
                                    odd: oddInfo.val,
                                    bookie: oddInfo.bookie,
                                    stake: smartStake, // Mise calculée dynamiquement
                                    kelly_pct: ((smartStake/bankroll)*100).toFixed(1), // Pour info
                                    status: 'PENDING'
                                });
                            }
                        }
                    }
                }
                console.log(`OK`);
            } catch (e) { process.stdout.write("x"); }
        }
    }
    return detectedBets;
}

function saveBets(newBets) {
    let existingBets = [];
    if (fs.existsSync(PENDING_FILE)) {
        try { existingBets = JSON.parse(fs.readFileSync(PENDING_FILE)); } catch(e) {}
    }
    let addedCount = 0;
    newBets.forEach(bet => {
        const exists = existingBets.find(b => b.id === bet.id);
        if (!exists) { existingBets.push(bet); addedCount++; }
    });
    existingBets.sort((a,b) => new Date(a.date) - new Date(b.date));
    fs.writeFileSync(PENDING_FILE, JSON.stringify(existingBets, null, 2));
    console.log(`\n💾 SAUVEGARDE : ${addedCount} nouveaux paris ajoutés.`);
}

function calculateSDM(hName, aName, snapshots, lastRound, dict) {
    const hID = dict[hName]; const aID = dict[aName];
    if(!hID || !aID) return null;
    const getR = (r, id) => {
        if(!snapshots || !snapshots[r]) return 12;
        const s = Object.values(snapshots[r]).sort((a,b) => (b.pts-a.pts) || ((b.gf-b.ga)-(a.gf-a.ga)));
        const rk = s.findIndex(t => t.id === id) + 1;
        return rk > 0 ? rk : 18;
    };
    if(!lastRound || lastRound < 5) return { val: 0 };
    const rH = getR(lastRound, hID); const rA = getR(lastRound, aID);
    const vH = (getR(lastRound-5, hID) - rH) / 5;
    const vA = (getR(lastRound-5, aID) - rA) / 5;
    return { val: (rA - vA*1.2) - (rH - vH*1.2) };
}

// =================================================================
// 🎨 DESIGN "CASH.JS" ADAPTÉ
// =================================================================
function generateHTML(bets, currentBankroll) {
    const cGreen = '#4ade80'; const cMuted = '#94a3b8'; const cGold = '#facc15';
    const totalStake = bets.reduce((sum, b) => sum + b.stake, 0);
    const avgOdd = bets.length > 0 ? (bets.reduce((sum, b) => sum + b.odd, 0) / bets.length).toFixed(2) : 0;
    
    bets.sort((a,b) => new Date(a.date) - new Date(b.date));

    let html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Smart Scanner Pro</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #0f172a; --card: #1e293b; --border: #334155; }
            body { background: var(--bg); color: #f1f5f9; font-family: 'Roboto', sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 30px; }
            .header h1 { margin: 0; color: ${cGold}; font-size: 2em; text-transform:uppercase; }
            .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 30px; }
            .kpi-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; text-align: center; }
            .kpi-title { color: ${cMuted}; font-size: 0.8em; text-transform: uppercase; margin-bottom: 5px; }
            .kpi-val { font-size: 1.8em; font-weight: 900; }
            
            table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; margin-bottom: 40px; }
            th { background: #020617; color: ${cMuted}; padding: 12px; font-size: 0.85em; text-align: left; text-transform: uppercase; }
            td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 0.95em; vertical-align: middle; }
            
            .badge { padding: 3px 6px; border-radius: 4px; font-size: 0.75em; font-weight: bold; border: 1px solid currentColor; }
            .b-15 { color: #facc15; background: rgba(250,204,21,0.1); } 
            .b-10 { color: #cbd5e1; background: rgba(203,213,225,0.1); } 
            .b-5  { color: #fb923c; background: rgba(251,146,60,0.1); } 
            
            .team-sel { color: ${cGreen}; font-weight: bold; text-decoration: underline; text-underline-offset: 3px; }
            .date-sep { background: #334155; color: white; padding: 8px 12px; font-size: 0.85em; font-weight: bold; letter-spacing: 1px; }
            .stake-box { font-weight:bold; padding:4px 8px; border:1px solid ${cGreen}; color:${cGreen}; border-radius:4px; display:inline-block;}
            .kelly-info { font-size:0.75em; color:${cMuted}; margin-top:2px; }
        </style>
    </head>
    <body>

    <div class="header">
        <div>
            <h1>OPPORTUNITÉS KELLY</h1>
            <div style="color:${cMuted}">Mises Dynamiques sur Bankroll de <b>${currentBankroll.toFixed(2)} €</b></div>
        </div>
        <div style="text-align:right; font-size:0.9em; color:${cMuted}">
            Scan: ${new Date().toLocaleTimeString()}
        </div>
    </div>

    <div class="kpi-row">
        <div class="kpi-card">
            <div class="kpi-title">Total Paris</div>
            <div class="kpi-val" style="color:${cGold}">${bets.length}</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">Exposition Totale</div>
            <div class="kpi-val">${totalStake} €</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">Cote Moyenne</div>
            <div class="kpi-val">${avgOdd}</div>
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th width="10%">Heure</th>
                <th width="40%">Match</th>
                <th width="15%">Confiance</th>
                <th width="15%">Cote</th>
                <th width="20%">Mise (Kelly)</th>
            </tr>
        </thead>
        <tbody>
            ${(() => {
                let rows = '';
                let lastDay = '';
                if(bets.length === 0) return '<tr><td colspan="5" style="text-align:center; padding:30px">Aucune opportunité détectée (ou cotes trop basses pour Kelly).</td></tr>';

                bets.forEach(b => {
                    const dObj = new Date(b.date);
                    const day = dObj.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
                    
                    if(day !== lastDay) {
                        rows += `<tr><td colspan="5" class="date-sep">${day}</td></tr>`;
                        lastDay = day;
                    }

                    let bCls = 'b-5';
                    if(b.tier === 'SUPREME') bCls = 'b-15';
                    else if(b.tier === 'SOLID') bCls = 'b-10';

                    rows += `<tr>
                        <td>${dObj.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})}</td>
                        <td>
                            <div>
                                <span class="${b.pred==='Home'?'team-sel':''}">${b.match.split(' vs ')[0]}</span>
                                <span style="font-size:0.8em; opacity:0.5; margin:0 5px">vs</span>
                                <span class="${b.pred==='Away'?'team-sel':''}">${b.match.split(' vs ')[1]}</span>
                            </div>
                            <div style="font-size:0.75em; color:${cMuted}">${b.league}</div>
                        </td>
                        <td>
                            <span class="badge ${bCls}">${b.tier}</span>
                            <div style="font-size:0.7em; margin-top:2px; color:${cMuted}">Score ${b.score}</div>
                        </td>
                        <td>
                            <div style="font-weight:bold; font-size:1.1em">${b.odd.toFixed(2)}</div>
                            <div style="font-size:0.7em; color:${cMuted}">${b.bookie}</div>
                        </td>
                        <td>
                            <span class="stake-box">${b.stake} €</span>
                            <div class="kelly-info">${b.kelly_pct}% de BK</div>
                        </td>
                    </tr>`;
                });
                return rows;
            })()}
        </tbody>
    </table>

    </body>
    </html>`;

    return html;
}

startScanner();