const http = require('http');
const fs = require('fs');

const PORT = 3000;

// Mapping ID -> Nom Fichier
const FILES = {
    "Ligue 1": "ultimate_61.json",
    "Premier League": "ultimate_39.json",
    "La Liga": "ultimate_140.json",
    "Bundesliga": "ultimate_78.json",
    "Serie A": "ultimate_135.json",
    "Liga Portugal": "ultimate_94.json"
};

function startDashboard() {
    let allMatches = [];

    // Chargement de tous les fichiers générés
    for (const [name, file] of Object.entries(FILES)) {
        if (fs.existsSync(file)) {
            try {
                const raw = fs.readFileSync(file);
                if (raw.length > 0) {
                    const data = JSON.parse(raw);
                    // On ajoute le nom de la ligue à chaque match pour l'affichage
                    data.forEach(m => m.leagueName = name);
                    allMatches = [...allMatches, ...data];
                }
            } catch (e) {
                console.error(`Erreur lecture fichier ${file}:`, e.message);
            }
        }
    }

    // Construction de la page HTML
    // Note : Les backslashs (\) devant les backticks (`) et les ${} servent à ce que Node.js
    // n'interprète pas ces variables, mais les envoie telles quelles au navigateur.
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Dashboard Ultime - Dernière Journée</title>
        <style>
            body { background: #111827; color: #e5e7eb; font-family: sans-serif; padding: 20px; display:flex; gap:20px; height: 100vh; overflow: hidden; }
            h1 { color: #fbbf24; margin-top:0;}
            
            /* LISTE DES MATCHS (Gauche) */
            .match-list { width: 350px; height: 90vh; overflow-y: auto; background: #1f2937; border-radius: 8px; }
            .match-item { 
                padding: 15px; border-bottom: 1px solid #374151; cursor: pointer; transition: 0.2s;
            }
            .match-item:hover { background: #374151; }
            .match-item.active { background: #2563eb; border-left: 5px solid #60a5fa; }
            
            .m-league { font-size: 0.75em; color: #9ca3af; text-transform: uppercase; letter-spacing: 1px; }
            .m-teams { font-weight: bold; margin: 5px 0; font-size:0.95em;}
            .m-score { float: right; font-size: 1.1em; color: #fbbf24; }

            /* DÉTAIL (Droite) */
            .detail-view { flex: 1; background: #1f2937; border-radius: 8px; padding: 30px; display:none; overflow-y: auto; height: 90vh; }
            .header-score { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #374151; padding-bottom: 20px;}
            .big-score { font-size: 3em; font-weight: bold; color: #fbbf24; }
            .halftime { color: #9ca3af; font-size: 0.9em; margin-top: 5px; }

            .grid-container { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
            .card { background: #111827; padding: 20px; border-radius: 8px; }
            .card h3 { color: #60a5fa; margin-top: 0; border-bottom: 1px solid #374151; padding-bottom: 10px; }

            .stat-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 0.9em; }
            .odd-row { display: flex; justify-content: space-between; margin-bottom: 12px; background: #1f2937; padding: 10px; border-radius: 4px; align-items: center;}
            .odd-label { color: #9ca3af; }
            .odd-val { font-weight: bold; color: #fbbf24; font-size: 1.1em; }
            
            .odds-1n2 { display: flex; gap: 10px; }
            .odd-box { flex:1; background: #374151; text-align: center; padding: 8px; border-radius: 4px; }
            .ob-lbl { display:block; font-size: 0.7em; color: #9ca3af; }
            .ob-val { display:block; font-weight: bold; color: #fff; }
        </style>
    </head>
    <body>
        <div class="match-list" id="listContainer">
            </div>

        <div class="detail-view" id="detailContainer">
            <div class="header-score">
                <h2 id="dTeams">Home vs Away</h2>
                <div class="big-score" id="dScore">2 - 1</div>
                <div class="halftime" id="dHT">Mi-temps : (1-0)</div>
            </div>

            <div class="grid-container">
                <div class="card">
                    <h3>📊 Statistiques</h3>
                    <div id="statsContent"></div>
                </div>

                <div class="card">
                    <h3>💰 Cotes du Match</h3>
                    
                    <div style="margin-bottom:15px;">
                        <span style="font-size:0.8em; color:#9ca3af; display:block; margin-bottom:5px;">RÉSULTAT DU MATCH (1N2)</span>
                        <div class="odds-1n2" id="odds1N2"></div>
                    </div>

                    <div style="margin-bottom:15px;">
                        <span style="font-size:0.8em; color:#9ca3af; display:block; margin-bottom:5px;">DOUBLE CHANCE</span>
                        <div class="odds-1n2" id="oddsDC"></div>
                    </div>

                    <div class="odd-row">
                        <span class="odd-label">Moins de 3.5 Buts</span>
                        <span class="odd-val" id="oddU35">-</span>
                    </div>
                    <div class="odd-row">
                        <span class="odd-label">Extérieur Marque (+0.5)</span>
                        <span class="odd-val" id="oddAway">-</span>
                    </div>
                </div>
            </div>
        </div>

        <script>
            // Injection des données JSON côté serveur vers le client
            const matches = ${JSON.stringify(allMatches)};
            
            const listDiv = document.getElementById('listContainer');
            const detailDiv = document.getElementById('detailContainer');

            // Remplir la liste
            matches.forEach((m, index) => {
                const el = document.createElement('div');
                el.className = 'match-item';
                // ATTENTION: Utilisation de backslash pour échapper les backticks côté client
                el.innerHTML = \`
                    <div class="m-league">\${m.leagueName}</div>
                    <div class="m-teams">\${m.info.home} v \${m.info.away} <span class="m-score">\${m.score.fulltime.home}-\${m.score.fulltime.away}</span></div>
                    <div style="font-size:0.8em; color:#6b7280">\${m.info.date.split('T')[0]}</div>
                \`;
                el.onclick = () => showDetail(index);
                listDiv.appendChild(el);
            });

            function showDetail(idx) {
                const m = matches[idx];
                detailDiv.style.display = 'block';
                
                // Header
                document.getElementById('dTeams').innerText = \`\${m.info.home} vs \${m.info.away}\`;
                document.getElementById('dScore').innerText = \`\${m.score.fulltime.home} - \${m.score.fulltime.away}\`;
                document.getElementById('dHT').innerText = \`Mi-temps : (\${m.score.halftime.home}-\${m.score.halftime.away})\`;

                // Stats
                const sDiv = document.getElementById('statsContent');
                sDiv.innerHTML = '';
                if(m.stats && m.stats.length === 2) {
                    const hS = m.stats[0].statistics;
                    const aS = m.stats[1].statistics;
                    
                    const getStat = (arr, type) => {
                        const s = arr.find(x => x.type === type);
                        return s ? s.value : 0;
                    };

                    const metrics = ['Shots on Goal', 'Total Shots', 'Corner Kicks', 'Ball Possession', 'Fouls'];
                    metrics.forEach(met => {
                        sDiv.innerHTML += \`
                        <div class="stat-row">
                            <span style="color:#60a5fa">\${getStat(hS, met) || 0}</span>
                            <span>\${met}</span>
                            <span style="color:#f87171">\${getStat(aS, met) || 0}</span>
                        </div>\`;
                    });
                } else {
                    sDiv.innerHTML = '<p style="color:#6b7280">Pas de stats détaillées dispos</p>';
                }

                // Odds
                const renderOdds = (id, data) => {
                    const div = document.getElementById(id);
                    div.innerHTML = '';
                    if(!data) return;
                    data.forEach(v => {
                        div.innerHTML += \`
                        <div class="odd-box">
                            <span class="ob-lbl">\${v.value}</span>
                            <span class="ob-val">\${v.odd}</span>
                        </div>\`;
                    });
                };

                renderOdds('odds1N2', m.odds["1N2"]);
                renderOdds('oddsDC', m.odds["DoubleChance"]);
                
                document.getElementById('oddU35').innerText = m.odds["Under3.5"] || 'N/A';
                document.getElementById('oddAway').innerText = m.odds["AwayOver0.5"] || 'N/A';
            }
        </script>
    </body>
    </html>`;

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    server.listen(PORT, () => {
        console.log(`✅ DASHBOARD PRÊT : http://localhost:${PORT}`);
    });
}

startDashboard();