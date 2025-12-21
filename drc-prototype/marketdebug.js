const axios = require('axios');
const fs = require('fs');
const http = require('http');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const PORT = 3010;
const FILES = ['bets_history.json', 'bets_pending.json'];

// IDs strictement limités à tes logs 1xBet
const IDS = { WIN: 1, AH: 4, DC: 12 };

async function runAudit() {
    let allPicks = [];
    FILES.forEach(file => {
        if (fs.existsSync(file)) {
            allPicks = allPicks.concat(JSON.parse(fs.readFileSync(file)));
        }
    });

    // On ne prend que les matchs PERDUS d'aujourd'hui (20/12)
    const lostPicks = allPicks.filter(p => 
        p.date && p.date.includes("2025-12-20") && p.res === 'LOST'
    );

    console.log(`🔍 Analyse de ${lostPicks.length} matchs perdus...`);

    let auditData = [];

    for (const p of lostPicks) {
        try {
            const [fixRes, oddsRes] = await Promise.all([
                axios.get(`https://v3.football.api-sports.io/fixtures`, {
                    headers: { 'x-apisports-key': API_KEY }, params: { id: p.id }
                }),
                axios.get(`https://v3.football.api-sports.io/odds`, {
                    headers: { 'x-apisports-key': API_KEY }, params: { fixture: p.id, bookmaker: 1 }
                })
            ]);

            const f = fixRes.data.response[0];
            const bets = oddsRes.data.response[0]?.bookmakers[0]?.bets || [];
            
            const h = f.goals.home ?? 0;
            const a = f.goals.away ?? 0;
            const side = (p.pred === 'Home' || p.pred === '1') ? 'Home' : 'Away';

            const getOdd = (mId, terms) => {
                const market = bets.find(b => b.id === mId);
                return market?.values.find(v => terms.every(t => v.value.includes(t)))?.odd || 'N/A';
            };

            const odds = {
                win: getOdd(IDS.WIN, [side]),
                draw: getOdd(IDS.WIN, ['Draw']),
                dc: getOdd(IDS.DC, side === 'Home' ? ['Home/Draw'] : ['Draw/Away']),
                dnb: getOdd(IDS.AH, [side, '+0']),
                ah1: getOdd(IDS.AH, [side, '-1'])
            };

            // Logique de calcul des gains selon le score réel
            const isWin = (side === 'Home' && h > a) || (side === 'Away' && a > h);
            const isDraw = h === a;
            const diff = side === 'Home' ? h - a : a - h;

            const check = (type) => {
                if (type === 'win') return isWin ? 'WON' : 'LOST';
                if (type === 'draw') return isDraw ? 'WON' : 'LOST';
                if (type === 'dc') return (isWin || isDraw) ? 'WON' : 'LOST';
                if (type === 'dnb') return isDraw ? 'VOID' : (isWin ? 'WON' : 'LOST');
                if (type === 'ah1') return diff > 1 ? 'WON' : (diff === 1 ? 'VOID' : 'LOST');
            };

            auditData.push({
                match: p.match,
                sdm: p.sdm || p.score_sdm || "N/A",
                score: `${h}-${a}`,
                side: side,
                results: [
                    { label: 'WIN SEC', odd: odds.win, res: check('win') },
                    { label: 'NUL', odd: odds.draw, res: check('draw') },
                    { label: 'DOUBLE CH.', odd: odds.dc, res: check('dc') },
                    { label: 'DNB (+0)', odd: odds.dnb, res: check('dnb') },
                    { label: 'AH -1.0', odd: odds.ah1, res: check('ah1') }
                ]
            });
        } catch (e) { console.log(`Err: ${p.match}`); }
    }

    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateHTML(auditData));
    }).listen(PORT, () => {
        console.log(`✅ Audit généré : http://localhost:${PORT}`);
    });
}

function generateHTML(data) {
    return `
    <!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
        body { background: #050505; color: #fff; font-family: 'Inter', sans-serif; padding: 30px; }
        .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 20px; margin-bottom: 10px; display: flex; align-items: center; }
        .info { flex: 1; }
        .match-name { font-weight: 900; font-size: 1.1em; }
        .score { background: #222; padding: 10px 15px; border-radius: 8px; font-size: 1.4em; font-weight: 900; color: #facc15; margin: 0 20px; border: 1px solid #333; }
        .grid { display: flex; gap: 5px; }
        .item { width: 85px; padding: 8px; border-radius: 6px; text-align: center; font-size: 0.75em; border: 1px solid #222; }
        .WON { background: rgba(34, 197, 94, 0.1); color: #4ade80; border-color: #166534; }
        .LOST { background: rgba(239, 68, 68, 0.1); color: #f87171; border-color: #991b1b; }
        .VOID { background: rgba(148, 163, 184, 0.1); color: #94a3b8; border-color: #475569; }
        .label { opacity: 0.5; margin-bottom: 2px; }
        .val { font-weight: 900; }
    </style></head><body>
        <h1 style="border-left: 4px solid #facc15; padding-left: 15px;">SCÉNARIOS SUR MATCHS PERDUS (20/12)</h1>
        ${data.map(d => `
            <div class="card">
                <div class="info">
                    <div class="match-name">${d.match}</div>
                    <div style="color:#facc15; font-size:0.8em">SDM: ${d.sdm} | RECO: ${d.side}</div>
                </div>
                <div class="score">${d.score}</div>
                <div class="grid">
                    ${d.results.map(r => `
                        <div class="item ${r.res}">
                            <div class="label">${r.label}</div>
                            <div class="val">${r.odd}</div>
                            <div style="font-size:0.8em">${r.res}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('')}
    </body></html>`;
}

runAudit();