const axios = require('axios');
const fs = require('fs');

const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const SEASON = '2025-2026';

async function downloadRecent() {
    console.log("🏀 Récupération des matchs NBA des 7 derniers jours...");
    
    // Calcul des dates
    const today = new Date();
    const lastWeek = new Date(today.getTime() - (7 * 24 * 60 * 60 * 1000));
    
    try {
        const res = await axios.get('https://v1.basketball.api-sports.io/games', {
            headers: { 'x-apisports-key': API_KEY },
            params: { league: 12, season: SEASON }
        });

        const games = res.data.response;
        // Filtrage sur les 7 derniers jours et matchs terminés
        const recentGames = games.filter(g => {
            const gDate = new Date(g.date);
            return gDate >= lastWeek && gDate < today && g.status.short === 'FT';
        });

        fs.writeFileSync('nba_recent_7d.json', JSON.stringify(recentGames, null, 2));
        console.log(`✅ ${recentGames.length} matchs récents enregistrés.`);
        
        // On récupère aussi les Standings actuels pour le calcul du SDM
        const stRes = await axios.get('https://v1.basketball.api-sports.io/standings', {
            headers: { 'x-apisports-key': API_KEY },
            params: { league: 12, season: SEASON }
        });
        fs.writeFileSync('nba_current_standings.json', JSON.stringify(stRes.data.response[0], null, 2));
        console.log(`📊 Standings mis à jour.`);

    } catch (e) { console.log("Erreur:", e.message); }
}
downloadRecent();