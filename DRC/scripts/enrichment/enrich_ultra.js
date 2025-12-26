const axios = require('axios');
const fs = require('fs');

// ============================================================================
// CONFIGURATION
// ============================================================================
const API_KEY = '7f7700a471beeeb52aecde406a3870ba';
const BASE_URL = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_KEY };
const LEAGUES = ['39', '61', '78', '140', '135', '94', '88', '203'];  // 197 retiré (pas de stats)
const SEASON = 2025;

// CHEMINS DES FICHIERS
const PATHS = {
    meta: (lid) => `./data/meta/league_${lid}_meta.json`,
    history: (lid) => `./data/history/history_${lid}.json`
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// PHASE 1 : CONSTRUCTION META-DATABASE
// ============================================================================

async function buildMetaDatabase() {
    console.log("\n🔧 PHASE 1 : CONSTRUCTION META-DATABASE (Top Players + Squads)\n");
    
    // Créer le dossier meta si inexistant
    if (!fs.existsSync('./data/meta')) {
        fs.mkdirSync('./data/meta', { recursive: true });
    }
    
    for (const lid of LEAGUES) {
        const metaFile = PATHS.meta(lid);
        
        if (fs.existsSync(metaFile)) {
            console.log(`⏭️  Meta Ligue ${lid} déjà construite, skip.`);
            continue;
        }

        let meta = { 
            league_id: lid, 
            season: SEASON, 
            top_scorers: [], 
            top_assists: [], 
            squads: {} 
        };

        try {
            // 1. TOP SCORERS
            console.log(`📥 Récupération Top Scorers Ligue ${lid}...`);
            const scorersRes = await axios.get(`${BASE_URL}/players/topscorers`, {
                headers: HEADERS,
                params: { league: lid, season: SEASON }
            });
            meta.top_scorers = scorersRes.data.response.slice(0, 20).map(p => ({
                id: p.player.id,
                name: p.player.name,
                team_id: p.statistics[0].team.id,
                goals: p.statistics[0].goals.total,
                position: p.statistics[0].games.position
            }));
            await sleep(1200);

            // 2. TOP ASSISTS
            console.log(`📥 Récupération Top Assists Ligue ${lid}...`);
            const assistsRes = await axios.get(`${BASE_URL}/players/topassists`, {
                headers: HEADERS,
                params: { league: lid, season: SEASON }
            });
            meta.top_assists = assistsRes.data.response.slice(0, 20).map(p => ({
                id: p.player.id,
                name: p.player.name,
                team_id: p.statistics[0].team.id,
                assists: p.statistics[0].goals.assists,
                position: p.statistics[0].games.position
            }));
            await sleep(1200);

            // 3. TEAMS & SQUADS
            console.log(`📥 Récupération Teams Ligue ${lid}...`);
            const teamsRes = await axios.get(`${BASE_URL}/teams`, {
                headers: HEADERS,
                params: { league: lid, season: SEASON }
            });
            
            for (const team of teamsRes.data.response) {
                const teamId = team.team.id;
                console.log(`   🔍 Squad de ${team.team.name}...`);
                
                const squadRes = await axios.get(`${BASE_URL}/players/squads`, {
                    headers: HEADERS,
                    params: { team: teamId }
                });
                
                meta.squads[teamId] = {
                    name: team.team.name,
                    players: squadRes.data.response[0]?.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        position: p.position,
                        age: p.age,
                        number: p.number
                    })) || []
                };
                
                await sleep(1200);
            }

            // Sauvegarde
            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
            console.log(`✅ Meta Ligue ${lid} sauvegardée dans ${metaFile}\n`);

        } catch (err) {
            console.error(`❌ Erreur Meta Ligue ${lid}: ${err.message}`);
            await sleep(5000);
        }
    }
}

// ============================================================================
// PHASE 2 : ENRICHISSEMENT DES MATCHS
// ============================================================================

