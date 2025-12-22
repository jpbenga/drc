const axios = require('axios');
const fs = require('fs');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';

/**
 * Configuration des Ligues demandées
 */
const LIGUES_A_TRAITER = [
    39,  // Premier League (Angleterre)
    61,  // Ligue 1 (France)
    78,  // Bundesliga (Allemagne)
    140, // La Liga (Espagne)
    135, // Serie A (Italie)
    94,  // Liga Portugal (Portugal)
    88,  // Eredivisie (Pays-Bas)
    197, // Super League 1 (Grèce)
    203  // Süper Lig (Turquie)
];

// 200ms = 5 requêtes/seconde = 300 requêtes/minute (votre limite exacte)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function enrichHistoryFiles() {
    console.log(`🚀 Démarrage de l'enrichissement (Vitesse : 300 req/min)`);

    for (const leagueId of LIGUES_A_TRAITER) {
        const filePath = `history_${leagueId}.json`;
        
        if (!fs.existsSync(filePath)) {
            console.log(`⚠️ Fichier ${filePath} absent, ligue suivante.`);
            continue;
        }

        let history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let updatedCount = 0;
        console.log(`\n📦 Ligue ${leagueId} : ${history.length} matchs à vérifier...`);

        for (let i = 0; i < history.length; i++) {
            // Skip si les stats sont déjà présentes
            if (history[i].stats) continue; 

            try {
                const res = await axios.get('https://v3.football.api-sports.io/fixtures/statistics', {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { fixture: history[i].fixture.id }
                });

                if (res.data.response && res.data.response.length >= 2) {
                    history[i].stats = {
                        home: formatStats(res.data.response[0].statistics),
                        away: formatStats(res.data.response[1].statistics)
                    };
                    updatedCount++;
                }

                // Sauvegarde rapide toutes les 10 requêtes
                if (updatedCount % 10 === 0) {
                    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
                }
                
                // Respect strict de votre limite de 300 req/min
                await sleep(200);

            } catch (e) {
                console.error(`\n❌ Erreur match ${history[i].fixture.id} : ${e.message}`);
                fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
                if (e.response && e.response.status === 429) {
                    console.error("🛑 Limite de débit atteinte. Pause forcée.");
                    return;
                }
            }
        }
        fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
        console.log(`✅ Ligue ${leagueId} terminée (${updatedCount} mises à jour).`);
    }
    console.log("\n🏁 Enrichissement global terminé.");
}

function formatStats(statsArray) {
    const formatted = {};
    statsArray.forEach(s => {
        const key = s.type.toLowerCase().replace(/ /g, '_');
        formatted[key] = s.value;
    });
    return formatted;
}

enrichHistoryFiles();