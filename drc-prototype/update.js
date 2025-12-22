const fs = require('fs');
const axios = require('axios');

// CONFIGURATION
const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const SEASON = 2025;
const LEAGUES = [
    { id: 39, name: "Premier League" }, { id: 61, name: "Ligue 1" }, { id: 140, name: "La Liga" },
    { id: 78, name: "Bundesliga" }, { id: 135, name: "Serie A" }, { id: 94, name: "Liga Portugal" },
    { id: 88, name: "Eredivisie" }, { id: 144, name: "Jupiler Pro" }, { id: 179, name: "Premiership" },
    { id: 203, name: "Süper Lig" }, { id: 197, name: "Super League (GRE)" }, { id: 119, name: "Superliga (DAN)" },
    { id: 207, name: "Super League (SUI)" }, { id: 218, name: "Bundesliga (AUT)" }, { id: 40, name: "Championship" },
    { id: 62, name: "Ligue 2" }, { id: 136, name: "Serie B" }, { id: 79, name: "2. Bundesliga" },
    { id: 141, name: "La Liga 2" }, { id: 106, name: "Ekstraklasa" }, { id: 210, name: "HNL" },
    { id: 283, name: "Liga I" }, { id: 253, name: "MLS" },
    { id: 71, name: "Brasileiro A" }, { id: 128, name: "Liga Prof" }, { id: 262, name: "Liga MX" },
    { id: 307, name: "Saudi Pro" }, { id: 98, name: "J1 League" }, { id: 188, name: "A-League" }
];

// Helper pour extraire le numéro du round (ex: "Regular Season - 16" -> 16)
const getRoundNum = (str) => parseInt(str.replace(/[^0-9]/g, '')) || 0;

async function updateAllLeagues() {
    console.log(`🚀 DÉMARRAGE DE LA MISE À JOUR DES 30 CHAMPIONNATS...\n`);

    for (const league of LEAGUES) {
        const filename = `history_${league.id}.json`;
        
        if (!fs.existsSync(filename)) {
            console.log(`⚠️  ${league.name} : Fichier ${filename} introuvable. Passage...`);
            continue;
        }

        try {
            let localData = JSON.parse(fs.readFileSync(filename));
            
            // Trouver le dernier round enregistré
            const lastRoundNum = localData.length > 0 
                ? getRoundNum(localData[localData.length - 1].league.round) 
                : 0;

            console.log(`📡 [${league.name}] Dernier round local : ${lastRoundNum}. Récupération des suivants...`);

            // Appel API pour tous les matchs de la saison
            const response = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
                headers: { 'x-apisports-key': API_KEY },
                params: { league: league.id, season: SEASON }
            });

            const allFixtures = response.data.response;

            // Filtrer : Uniquement les rounds supérieurs au dernier round local ET matchs terminés (FT)
            const missingMatches = allFixtures.filter(f => {
                const fRoundNum = getRoundNum(f.league.round);
                const isFinished = f.fixture.status.short === 'FT';
                const isNew = fRoundNum > lastRoundNum;
                return isNew && isFinished;
            });

            if (missingMatches.length > 0) {
                // Fusion et tri par date
                const updatedData = [...localData, ...missingMatches].sort((a, b) => 
                    new Date(a.fixture.date) - new Date(b.fixture.date)
                );

                fs.writeFileSync(filename, JSON.stringify(updatedData, null, 2));
                const newMaxRound = getRoundNum(missingMatches[missingMatches.length - 1].league.round);
                console.log(`   ✅ Mis à jour : +${missingMatches.length} matchs (Rounds ${lastRoundNum + 1} à ${newMaxRound}).`);
            } else {
                console.log(`   ✅ Déjà à jour.`);
            }

            // Petite pause pour respecter le Rate Limit de l'API
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error(`   ❌ Erreur sur ${league.name} :`, error.message);
        }
    }

    console.log(`\n✅ TOUS LES FICHIERS SONT À JOUR.`);
}

updateAllLeagues();