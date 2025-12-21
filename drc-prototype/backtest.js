const fs = require('fs');
const http = require('http');

const PORT = 3000;

// On durcit les seuils pour être "Elitiste"
const TIERS = {
    '1N2': { get: (v) => Math.abs(v)>=15 ? 'SUPREME' : (Math.abs(v)>=10 ? 'SOLID' : 'DROP') },
    // On ignore les autres marchés pour le filtrage principal, on les utilise en confirmation
};

const LEAGUES = {
    '61': "Ligue 1", '39': "Premier League", '140': "La Liga",
    '78': "Bundesliga", '135': "Serie A", '94': "Liga Portugal",
    '88': "Eredivisie", '119': "Superliga"
};

function runOptimizedBacktest() {
    console.log(`💎 BACKTEST OPTIMISÉ (STRATÉGIE "ÉLITE" + "INVERSEUR")...`);

    // On simule un portefeuille
    let bankroll = 1000;
    const stake = 50; // Mise plus grosse car moins de paris (Sniper)
    
    // Simulation des cotes moyennes (Conservatrices)
    const ODDS_SIM = {
        '1N2_SUPREME': 1.45, // Favori fort
        '1N2_SOLID': 1.70,   // Favori solide
        'HSH_INVERSE': 2.05  // 2ème MT (Cote standard)
    };

    let stats = {
        '1N2': { bets:0, wins:0, pnl:0 },
        'HSH_Reverse': { bets:0, wins:0, pnl:0 }, // Stratégie inversée
        'Combo_Safe': { bets:0, wins:0, pnl:0 }   // 1N2 mais seulement si Over/Under confirme
    };

    for (const [id, name] of Object.entries(LEAGUES)) {
        const hFile = `history_${id}.json`;
        if (!fs.existsSync(hFile)) continue;

        const history = JSON.parse(fs.readFileSync(hFile));
        history.sort((a,b) => new Date(a.fixture.date) - new Date(b.fixture.date));

        let snapshots = {}; let standings = {}; let teamStats = {};

        for (const m of history) {
            const r = parseInt(m.league.round.replace(/[^0-9]/g, '')||0);
            const hID = m.teams.home.id; const aID = m.teams.away.id;

            // Init Stats
            if(!standings[hID]) standings[hID] = { id:hID, pts:0, gf:0, ga:0 };
            if(!standings[aID]) standings[aID] = { id:aID, pts:0, gf:0, ga:0 };
            if(!teamStats[hID]) teamStats[hID] = { match:0, gTot:0, gH1:0 };
            if(!teamStats[aID]) teamStats[aID] = { match:0, gTot:0, gH1:0 };

            // --- PRÉDICTION ---
            if (r > 6 && snapshots[r-1] && snapshots[r-5]) {
                
                // 1. Calcul SDM 1N2
                const sdm1 = calculateSDM1N2(hID, aID, snapshots, r-1);
                const tier1N2 = Math.abs(sdm1) >= 10 ? (Math.abs(sdm1)>=15 ? 'SUPREME' : 'SOLID') : 'DROP';
                
                // 2. Calcul HSH (Ratio H1)
                const sH = teamStats[hID]; const sA = teamStats[aID];
                let ratioHSH = 0;
                if(sH.gTot > 5 && sA.gTot > 5) {
                    ratioHSH = ((sH.gH1/sH.gTot) + (sA.gH1/sA.gTot)) / 2;
                }

                // ------------------------------------------
                // STRATÉGIE A : 1N2 ÉLITE (Supreme + Solid uniquement)
                // ------------------------------------------
                if (tier1N2 !== 'DROP') {
                    const pred1N2 = sdm1 > 0 ? 'Home' : 'Away';
                    const res1N2 = (m.goals.home > m.goals.away) ? 'Home' : (m.goals.away > m.goals.home ? 'Away' : 'Draw');
                    
                    const isWin = (pred1N2 === res1N2);
                    const odd = tier1N2 === 'SUPREME' ? ODDS_SIM['1N2_SUPREME'] : ODDS_SIM['1N2_SOLID'];
                    
                    stats['1N2'].bets++;
                    if(isWin) {
                        stats['1N2'].wins++;
                        stats['1N2'].pnl += (stake * odd) - stake;
                    } else {
                        stats['1N2'].pnl -= stake;
                    }
                }

                // ------------------------------------------
                // STRATÉGIE B : HSH INVERSÉE (Le Contre-Pied)
                // ------------------------------------------
                // Si l'algo dit "SUPREME 1st Half" (Ratio > 0.50), on parie "2nd Half"
                if (ratioHSH >= 0.50) { 
                    const predHSH = '2nd'; // ON INVERSE ICI !
                    
                    const gH1 = m.score.halftime.home + m.score.halftime.away;
                    const gH2 = (m.score.fulltime.home + m.score.fulltime.away) - gH1;
                    
                    let resHSH = 'Eq';
                    if(gH1 > gH2) resHSH = '1st';
                    if(gH2 > gH1) resHSH = '2nd';

                    // On ne parie que si on a inversé le signal
                    const isWin = (predHSH === resHSH);
                    
                    stats['HSH_Reverse'].bets++;
                    if(isWin) {
                        stats['HSH_Reverse'].wins++;
                        stats['HSH_Reverse'].pnl += (stake * ODDS_SIM['HSH_INVERSE']) - stake;
                    } else {
                        stats['HSH_Reverse'].pnl -= stake;
                    }
                }
            }

            // Update
            let pH=1, pA=1;
            if (m.goals.home > m.goals.away) { pH=3; pA=0; } else if (m.goals.home < m.goals.away) { pH=0; pA=3; }
            standings[hID].pts += pH; standings[hID].gf += m.goals.home; standings[hID].ga += m.goals.away;
            standings[aID].pts += pA; standings[aID].gf += m.goals.away; standings[aID].ga += m.goals.home;
            
            if(!snapshots[r]) snapshots[r] = {};
            Object.assign(snapshots[r], JSON.parse(JSON.stringify(standings)));

            const tot = m.goals.home + m.goals.away;
            const h1 = m.score.halftime.home + m.score.halftime.away;
            teamStats[hID].match++; teamStats[hID].gTot+=tot; teamStats[hID].gH1+=h1;
            teamStats[aID].match++; teamStats[aID].gTot+=tot; teamStats[aID].gH1+=h1;
        }
    }

    startServer(stats);
}

