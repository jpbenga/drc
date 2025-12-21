const axios = require('axios');
const fs = require('fs');
const http = require('http');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const PORT = 3010;
const FILES = ['bets_history.json', 'bets_pending.json'];

// IDs 1xBet
const IDS = { WIN: 1, AH: 4, DC: 12, DNB: 20 };

async function runAudit() {
    console.log("🚀 DÉMARRAGE DE L'AUDIT STRATÉGIQUE...");
    
    // 1. Charger tes prédictions et tes scores SDM depuis tes fichiers
    let allPicks = [];
    FILES.forEach(file => {
        if (fs.existsSync(file)) {
            allPicks = allPicks.concat(JSON.parse(fs.readFileSync(file)));
        }
    });

    // On cible les matchs du jour (20/12/2025)
    const todayStr = "2025-12-20";
    const todayPicks = allPicks.filter(p => p.date && p.date.includes(todayStr));

    let auditData = [];

    for (const p of todayPicks) {
        try {
            // 2. Chercher le VRAI SCORE et les COTES sur l'API
            // On fait deux requêtes par match pour être ultra précis
            const [fixtureRes, oddsRes] = await Promise.all([
                axios.get(`https://v3.football.api-sports.io/fixtures`, {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { id: p.id }
                }),
                axios.get(`https://v3.football.api-sports.io/odds`, {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { fixture: p.id, bookmaker: 1 }
                })
            ]);

            const fixture = fixtureRes.data.response[0];
            const bets = oddsRes.data.response[0]?.bookmakers[0]?.bets || [];
            
            // Récupération du VRAI SCORE (ex: "2-1")
            const realScore = `${fixture.goals.home}-${fixture.goals.away}`;
            const h = fixture.goals.home;
            const a = fixture.goals.away;

            const side = (p.pred === 'Home' || p.pred === '1') ? 'Home' : 'Away';
            
            const getOdd = (mId, label) => {
                const market = bets.find(b => b.id === mId);
                return market?.values.find(v => v.value.toString().includes(label))?.odd || 'N/A';
            };

            const odds = {
                win: getOdd(IDS.WIN, side),
                dc: getOdd(IDS.DC, side === 'Home' ? 'Home/Draw' : 'Draw/Away'),
                dnb: getOdd(IDS.DNB, side),
                ah1: getOdd(IDS.AH, `${side} -1`)
            };

            // LOGIQUE DE RÉSULTAT
            const isWin = (side === 'Home' && h > a) || (side === 'Away' && a > h);
            const isDraw = h === a;
            const diff = side === 'Home' ? h - a : a - h;

            const check = (type) => {
                if (type === 'win') return isWin ? 'WON' : 'LOST';
                if (type === 'dc') return (isWin || isDraw) ? 'WON' : 'LOST';
                if (type === 'dnb') return isDraw ? 'VOID' : (isWin ? 'WON' : 'LOST');
                if (type === 'ah1') return diff > 1 ? 'WON' : (diff === 1 ? 'VOID' : 'LOST');
            };

            auditData.push({
                match: p.match,
                sdm: p.sdm || p.score_sdm || "N/A", // Ton score algo
                realScore: realScore, // Le vrai score du match
                side: side,
                results: [
                    { label: 'WIN SEC', odd: odds.win, res: check('win') },
                    { label: 'DOUBLE CH.', odd: odds.dc, res: check('dc') },
                    { label: 'DNB', odd: odds.dnb, res: check('dnb') },
                    { label: 'AH -1.0', odd: odds.ah1, res: check('ah1') }
                ]
            });
            console.log(`✅ Analysé : ${p.match} [Score: ${realScore}]`);
        } catch (e) {
            console.log(`❌ Erreur match ${p.id}`);
        }
    }

    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(auditData));
    }).listen(PORT);

    console.log(`\n🌐 DASHBOARD : http://localhost:${PORT}`);
}

function generateHTML(data) {
    return `
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
        body { background: #050505; color: #fff; font-family: 'Inter', sans-serif; padding: 40px; }
        .match-card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 20px; margin-bottom: 15px; display: flex; align-items: center; justify-content: space-between; }
        .info { flex: 1; }
        .match-name { font-size: 1.1em; font-weight: 900; }
        .sdm-tag { color: #facc15; font-size: 0.8em; font-weight: bold; margin-top: 5px; }
        .score-box { background: #222; padding: 10px 20px; border-radius: 8px; font-size: 1.5em; font-weight: 900; color: #facc15; margin: 0 30px; border: 1px solid #333; }
        .odds-grid { display: flex; gap: 8px; }
        .odd-item { width: 90px; padding: 10px; border-radius: 8px; text-align: center; font-size: 0.8em; border: 1px solid #222; }
        .WON { background: rgba(34, 197, 94, 0.1); color: #4ade80; border-color: #166534; }
        .LOST { background: rgba(239, 68, 68, 0.1); color: #f87171; border-color: #991b1b; }
        .VOID { background: rgba(148, 163, 184, 0.1); color: #94a3b8; border-color: #475569; }
        .label { font-size: 0.7em; opacity: 0.6; margin-bottom: 3px; }
        .val { font-weight: 900; font-size: 1.1em; }
    </style></head><body>
        <h1 style="border-left: 4px solid #facc15; padding-left: 15px;">AUDIT STRATÉGIQUE (20/12)</h1>
        ${data.map(d => `
            <div class="match-card">
                <div class="info">
                    <div class="match-name">${d.match}</div>
                    <div class="sdm-tag">SDM: ${d.sdm} | PRÉD: ${d.side}</div>
                </div>
                <div class="score-box">${d.realScore}</div>
                <div class="odds-grid">
                    ${d.results.map(r => `
                        <div class="odd-item ${r.res}">
                            <div class="label">${r.label}</div>
                            <div class="val">${r.odd}</div>
                            <div style="font-size:0.7em; margin-top:3px">${r.res}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('')}
    </body></html>`;
}

runAudit();