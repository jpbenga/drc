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

async function fetchRealOdds() {
    console.log(`📥 FETCH : RÉCUPÉRATION COTES MARCHÉS SPÉCIFIQUES (BTTS, O/U, HSH)...`);

    for (const league of LEAGUES) {
        process.stdout.write(`\nTraitement ${league.name} : `);

        try {
            // 1. Trouver le round actuel (ou le dernier fini)
            // On simplifie : on prend le round "Current"
            const rRes = await axios.get('https://v3.football.api-sports.io/fixtures/rounds', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, current: 'true' }
            });
            
            let targetRound = rRes.data.response[0];
            
            // On vérifie s'il est fini, sinon on prend celui d'avant
            let fRes = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, round: targetRound }
            });
            let fixtures = fRes.data.response;
            
            const allFinished = fixtures.every(m => ['FT', 'AET', 'PEN'].includes(m.fixture.status.short));
            if(!allFinished) {
                 // On recule d'un
                 const allRounds = await axios.get('https://v3.football.api-sports.io/fixtures/rounds', {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { league: league.id, season: SEASON }
                });
                const idx = allRounds.data.response.indexOf(targetRound);
                if(idx > 0) {
                    targetRound = allRounds.data.response[idx-1];
                    fRes = await axios.get('https://v3.football.api-sports.io/fixtures', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { league: league.id, season: SEASON, round: targetRound }
                    });
                    fixtures = fRes.data.response;
                }
            }
            process.stdout.write(`Round [${targetRound}]... `);

            // 2. Récupérer les données enrichies
            let enrichedData = [];
            
            for (const match of fixtures) {
                await delay(250); // Pause API

                let fullData = {
                    info: { id: match.fixture.id, date: match.fixture.date, home: match.teams.home.name, away: match.teams.away.name },
                    score: { fulltime: match.score.fulltime, halftime: match.score.halftime },
                    odds: { 
                        "BTTS": null,   // Both Teams To Score
                        "OU25": null,   // Over/Under 2.5
                        "HSH": null     // Highest Scoring Half
                    }
                };

                try {
                    const o = await axios.get('https://v3.football.api-sports.io/odds', {
                        headers: { 'x-apisports-key': API_KEY },
                        params: { fixture: match.fixture.id }
                    });

                    if (o.data.response.length > 0) {
                        const bets = o.data.response[0].bookmakers[0].bets;
                        
                        // ID 8 : Both Teams To Score
                        const bBTTS = bets.find(b => b.id === 8);
                        if(bBTTS) fullData.odds["BTTS"] = bBTTS.values;

                        // ID 5 : Goals Over/Under
                        const bOU = bets.find(b => b.id === 5);
                        if(bOU) fullData.odds["OU25"] = bOU.values; // On prend tout le tableau, on filtrera après

                        // ID 7 : Highest Scoring Half
                        const bHSH = bets.find(b => b.id === 7);
                        if(bHSH) fullData.odds["HSH"] = bHSH.values;
                    }
                } catch(e) {}

                process.stdout.write(fullData.odds["BTTS"] ? "💰" : ".");
                enrichedData.push(fullData);
            }

            fs.writeFileSync(`ultimate_${league.id}.json`, JSON.stringify(enrichedData, null, 2));
            process.stdout.write(" OK");

        } catch (e) { console.log("Erreur " + e.message); }
    }
    console.log("\n✅ Cotes Réelles Récupérées.");
}

fetchRealOdds();