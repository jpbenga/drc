const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

const PORT = 3000;

// ON DÉFINIT DES TRANCHES DE SCORE (RANGES) POUR TOUT VOIR
const RANGES = [
    { min: 0,  max: 5,  label: "FAIBLE (0-5)" },
    { min: 5,  max: 10, label: "MOYEN (5-10)" },
    { min: 10, max: 15, label: "ÉLEVÉ (10-15)" },
    { min: 15, max: 99, label: "EXTRÊME (15+)" }
];

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

function runSpectrumAudit() {
    console.clear();
    console.log(`📊 AUDIT SPECTRE COMPLET (0 à 15+)`);
    console.log(`==================================`);

    let report = [];

    for (const league of LEAGUES) {
        try {
            const hFile = `history_${league.id}.json`;
            if (!fs.existsSync(hFile)) continue;
            
            const raw = fs.readFileSync(hFile);
            const history = JSON.parse(raw);
            history.sort((a,b) => new Date(a.fixture.date) - new Date(b.fixture.date));
            
            // Structure de stockage par tranche
            let stats = {
                id: league.id, name: league.name, totalMatches: 0,
                ranges: {
                    '0-5':   { bets: 0, wins: 0 },
                    '5-10':  { bets: 0, wins: 0 },
                    '10-15': { bets: 0, wins: 0 },
                    '15+':   { bets: 0, wins: 0 }
                }
            };

            let standings = {}; 

            for (const m of history) {
                const hID = m.teams.home.id; const aID = m.teams.away.id;
                
                // Init Classement
                if(!standings[hID]) standings[hID] = { id: hID, pts: 0, history: [] };
                if(!standings[aID]) standings[aID] = { id: aID, pts: 0, history: [] };

                // --- CALCUL DU SCORE (Même logique que précédemment) ---
                const sdm = calculateRobustSDM(hID, aID, standings);
                const absScore = Math.abs(sdm.val);
                const predSide = sdm.val > 0 ? 'Home' : 'Away';

                // --- CLASSEMENT DANS LA BONNE TRANCHE ---
                let rangeKey = '';
                if (absScore < 5) rangeKey = '0-5';
                else if (absScore < 10) rangeKey = '5-10';
                else if (absScore < 15) rangeKey = '10-15';
                else rangeKey = '15+';

                // --- VÉRIFICATION DU RÉSULTAT ---
                let winner = 'Draw';
                if (m.goals.home > m.goals.away) winner = 'Home';
                else if (m.goals.away > m.goals.home) winner = 'Away';

                stats.totalMatches++;
                stats.ranges[rangeKey].bets++;
                
                // On compte une victoire si la prédiction (basée sur le score) est correcte
                // Note : Pour 0-5, la "prédiction" est faible, mais on vérifie quand même si l'algo avait la bonne tendance
                if (predSide === winner) {
                    stats.ranges[rangeKey].wins++;
                }

                // --- UPDATE CLASSEMENT ---
                let pH=1, pA=1;
                if (m.goals.home > m.goals.away) { pH=3; pA=0; } else if (m.goals.home < m.goals.away) { pH=0; pA=3; }
                
                standings[hID].pts += pH; standings[hID].history.push(standings[hID].pts);
                standings[aID].pts += pA; standings[aID].history.push(standings[aID].pts);
            }

            // Calculs des % et Breakeven pour chaque tranche
            for(const k in stats.ranges) {
                const d = stats.ranges[k];
                d.winRate = d.bets > 0 ? (d.wins / d.bets) * 100 : 0;
                d.be = d.winRate > 0 ? (100 / d.winRate) : 0;
            }

            report.push(stats);
            console.log(`✅ ${league.name.padEnd(20)} : ${stats.totalMatches} matchs analysés.`);

        } catch (err) { console.log(`Erreur ${league.name}`); }
    }

    startServer(report);
}

