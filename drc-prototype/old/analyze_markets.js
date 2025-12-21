const fs = require('fs');
const http = require('http');

const PORT = 3000;

const LEAGUES = {
    '61': "Ligue 1", '39': "Premier League", '140': "La Liga",
    '78': "Bundesliga", '135': "Serie A", '94': "Liga Portugal",
    '88': "Eredivisie", '119': "Superliga"
};

// --- CALIBRAGE DES TRANCHES (TIERS) ---
// Définir ce qui est "Supreme" ou "Solid" pour chaque marché
const DEFINITIONS = {
    '1N2': { // Ecart de classement corrigé
        getTier: (sdm) => {
            const val = Math.abs(sdm);
            if(val >= 15) return 'SUPREME';
            if(val >= 10) return 'SOLID';
            if(val >= 5) return 'VALUE';
            return 'LOW';
        }
    },
    'OU25': { // Moyenne de buts (Pivot 2.5)
        getTier: (avg) => {
            // Si > 3.2 buts ou < 1.8 buts, c'est très fort
            if(avg >= 3.20 || avg <= 1.80) return 'SUPREME';
            if(avg >= 2.90 || avg <= 2.10) return 'SOLID';
            if(avg >= 2.70 || avg <= 2.30) return 'VALUE';
            return 'LOW';
        }
    },
    'BTTS': { // Fréquence (Pivot 50%)
        getTier: (rate) => {
            // Si > 75% ou < 25%, c'est très fort
            if(rate >= 75 || rate <= 25) return 'SUPREME';
            if(rate >= 65 || rate <= 35) return 'SOLID';
            if(rate >= 55 || rate <= 45) return 'VALUE';
            return 'LOW';
        }
    },
    'HSH': { // Ratio H1 (Pivot 42-45%)
        getTier: (ratio) => {
            if(ratio >= 0.50) return 'SUPREME'; // +50% des buts en 1ère MT (Rare)
            if(ratio >= 0.46) return 'SOLID';
            if(ratio >= 0.42) return 'VALUE';
            return 'LOW'; // En dessous de 42%, c'est normal (2ème MT)
        }
    }
};

