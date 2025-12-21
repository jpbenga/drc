const axios = require('axios');
const fs = require('fs');

// --- CONFIGURATION ---
const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const SEASON = 2025; 

// VOS STATS RÉELLES (issues du Backtest)
const ALGO_PERF = {
    'SUPREME': { winRate: 0.70, minOdd: 1.43 }, // 70% de réussite
    'SOLID':   { winRate: 0.60, minOdd: 1.67 }, // 60% de réussite
    'VALUE':   { winRate: 0.50, minOdd: 2.00 }  // 50% de réussite
};

const LEAGUES = [
    { id: 61, name: "Ligue 1" },
    { id: 39, name: "Premier League" },
    { id: 140, name: "La Liga" },
    { id: 78, name: "Bundesliga" },
    { id: 135, name: "Serie A" },
    { id: 94, name: "Liga Portugal" },
    { id: 88, name: "Eredivisie" },
    { id: 119, name: "Superliga" }
];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function findValueBets() {
    console.log(`💎 RECHERCHE DE "VALUE BETS" (MATHÉMATIQUES)...`);
    console.log(`   Règle: On ne joue que si la Cote > Cote Minimale de la tranche.\n`);

    let opportunities = [];

    // 1. CHARGEMENT DE L'INTELLIGENCE (Historique pour SDM)
    let snapshots = {};
    let nameToId = {};
    let lastRoundMap = {};

    for (const league of LEAGUES) {
        const hFile = `history_${league.id}.json`;
        if (fs.existsSync(hFile)) {
            const hist = JSON.parse(fs.readFileSync(hFile));
            hist.sort((a,b)=>new Date(a.fixture.date)-new Date(b.fixture.date));
            
            // Build Maps
            hist.forEach(m => {
                nameToId[m.teams.home.name] = m.teams.home.id;
                nameToId[m.teams.away.name] = m.teams.away.id;
            });

            // Build Standings
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

    // 2. SCAN DES MATCHS À VENIR
    for (const league of LEAGUES) {
        process.stdout.write(`Scanning ${league.name}... `);
        try {
            // Récupérer les prochains matchs (statut NS = Not Started)
            const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, status: 'NS', next: 10 }
            });

            for (const m of res.data.response) {
                // A. CALCUL SDM
                const hName = m.teams.home.name;
                const aName = m.teams.away.name;
                const sdmData = calculateSDM1N2(hName, aName, snapshots[league.id], lastRoundMap[league.id], nameToId);
                
                if (!sdmData) continue;

                const val = Math.abs(sdmData.val);
                let tier = 'LOW';
                if (val >= 15) tier = 'SUPREME';
                else if (val >= 10) tier = 'SOLID';
                else if (val >= 5) tier = 'VALUE';

                if (tier === 'LOW') continue; // On ignore les faibles

                const predSide = sdmData.val > 0 ? 'Home' : 'Away'; // >0 = Home Stronger (Rank reversed)

                // B. RÉCUPÉRATION COTE EN DIRECT
                await delay(250); // Respect API
                const oRes = await axios.get('https://v3.football.api-sports.io/odds', {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { fixture: m.fixture.id }
                });

                if (oRes.data.response.length > 0) {
                    const bets = oRes.data.response[0].bookmakers[0].bets;
                    const b1N2 = bets.find(b => b.id === 1); // ID 1 = Winner
                    if (b1N2) {
                        const targetVal = predSide; // "Home" or "Away"
                        const oddObj = b1N2.values.find(v => v.value === targetVal);
                        
                        if (oddObj) {
                            const realOdd = parseFloat(oddObj.odd);
                            const minRequired = ALGO_PERF[tier].minOdd;
                            
                            // --- C. LE TEST DE VALUE ---
                            // Value Index = Cote Réelle / Cote Min
                            // Si > 1.0, c'est rentable. Si > 1.10, c'est génial.
                            const valueIndex = realOdd / minRequired;

                            if (valueIndex > 1.0) {
                                opportunities.push({
                                    league: league.name,
                                    match: `${hName} vs ${aName}`,
                                    tier: tier,
                                    pred: predSide,
                                    odd: realOdd,
                                    minOdd: minRequired,
                                    value: ((valueIndex - 1) * 100).toFixed(1) + '%', // Marge de profit estimée
                                    date: m.fixture.date
                                });
                                process.stdout.write("💎 ");
                            } else {
                                process.stdout.write("."); // Match analysé mais cote trop basse
                            }
                        }
                    }
                }
            }
            console.log("OK");
        } catch (e) { console.log("x"); }
    }

    // 3. RAPPORT FINAL
    console.log(`\n\n📋 RAPPORT DES OPPORTUNITÉS (Trier par 'Value')\n`);
    
    // Tri par Value décroissante (Les meilleures affaires en premier)
    opportunities.sort((a,b) => parseFloat(b.value) - parseFloat(a.value));

    if (opportunities.length === 0) {
        console.log("Aucune opportunité rentable détectée aujourd'hui. Les bookmakers sont trop précis.");
    } else {
        console.table(opportunities.map(o => ({
            'Match': o.match,
            'Prediction': o.pred,
            'Confiance': o.tier,
            'Cote Réelle': o.odd,
            'Cote Min Requise': o.minOdd,
            '💎 VALUE (Marge)': o.value
        })));
        
        console.log("\n💡 LÉGENDE :");
        console.log("- VALUE (Marge) : C'est votre avantage mathématique sur le bookmaker.");
        console.log("- Si marge > 10% : C'est un pari EXCELLENT.");
        console.log("- Si marge > 0% : C'est un pari RENTABLE sur le long terme.");
    }
}

// Helper SDM
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

findValueBets();