function calculateRobustSDM(hID, aID, standings) {
    const sH = standings[hID];
    const sA = standings[aID];
    if(!sH || !sA) return { val: 0 }; 

    const allTeams = Object.values(standings).sort((a,b) => b.pts - a.pts);
    const rH = allTeams.findIndex(t => t.id === hID) + 1;
    const rA = allTeams.findIndex(t => t.id === aID) + 1;

    let formH = 0; let formA = 0;
    if (sH.history.length >= 5) formH = sH.pts - (sH.history[sH.history.length - 5] || 0);
    else formH = sH.pts; 

    if (sA.history.length >= 5) formA = sA.pts - (sA.history[sA.history.length - 5] || 0);
    else formA = sA.pts;

    const virtualRH = rH - (formH / 2);
    const virtualRA = rA - (formA / 2);

    return { val: (virtualRA - virtualRH) * 1.2 };
}

function startServer(report) {
    const html = `
    <!DOCTYPE html><html><head><title>Audit Spectre Complet</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
    <style>
        body{background:#0f172a;color:#f1f5f9;font-family:'Inter',sans-serif;padding:30px}
        table{width:100%;border-collapse:collapse;background:#1e293b;margin-bottom:30px}
        th{text-align:center;padding:12px;background:#020617;color:#94a3b8;font-size:0.8em;text-transform:uppercase;border:1px solid #334155}
        td{padding:10px;border:1px solid #334155;vertical-align:middle;text-align:center}
        .lg-name{text-align:left;font-weight:bold;color:#38bdf8}
        .cell-content{display:flex;flex-direction:column;align-items:center;justify-content:center}
        .rate{font-weight:bold;font-size:1.1em}
        .be{font-size:0.75em;color:#cbd5e1;background:#334155;padding:2px 6px;border-radius:4px;margin-top:4px}
        .count{font-size:0.7em;color:#64748b;margin-top:2px}
        
        /* Heatmap Colors */
        .bad { color: #f87171; } /* < 40% */
        .avg { color: #facc15; } /* 40-55% */
        .good { color: #4ade80; } /* > 55% */
    </style></head><body>
    <h1 style="text-align:center;color:#38bdf8">📊 AUDIT DE SPECTRE COMPLET</h1>
    <p style="text-align:center;color:#94a3b8">Analyse de la performance de l'algo tranche par tranche (0 à 15+)</p>
    
    <table>
        <thead>
            <tr>
                <th width="20%">Championnat</th>
                <th width="20%">SCORE 0 à 5<br><small>(Faible Confiance)</small></th>
                <th width="20%">SCORE 5 à 10<br><small>(Moyenne Confiance)</small></th>
                <th width="20%">SCORE 10 à 15<br><small>(Forte Confiance)</small></th>
                <th width="20%">SCORE 15+<br><small>(Très Forte Confiance)</small></th>
            </tr>
        </thead>
        <tbody>
            ${report.map(r => {
                const getCell = (d) => {
                    if(d.bets === 0) return `<span style="opacity:0.2">-</span>`;
                    let col = 'avg';
                    if(d.winRate > 55) col = 'good';
                    if(d.winRate < 40) col = 'bad';
                    
                    return `
                    <div class="cell-content">
                        <span class="rate ${col}">${d.winRate.toFixed(1)}%</span>
                        <span class="be">Cote Min: ${d.be.toFixed(2)}</span>
                        <span class="count">${d.wins}/${d.bets}</span>
                    </div>`;
                };

                return `<tr>
                    <td class="lg-name">${r.name}<br><small style="color:#64748b;font-weight:normal">${r.totalMatches} matchs</small></td>
                    <td>${getCell(r.ranges['0-5'])}</td>
                    <td>${getCell(r.ranges['5-10'])}</td>
                    <td>${getCell(r.ranges['10-15'])}</td>
                    <td>${getCell(r.ranges['15+'])}</td>
                </tr>`;
            }).join('')}
        </tbody>
    </table>
    </body></html>`;

    const server = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'text/html;charset=utf-8'}); res.end(html); });
    server.listen(PORT, () => { 
        console.log(`✅ RAPPORT GÉNÉRÉ : http://localhost:${PORT}`);
        const s = (process.platform=='darwin'?'open':process.platform=='win32'?'start':'xdg-open');
        exec(`${s} http://localhost:${PORT}`);
    });
}

runSpectrumAudit();