async function enrichMatches() {
    console.log("\n🚀 PHASE 2 : ENRICHISSEMENT EXHAUSTIF DES MATCHS\n");

    // Créer le dossier history si inexistant
    if (!fs.existsSync('./data/history')) {
        fs.mkdirSync('./data/history', { recursive: true });
    }

    for (const lid of LEAGUES) {
        const filePath = PATHS.history(lid);
        const metaPath = PATHS.meta(lid);

        if (!fs.existsSync(filePath)) {
            console.log(`⚠️  Fichier ${filePath} introuvable, skip.`);
            continue;
        }

        if (!fs.existsSync(metaPath)) {
            console.log(`⚠️  Meta manquante pour Ligue ${lid}. Lancez d'abord buildMetaDatabase().`);
            continue;
        }

        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        let matches = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🏆 LIGUE ${lid} : ${matches.length} MATCHS À TRAITER`);
        console.log(`${'='.repeat(60)}\n`);

        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];

            // Skip si déjà enrichi ou match non terminé
            if (m.enriched || m.goals.home === null) continue;

            const matchId = m.fixture.id;
            process.stdout.write(`⏳ [${i+1}/${matches.length}] Match ${matchId}... `);

            try {
                // APPELS PARALLÈLES (5 endpoints)
                const [statsRes, injuriesRes, eventsRes, lineupsRes, playersRes] = await Promise.all([
                    axios.get(`${BASE_URL}/fixtures/statistics?fixture=${matchId}`, { headers: HEADERS }),
                    axios.get(`${BASE_URL}/injuries?fixture=${matchId}`, { headers: HEADERS }),
                    axios.get(`${BASE_URL}/fixtures/events?fixture=${matchId}`, { headers: HEADERS }),
                    axios.get(`${BASE_URL}/fixtures/lineups?fixture=${matchId}`, { headers: HEADERS }),
                    axios.get(`${BASE_URL}/fixtures/players?fixture=${matchId}`, { headers: HEADERS })
                ]);

                // STOCKAGE BRUT
                m.raw_data = {
                    statistics: statsRes.data.response,
                    injuries: injuriesRes.data.response,
                    events: eventsRes.data.response,
                    lineups: lineupsRes.data.response,
                    players: playersRes.data.response
                };

                // STOCKAGE SEMI-TRAITÉ
                m.context = {
                    injuries_home: injuriesRes.data.response
                        .filter(inj => inj.team.id === m.teams.home.id)
                        .map(inj => ({
                            player_id: inj.player.id,
                            player_name: inj.player.name,
                            reason: inj.player.reason,
                            type: inj.player.type
                        })),
                    
                    injuries_away: injuriesRes.data.response
                        .filter(inj => inj.team.id === m.teams.away.id)
                        .map(inj => ({
                            player_id: inj.player.id,
                            player_name: inj.player.name,
                            reason: inj.player.reason,
                            type: inj.player.type
                        })),

                    lineup_home: lineupsRes.data.response[0]?.startXI?.map(p => ({
                        player_id: p.player.id,
                        player_name: p.player.name,
                        position: p.player.pos,
                        grid_position: p.player.grid
                    })) || [],

                    lineup_away: lineupsRes.data.response[1]?.startXI?.map(p => ({
                        player_id: p.player.id,
                        player_name: p.player.name,
                        position: p.player.pos,
                        grid_position: p.player.grid
                    })) || [],

                    player_ratings_home: playersRes.data.response[0]?.players?.map(p => ({
                        id: p.player.id,
                        name: p.player.name,
                        rating: parseFloat(p.statistics[0]?.games?.rating || 0),
                        minutes: p.statistics[0]?.games?.minutes || 0,
                        position: p.statistics[0]?.games?.position
                    })) || [],

                    player_ratings_away: playersRes.data.response[1]?.players?.map(p => ({
                        id: p.player.id,
                        name: p.player.name,
                        rating: parseFloat(p.statistics[0]?.games?.rating || 0),
                        minutes: p.statistics[0]?.games?.minutes || 0,
                        position: p.statistics[0]?.games?.position
                    })) || [],

                    goals_timeline: eventsRes.data.response
                        .filter(e => e.type === "Goal" && e.detail !== "Missed Penalty")
                        .map(e => ({
                            team_id: e.team.id,
                            player_id: e.player.id,
                            minute: e.time.elapsed,
                            half: e.time.elapsed <= 45 ? 'HT' : 'FT'
                        }))
                };

                m.enriched = true;
                process.stdout.write(`✅\n`);

                // Sauvegarde incrémentale
                if (i % 10 === 0 && i > 0) {
                    fs.writeFileSync(filePath, JSON.stringify(matches, null, 2));
                }

                await sleep(1500);

            } catch (err) {
                console.log(`❌ Erreur: ${err.message}`);
                await sleep(5000);
            }
        }

        // Sauvegarde finale
        fs.writeFileSync(filePath, JSON.stringify(matches, null, 2));
        console.log(`\n✨ Ligue ${lid} : Enrichissement terminé et sauvegardé.\n`);
    }
}

// ============================================================================
// EXÉCUTION
// ============================================================================

async function runFullPipeline() {
    // Créer la structure de dossiers si nécessaire
    const dirs = ['./data/meta', './data/history'];
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`📁 Dossier créé : ${dir}`);
        }
    });

    console.log("╔═══════════════════════════════════════════════════════════╗");
    console.log("║       SDM ULTRA - ENRICHISSEMENT EXHAUSTIF v2.0          ║");
    console.log("╚═══════════════════════════════════════════════════════════╝");

    await buildMetaDatabase();
    await enrichMatches();

    console.log("\n🔥 PIPELINE COMPLET TERMINÉ. Vos JSON sont prêts pour backtest.js");
}

runFullPipeline();