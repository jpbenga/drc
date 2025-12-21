const axios = require('axios');
const fs = require('fs');

// --- CONFIGURATION STRICTE ---
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

async function fetchHistoryFull() {
    console.log("📥 ÉTAPE 1 : TÉLÉCHARGEMENT DE L'HISTORIQUE SAISON (Brut)...");

    for (const league of LEAGUES) {
        try {
            // Récupération de TOUS les matchs finis (FT) de la saison
            // Aucune limite de nombre, on veut tout.
            const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
                headers: { 'x-apisports-key': API_KEY },
                params: { 
                    league: league.id, 
                    season: SEASON, 
                    status: 'FT' // Finished Time uniquement
                }
            });

            let matches = res.data.response;

            if (!matches || matches.length === 0) {
                console.log(`   ⚠️ ${league.name} : Aucun match trouvé.`);
                continue;
            }

            // TRI CHRONOLOGIQUE IMPERATIF (Du plus vieux au plus récent)
            // Indispensable pour rejouer la saison match après match.
            matches.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

            // Sauvegarde brute
            const filename = `history_${league.id}.json`;
            fs.writeFileSync(filename, JSON.stringify(matches, null, 2));
            
            console.log(`   ✅ ${league.name} : ${matches.length} matchs sauvegardés dans ${filename}`);

        } catch (e) {
            console.error(`   ❌ Erreur ${league.name} : ${e.message}`);
        }
    }
    console.log("\n🏁 Historique téléchargé. Prêt pour l'étape 2.");
}

fetchHistoryFull();