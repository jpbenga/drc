const axios = require('axios');
const fs = require('fs');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const URL = 'https://v1.basketball.api-sports.io/games';

async function downloadNBA() {
    console.log("🏀 Récupération de la saison NBA 2024-2025...");
    try {
        const res = await axios.get(URL, {
            headers: { 'x-apisports-key': API_KEY },
            params: { league: 12, season: '2024-2025' }
        });

        const games = res.data.response;
        // On trie par date pour le backtest
        games.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        fs.writeFileSync('nba_season_data.json', JSON.stringify(games, null, 2));
        console.log(`✅ ${games.length} matchs enregistrés dans nba_season_data.json`);
    } catch (e) {
        console.log("Erreur :", e.message);
    }
}
downloadNBA();