function runPureAnalysis() {
    console.log(`🧪 ANALYSE PURE (TAUX DE RÉUSSITE PAR TRANCHE)...`);

    let statsDB = {};
    let snapshots = {};
    let nameToId = {};
    let lastRoundMap = {};

    // 1. CHARGEMENT & CALCULS PRÉALABLES
    for (const [id, name] of Object.entries(LEAGUES)) {
        const hFile = `history_${id}.json`;
        if (fs.existsSync(hFile)) {
            const hist = JSON.parse(fs.readFileSync(hFile));
            
            // Stats cumulées (BTTS, O/U, HSH)
            hist.forEach(m => {
                nameToId[m.teams.home.name] = m.teams.home.id;
                nameToId[m.teams.away.name] = m.teams.away.id;
                const h=m.teams.home.name, a=m.teams.away.name;
                
                if(!statsDB[h]) statsDB[h] = { match:0, gTot:0, btts:0, gH1:0 };
                if(!statsDB[a]) statsDB[a] = { match:0, gTot:0, btts:0, gH1:0 };

                const tot = m.score.fulltime.home + m.score.fulltime.away;
                const h1 = m.score.halftime.home + m.score.halftime.away;
                const btts = (m.score.fulltime.home > 0 && m.score.fulltime.away > 0) ? 1 : 0;

                statsDB[h].match++; statsDB[h].gTot+=tot; statsDB[h].gH1+=h1; statsDB[h].btts+=btts;
                statsDB[a].match++; statsDB[a].gTot+=tot; statsDB[a].gH1+=h1; statsDB[a].btts+=btts;
            });

            // Reconstitution SDM 1N2
            hist.sort((a,b)=>new Date(a.fixture.date)-new Date(b.fixture.date));
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
                if(!snapshots[id]) snapshots[id] = {};
                snapshots[id][r] = JSON.parse(JSON.stringify(current));
            };
            hist.forEach(m => update(m));
            const rounds = Object.keys(snapshots[id]).map(Number).sort((a,b)=>a-b);
            lastRoundMap[id] = rounds[rounds.length-1];
        }
    }

    // Structure des résultats
    let matrix = {
        '1N2': { SUPREME: {ok:0, tot:0}, SOLID: {ok:0, tot:0}, VALUE: {ok:0, tot:0}, LOW: {ok:0, tot:0} },
        'OU25': { SUPREME: {ok:0, tot:0}, SOLID: {ok:0, tot:0}, VALUE: {ok:0, tot:0}, LOW: {ok:0, tot:0} },
        'BTTS': { SUPREME: {ok:0, tot:0}, SOLID: {ok:0, tot:0}, VALUE: {ok:0, tot:0}, LOW: {ok:0, tot:0} },
        'HSH': { SUPREME: {ok:0, tot:0}, SOLID: {ok:0, tot:0}, VALUE: {ok:0, tot:0}, LOW: {ok:0, tot:0} }
    };

    let report = [];

    // 2. ANALYSE
    for (const [id, name] of Object.entries(LEAGUES)) {
        const uFile = `ultimate_${id}.json`;
        if (!fs.existsSync(uFile)) continue;
        const matches = JSON.parse(fs.readFileSync(uFile));

        matches.forEach(m => {
            const h = m.info.home; const a = m.info.away;
            const sH = statsDB[h] || { match:1, gTot:2.5, btts:0.5, gH1:0.4 };
            const sA = statsDB[a] || { match:1, gTot:2.5, btts:0.5, gH1:0.4 };

            // RÉSULTATS RÉELS
            const rH = m.score.fulltime.home; const rA = m.score.fulltime.away;
            const rTot = rH + rA;
            const rH1 = m.score.halftime.home + m.score.halftime.away;
            const rH2 = rTot - rH1;
            const resWinner = rH > rA ? h : (rA > rH ? a : 'Draw');
            const resOU = rTot > 2.5 ? 'Over' : 'Under';
            const resBTTS = (rH > 0 && rA > 0) ? 'Yes' : 'No';
            let resHSH = 'Equal';
            if(rH1 > rH2) resHSH = '1st';
            if(rH2 > rH1) resHSH = '2nd';

            // --- 1N2 ---
            const sdm1N2 = calculateSDM1N2(h, a, snapshots[id], lastRoundMap[id], nameToId);
            if(sdm1N2) {
                const tier = DEFINITIONS['1N2'].getTier(sdm1N2.val);
                const pred = sdm1N2.val > 0 ? h : a; // >0 = Home Advantage (Rank inversé)
                const win = (pred === resWinner);
                matrix['1N2'][tier].tot++;
                if(win) matrix['1N2'][tier].ok++;
            }

            // --- OVER/UNDER ---
            const avg = (sH.gTot/sH.match + sA.gTot/sA.match) / 2;
            const tierOU = DEFINITIONS['OU25'].getTier(avg);
            const predOU = avg >= 2.5 ? 'Over' : 'Under';
            const winOU = (predOU === resOU);
            matrix['OU25'][tierOU].tot++;
            if(winOU) matrix['OU25'][tierOU].ok++;

            // --- BTTS ---
            const rate = ((sH.btts/sH.match + sA.btts/sA.match) / 2) * 100;
            const tierBTTS = DEFINITIONS['BTTS'].getTier(rate);
            const predBTTS = rate >= 50 ? 'Yes' : 'No';
            const winBTTS = (predBTTS === resBTTS);
            matrix['BTTS'][tierBTTS].tot++;
            if(winBTTS) matrix['BTTS'][tierBTTS].ok++;

            // --- HSH ---
            const ratio = (sH.gH1/sH.gTot + sA.gH1/sA.gTot) / 2;
            const tierHSH = DEFINITIONS['HSH'].getTier(ratio);
            const predHSH = ratio >= 0.48 ? '1st' : '2nd';
            const winHSH = (predHSH === resHSH);
            matrix['HSH'][tierHSH].tot++;
            if(winHSH) matrix['HSH'][tierHSH].ok++;

            // Stockage pour affichage
            report.push({
                match: `${h} vs ${a}`,
                league: name,
                res: `${rH}-${rA} (${rH1}-${m.score.halftime.away})`,
                m1: { tier: DEFINITIONS['1N2'].getTier(sdm1N2?.val || 0), win: (sdm1N2?.val>0?h:a)===resWinner },
                m2: { tier: tierOU, win: winOU, pred: predOU },
                m3: { tier: tierBTTS, win: winBTTS, pred: predBTTS },
                m4: { tier: tierHSH, win: winHSH, pred: predHSH }
            });
        });
    }

    startServer(matrix, report);
}

