const axios = require('axios');
const API_KEY = '7f7700a471beeeb52aecde406a3870ba';

async function listAllMarkets() {
    try {
        const oddsRes = await axios.get('https://v1.basketball.api-sports.io/odds', {
            headers: { 'x-apisports-key': API_KEY },
            params: { game: 469841 } // On garde le même match que ton debug
        });

        const bookmaker = oddsRes.data.response[0].bookmakers[0];
        console.log(`\n🏀 LISTE DES MARCHÉS DISPONIBLES POUR ${bookmaker.name} :`);
        
        bookmaker.bets.forEach(bet => {
            console.log(`ID: ${bet.id} | Nom: ${bet.name}`);
        });

    } catch (e) {
        console.log("Erreur :", e.message);
    }
}
listAllMarkets();