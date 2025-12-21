const axios = require('axios');
const fs = require('fs');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const SEASON = 2025; 

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

async function fetchTargetRound() {
    console.log(`🎯 ÉTAPE 2 : CIBLAGE VIA 'CURRENT=TRUE'...`);

    for (const league of LEAGUES) {
        process.stdout.write(`\n📥 ${league.name} : `);

        try {
            // 1. REQUETE CIBLÉE : Quel est le round actuel ?
            const currentRes = await axios.get('https://v3.football.api-sports.io/fixtures/rounds', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, current: 'true' }
            });

            if (currentRes.data.response.length === 0) {
                console.log("❌ Pas de round current trouvé.");
                continue;
            }

            let targetRound = currentRes.data.response[0];
            process.stdout.write(`Current [${targetRound}]... `);

            // 2. VÉRIFICATION : Est-ce que ce round est fini ?
            let matchesRes = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, round: targetRound }
            });
            let fixtures = matchesRes.data.response;

            // On vérifie si TOUS les matchs sont finis (FT, AET, PEN)
            const allFinished = fixtures.every(m => ['FT', 'AET', 'PEN'].includes(m.fixture.status.short));

            if (!allFinished) {
                // 3. LOGIQUE DE RECUL : Si le current n'est pas fini, on veut le précédent.
                // Pour avoir le nom exact du précédent sans deviner, on doit juste récupérer la liste simple des rounds
                // C'est très léger (une seule requête liste).
                const allRoundsRes = await axios.get('https://v3.football.api-sports.io/fixtures/rounds', {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { league: league.id, season: SEASON }
                });
                const allRounds = allRoundsRes.data.response;
                const idx = allRounds.indexOf(targetRound);
                
                if (idx > 0) {
                    targetRound = allRounds[idx - 1]; // On prend celui d'avant
                    process.stdout.write(`En cours ❌ -> Bascule sur [${targetRound}]... `);
                    
                    // On recharge les matchs pour ce round validé
                    matchesRes = await axios.get('https://v3.football.api-sports.io/fixtures', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { league: league.id, season: SEASON, round: targetRound }
                    });
                    fixtures = matchesRes.data.response;
                }
            } else {
                process.stdout.write(`Terminé ✅... `);
            }

            // 4. TÉLÉCHARGEMENT DES DETAILS (Stats & Cotes)
            let enrichedData = [];
            
            for (const match of fixtures) {
                await delay(250); // Pause API

                let fullData = {
                    info: {
                        id: match.fixture.id,
                        date: match.fixture.date,
                        home: match.teams.home.name,
                        away: match.teams.away.name
                    },
                    score: { fulltime: match.score.fulltime, halftime: match.score.halftime },
                    odds: { "1N2": null, "DoubleChance": null, "Under3.5": null, "AwayOver0.5": null },
                    stats: null
                };

                // STATS
                try {
                    const s = await axios.get('https://v3.football.api-sports.io/fixtures/statistics', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { fixture: match.fixture.id }
                    });
                    fullData.stats = s.data.response;
                } catch(e) {}

                // COTES
                try {
                    const o = await axios.get('https://v3.football.api-sports.io/odds', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { fixture: match.fixture.id }
                    });
                    if (o.data.response.length > 0) {
                        const bets = o.data.response[0].bookmakers[0].bets;
                        const findBet = (id) => bets.find(b => b.id === id);

                        const b1 = findBet(1); if(b1) fullData.odds["1N2"] = b1.values;
                        const bDC = findBet(12); if(bDC) fullData.odds["DoubleChance"] = bDC.values;
                        const bOU = findBet(5); 
                        if(bOU) {
                            const v = bOU.values.find(x => x.value === "Under 3.5");
                            if(v) fullData.odds["Under3.5"] = v.odd;
                        }
                        const bAg = findBet(26);
                        if(bAg) {
                            const v = bAg.values.find(x => x.value === "Over 0.5");
                            if(v) fullData.odds["AwayOver0.5"] = v.odd;
                        }
                    }
                } catch(e) {}

                // Feedback visuel
                process.stdout.write(fullData.odds["1N2"] ? "💰" : ".");
                enrichedData.push(fullData);
            }

            const filename = `ultimate_${league.id}.json`;
            fs.writeFileSync(filename, JSON.stringify(enrichedData, null, 2));
            process.stdout.write(" 💾 OK");

        } catch (e) {
            console.error(`\n❌ Erreur : ${e.message}`);
        }
    }
    console.log("\n\n✅ ÉTAPE 2 TERMINÉE.");
}

fetchTargetRound();