// Helper SDM 1N2
function calculateSDM1N2(hName, aName, leagueSnaps, round, dict) {
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

function startServer(matrix, report) {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Matrice de Puissance SDM</title>
        <style>
            body { background: #0f172a; color: #fff; font-family: sans-serif; padding: 20px; max-width: 1200px; margin: auto; }
            h1 { text-align: center; color: #facc15; }
            
            /* MATRICE */
            .matrix { width: 100%; border-collapse: collapse; margin-bottom: 50px; }
            .matrix th, .matrix td { border: 1px solid #334155; padding: 15px; text-align: center; }
            .matrix th { background: #1e293b; color: #94a3b8; }
            
            .rate-box { font-size: 1.5em; font-weight: bold; }
            .count-box { font-size: 0.8em; color: #94a3b8; }
            
            .tier-row-SUPREME td { background: rgba(239, 68, 68, 0.1); }
            .tier-row-SOLID td { background: rgba(168, 85, 247, 0.1); }
            
            .high-rate { color: #4ade80; } /* > 60% */
            .mid-rate { color: #facc15; } /* 40-60% */
            .low-rate { color: #ef4444; } /* < 40% */

            /* DETAIL MATCHS */
            .match-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }
            .card { background: #1e293b; padding: 15px; border-radius: 8px; border: 1px solid #334155; }
            .res-tag { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
            .win { background: #4ade80; } .loss { background: #ef4444; }
        </style>
    </head>
    <body>
        <h1>🎯 TAUX DE RÉUSSITE PAR TRANCHE SDM</h1>
        <p style="text-align:center; color:#94a3b8">Indépendant des cotes. C'est la précision pure de l'algo.</p>

        <table class="matrix">
            <thead>
                <tr>
                    <th>Tranche SDM</th>
                    <th>1N2 (Vainqueur)</th>
                    <th>Over/Under 2.5</th>
                    <th>BTTS (2 Marquent)</th>
                    <th>Mi-temps (HSH)</th>
                </tr>
            </thead>
            <tbody>
                ${['SUPREME', 'SOLID', 'VALUE', 'LOW'].map(tier => `
                <tr class="tier-row-${tier}">
                    <td style="font-weight:bold">${tier}</td>
                    ${['1N2', 'OU25', 'BTTS', 'HSH'].map(m => {
                        const d = matrix[m][tier];
                        const rate = d.tot > 0 ? (d.ok/d.tot)*100 : 0;
                        let col = 'mid-rate';
                        if(rate >= 60) col = 'high-rate';
                        if(rate < 40) col = 'low-rate';
                        return `
                        <td>
                            <div class="rate-box ${col}">${rate.toFixed(1)}%</div>
                            <div class="count-box">${d.ok}/${d.tot} matchs</div>
                        </td>`;
                    }).join('')}
                </tr>
                `).join('')}
            </tbody>
        </table>

        <h3>Détails des derniers matchs</h3>
        <div class="match-grid">
            ${report.map(m => `
                <div class="card">
                    <div style="font-weight:bold; font-size:0.9em; color:#94a3b8">${m.league}</div>
                    <div style="margin-bottom:5px">${m.match} <span style="float:right; color:#facc15">${m.res}</span></div>
                    <div style="font-size:0.8em; display:flex; justify-content:space-between;">
                        <span>1N2: <span class="res-tag ${m.m1.win?'win':'loss'}"></span>${m.m1.tier}</span>
                        <span>O/U: <span class="res-tag ${m.m2.win?'win':'loss'}"></span>${m.m2.tier}</span>
                    </div>
                    <div style="font-size:0.8em; display:flex; justify-content:space-between; margin-top:5px">
                        <span>BTTS: <span class="res-tag ${m.m3.win?'win':'loss'}"></span>${m.m3.tier}</span>
                        <span>MT: <span class="res-tag ${m.m4.win?'win':'loss'}"></span>${m.m4.tier}</span>
                    </div>
                </div>
            `).join('')}
        </div>

    </body>
    </html>`;

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    server.listen(PORT, () => {
        console.log(`✅ MATRICE DE VÉRITÉ : http://localhost:${PORT}`);
    });
}

runPureAnalysis();