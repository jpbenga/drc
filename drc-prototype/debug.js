const axios = require('axios');
const fs = require('fs');

// Configuration
const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const HISTORY_FILE = 'history_39.json';

async function fetchFirstMatchStats() {
    try {
        if (!fs.existsSync(HISTORY_FILE)) {
            console.error(`❌ Fichier ${HISTORY_FILE} introuvable.`);
            return;
        }
        
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));

        // On trie par date pour être certain de prendre le match d'ouverture
        history.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

        const firstMatch = history[0]; // Premier match de la saison
        const fixtureId = firstMatch.fixture.id;

        console.log(`🔍 Vérification du match d'OUVERTURE (ID: ${fixtureId})`);
        console.log(`📅 Date : ${firstMatch.fixture.date}`);
        console.log(`⚽ Match : ${firstMatch.teams.home.name} vs ${firstMatch.teams.away.name}\n`);

        const res = await axios.get('https://v3.football.api-sports.io/fixtures/statistics', {
            headers: { 'x-apisports-key': API_KEY },
            params: { fixture: fixtureId }
        });

        // Affichage du résultat complet
        console.log(JSON.stringify(res.data, null, 2));

        // Vérification rapide dans le terminal
        const stats = res.data.response[0].statistics;
        const xgStat = stats.find(s => s.type === 'expected_goals');
        
        if (xgStat) {
            console.log(`\n✅ SUCCÈS : Les xG sont présents (Valeur : ${xgStat.value})`);
        } else {
            console.log(`\n❌ ALERTE : Pas de xG trouvé pour ce match.`);
        }

    } catch (e) {
        console.error(`❌ Erreur : ${e.message}`);
    }
}

fetchFirstMatchStats();