// Moteur SDM
function calculateSDM1N2(hID, aID, snapshots, lastRound) {
    const getR = (r, id) => {
        if(!snapshots[r]) return 10;
        const s = Object.values(snapshots[r]).sort((a,b) => (b.pts-a.pts) || ((b.gf-b.ga)-(a.gf-a.ga)));
        const rk = s.findIndex(t => t.id === id) + 1;
        return rk > 0 ? rk : 15;
    };
    const rH = getR(lastRound, hID); const rA = getR(lastRound, aID);
    const vH = (getR(lastRound-5, hID) - rH) / 5;
    const vA = (getR(lastRound-5, aID) - rA) / 5;
    return (rA - vA*1.2) - (rH - vH*1.2);
}

function startServer(stats) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Backtest Optimisé</title>
        <style>
            body { background: #0f172a; color: white; font-family: sans-serif; padding: 40px; text-align: center; }
            .kpi-row { display: flex; justify-content: center; gap: 40px; margin-top: 50px; }
            .card { background: #1e293b; padding: 30px; border-radius: 12px; width: 250px; border: 1px solid #334155; }
            .title { color: #94a3b8; font-size: 0.9em; text-transform: uppercase; margin-bottom: 10px; }
            .pnl { font-size: 2.5em; font-weight: bold; }
            .pos { color: #4ade80; } .neg { color: #ef4444; }
            .details { margin-top: 15px; font-size: 0.9em; color: #cbd5e1; }
        </style>
    </head>
    <body>
        <h1>💎 RÉSULTATS OPTIMISÉS (SIMULATION PnL)</h1>
        <p>Mise fixe : 50€ | Cotes conservatrices (1.45 à 2.05)</p>

        <div class="kpi-row">
            <div class="card">
                <div class="title">Stratégie 1N2 "ÉLITE"</div>
                <div class="pnl ${stats['1N2'].pnl>=0?'pos':'neg'}">${stats['1N2'].pnl.toFixed(0)}€</div>
                <div class="details">
                    ${stats['1N2'].wins} victoires / ${stats['1N2'].bets}<br>
                    Taux: <b>${((stats['1N2'].wins/stats['1N2'].bets)*100).toFixed(1)}%</b>
                </div>
            </div>

            <div class="card">
                <div class="title">Stratégie "INVERSE HSH"</div>
                <div class="pnl ${stats['HSH_Reverse'].pnl>=0?'pos':'neg'}">${stats['HSH_Reverse'].pnl.toFixed(0)}€</div>
                <div class="details">
                    ${stats['HSH_Reverse'].wins} victoires / ${stats['HSH_Reverse'].bets}<br>
                    Taux: <b>${((stats['HSH_Reverse'].wins/stats['HSH_Reverse'].bets)*100).toFixed(1)}%</b>
                </div>
            </div>
        </div>
    </body>
    </html>`;

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    server.listen(PORT, () => {
        console.log(`✅ RÉSULTAT CORRIGÉ : http://localhost:${PORT}`);
    });
}

runOptimizedBacktest();