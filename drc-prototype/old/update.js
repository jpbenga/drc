const axios = require('axios');
const fs = require('fs');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
// CORRECTION CRITIQUE : ON PASSE EN 2025
const SEASON = 2025; 

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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function downloadAll() {
    console.log(`📥 TÉLÉCHARGEMENT SAISON ${SEASON} (CONTEXTE DÉCEMBRE 2025)...`);
    
    for (const league of LEAGUES) {
        const fileName = `history_${league.id}.json`;
        
        // On force l'écrasement pour être sûr d'avoir la saison 2025
        process.stdout.write(`⏳ Récupération ${league.name} (Saison ${SEASON})... `);
        try {
            const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON, status: 'FT' } 
            });
            fs.writeFileSync(fileName, JSON.stringify(res.data.response, null, 2));
            console.log(`OK (${res.data.response.length} matchs finis).`);
            await delay(1200); 
        } catch (e) {
            console.log(`ERREUR : ${e.message}`);
        }
    }
    console.log(`\n✅ BASES À JOUR POUR 2025. Passe à l'étape 2.`);
}

downloadAll();