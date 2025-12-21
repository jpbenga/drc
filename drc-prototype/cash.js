const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');

// =================================================================
// 🏦 CONFIGURATION
// =================================================================
const API_KEY = '7f7700a471beeeb52aecde406a3870ba'; 
const PORT = 3001; 
const FILES = {
    PENDING: 'bets_pending.json',
    HISTORY: 'bets_history.json'
};

const START_BANKROLL = 150; 
// AUCUNE LIMITE D'AFFICHAGE : On montre tout l'historique.

// =================================================================

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runValidator() {
    console.clear();
    console.log(`🏦 GESTIONNAIRE - HISTORIQUE INTÉGRAL`);

    // 1. Chargement
    let pendingBets = [];
    let historyBets = [];

    if (fs.existsSync(FILES.PENDING)) pendingBets = JSON.parse(fs.readFileSync(FILES.PENDING));
    if (fs.existsSync(FILES.HISTORY)) historyBets = JSON.parse(fs.readFileSync(FILES.HISTORY));

    // 2. Vérification des paris en attente
    if (pendingBets.length > 0) {
        console.log(`\n🔍 Vérification de ${pendingBets.length} paris en attente...`);
        let settledCount = 0;
        let remainingBets = [];

        for (let bet of pendingBets) {
            if(bet.status !== 'PENDING') { remainingBets.push(bet); continue; }

            try {
                process.stdout.write(`⏳ ${bet.match}... `);
                const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
                    headers: { 'x-apisports-key': API_KEY },
                    params: { id: bet.id }
                });

                if (res.data.response.length > 0) {
                    const fixture = res.data.response[0];
                    const status = fixture.fixture.status.short;

                    if (['FT', 'AET', 'PEN'].includes(status)) {
                        // MATCH TERMINÉ
                        const goals = fixture.goals;
                        const scoreStr = `${goals.home}-${goals.away}`;
                        
                        let winner = 'Draw';
                        if (goals.home > goals.away) winner = 'Home';
                        else if (goals.away > goals.home) winner = 'Away';

                        const isWin = (bet.pred === winner);
                        const pnl = isWin ? (bet.stake * bet.odd) - bet.stake : -bet.stake;

                        bet.status = isWin ? 'WON' : 'LOST';
                        bet.ft_score = scoreStr;
                        bet.pnl = parseFloat(pnl.toFixed(2));
                        bet.result_date = new Date().toISOString();

                        historyBets.push(bet);
                        settledCount++;
                        console.log(isWin ? `✅ GAGNÉ` : `❌ PERDU`);

                    } else if (['PST', 'CANC', 'ABD'].includes(status)) {
                        bet.status = 'VOID';
                        bet.pnl = 0;
                        bet.ft_score = status;
                        historyBets.push(bet);
                        settledCount++;
                        console.log(`⚠️ ANNULÉ`);
                    } else {
                        remainingBets.push(bet);
                        console.log(`🕒 ${status}`);
                    }
                } else {
                    remainingBets.push(bet);
                    console.log(`❓`);
                }
                if(pendingBets.length > 1) await delay(250);

            } catch (e) {
                console.log(`❌ Err`);
                remainingBets.push(bet);
            }
        }

        if (settledCount > 0) {
            fs.writeFileSync(FILES.PENDING, JSON.stringify(remainingBets, null, 2));
            fs.writeFileSync(FILES.HISTORY, JSON.stringify(historyBets, null, 2));
            console.log(`\n💾 ${settledCount} résultats archivés.`);
            pendingBets = remainingBets;
        }
    } else {
        console.log(`\n💤 Aucun pari en attente.`);
    }

    // 3. Serveur Visuel
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateDashboard(historyBets, pendingBets));
    });

    server.listen(PORT, () => {
        console.log(`\n🌐 DASHBOARD : http://localhost:${PORT}`);
        const s = (process.platform=='darwin'?'open':process.platform=='win32'?'start':'xdg-open');
        exec(`${s} http://localhost:${PORT}`);
    });
}

// =================================================================
// 🎨 MOTEUR GRAPHIQUE (FULL HISTORY)
// =================================================================
function generateDashboard(history, pending) {
    const cGreen = '#4ade80'; const cRed = '#f87171'; const cGold = '#facc15'; const cMuted = '#94a3b8';
    
    // 1. CALCULS KPI
    let currentBankroll = START_BANKROLL;
    let totalWon = 0; let totalLost = 0;
    let wins = 0; let totalBets = 0;

    // Calcul dans l'ordre chronologique pour la bankroll
    const chronologicalHistory = [...history].sort((a,b) => new Date(a.result_date || a.date) - new Date(b.result_date || b.date));

    chronologicalHistory.forEach(b => {
        if (b.status !== 'VOID') {
            currentBankroll += b.pnl;
            if (b.pnl > 0) { wins++; } 
            totalBets++;
        }
    });

    const netProfit = currentBankroll - START_BANKROLL;
    const winRate = (totalBets > 0) ? (wins / totalBets) * 100 : 0;

    // 2. PRÉPARATION AFFICHAGE (Ordre décroissant : Plus récent en haut)
    // AUCUN SLICE ICI -> On garde tout
    const displayHistory = [...history].sort((a,b) => new Date(b.result_date || b.date) - new Date(a.result_date || a.date));

    const generateTableRows = (list, isPending) => {
        if(list.length === 0) return `<tr><td colspan="6" style="text-align:center; padding:30px; color:${cMuted}">Aucune donnée.</td></tr>`;
        
        let rows = '';
        let lastDay = '';

        list.forEach(b => {
            const dObj = new Date(isPending ? b.date : (b.result_date || b.date));
            const day = dObj.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long'});
            
            // SÉPARATEUR DE DATE
            if(day !== lastDay) {
                rows += `<tr><td colspan="6" class="date-sep">${day}</td></tr>`;
                lastDay = day;
            }

            let badgeClass = 'status-PENDING';
            let pnlHtml = '-';
            let scoreHtml = isPending ? `<span style="font-size:0.8em; opacity:0.7">À venir</span>` : `<strong>${b.ft_score}</strong>`;

            if (!isPending) {
                if(b.status === 'WON') { badgeClass = 'status-WON'; pnlHtml = `+${b.pnl.toFixed(2)} €`; }
                else if(b.status === 'LOST') { badgeClass = 'status-LOST'; pnlHtml = `${b.pnl.toFixed(2)} €`; }
                else { badgeClass = 'status-VOID'; pnlHtml = '0.00 €'; }
            }

            rows += `<tr>
                <td>${dObj.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'})}</td>
                <td>
                    <div>
                        <span class="${b.pred==='Home'?'team-sel':''}">${b.match.split(' vs ')[0]}</span>
                        <span style="font-size:0.8em; opacity:0.5; margin:0 5px">vs</span>
                        <span class="${b.pred==='Away'?'team-sel':''}">${b.match.split(' vs ')[1]}</span>
                    </div>
                    <div class="league-tag">${b.league}</div>
                </td>
                <td>
                    <span class="badge ${badgeClass}">${b.status === 'PENDING' ? 'EN COURS' : b.status}</span>
                </td>
                <td>${scoreHtml}</td>
                <td>
                    <div style="font-weight:bold">${b.odd.toFixed(2)}</div>
                    <div style="font-size:0.7em; color:${cMuted}">Mise: ${b.stake}€</div>
                </td>
                <td style="font-weight:bold; color:${!isPending && b.pnl > 0 ? cGreen : (!isPending && b.pnl < 0 ? cRed : cMuted)}">
                    ${pnlHtml}
                </td>
            </tr>`;
        });
        return rows;
    };

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Portfolio Manager</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;700;900&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #0f172a; --card: #1e293b; --border: #334155; }
            html { scroll-behavior: smooth; }
            body { background: var(--bg); color: #f1f5f9; font-family: 'Roboto', sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; position:relative; }
            
            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 30px; }
            .header h1 { margin: 0; color: ${cGold}; font-size: 2em; text-transform:uppercase; letter-spacing:-1px; }
            .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
            .kpi-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 20px; text-align: center; }
            .kpi-title { color: ${cMuted}; font-size: 0.8em; text-transform: uppercase; margin-bottom: 5px; }
            .kpi-val { font-size: 1.8em; font-weight: 900; }
            
            table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; margin-bottom: 40px; }
            th { background: #020617; color: ${cMuted}; padding: 12px; font-size: 0.85em; text-align: left; text-transform: uppercase; position: sticky; top: 0; z-index:10; }
            td { padding: 12px; border-bottom: 1px solid var(--border); font-size: 0.95em; vertical-align: middle; }
            
            .badge { padding: 3px 6px; border-radius: 4px; font-size: 0.7em; font-weight: bold; border: 1px solid currentColor; display:inline-block; min-width:60px; text-align:center;}
            .status-WON { color: ${cGreen}; background: rgba(74, 222, 128, 0.1); border-color:${cGreen}; }
            .status-LOST { color: ${cRed}; background: rgba(248, 113, 113, 0.1); border-color:${cRed}; }
            .status-PENDING { color: ${cGold}; background: rgba(250, 204, 21, 0.1); border-color:${cGold}; }
            .status-VOID { color: ${cMuted}; background: rgba(148, 163, 184, 0.1); border-color:${cMuted}; }
            
            .team-sel { color: ${cGreen}; font-weight: bold; text-decoration: underline; text-underline-offset: 3px; }
            .league-tag { font-size:0.75em; color:${cMuted}; margin-top:3px; text-transform:uppercase; letter-spacing:0.5px; }
            .date-sep { background: #334155; color: white; padding: 10px 15px; font-size: 0.9em; font-weight: bold; letter-spacing: 1px; border-top: 1px solid #475569; }
            
            .section-label { display:flex; justify-content:space-between; align-items:end; margin-bottom:10px; border-bottom: 2px solid ${cGold}; padding-bottom:5px; }
            .section-title { font-weight:bold; font-size:1.2em; color:${cGold}; text-transform:uppercase; }
            .section-sub { font-size:0.8em; color:${cMuted}; }

            /* UX: Bouton Retour en haut */
            #backToTop {
                position: fixed; bottom: 30px; right: 30px; 
                background: ${cGold}; color: #000; 
                width: 50px; height: 50px; border-radius: 50%; 
                display: flex; align-items: center; justify-content: center; 
                font-size: 24px; cursor: pointer; opacity: 0.8; transition:0.3s;
                border:none; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
            }
            #backToTop:hover { opacity:1; transform:translateY(-3px); }
        </style>
    </head>
    <body>

    <div class="header" id="top">
        <div>
            <h1>PORTFOLIO MANAGER</h1>
            <div style="color:${cMuted}">Suivi de Performance • Historique Complet</div>
        </div>
        <div style="text-align:right">
            <div style="font-size:0.9em; color:${cMuted}">Capital Actuel</div>
            <div style="font-size:1.5em; font-weight:bold; color:${netProfit>=0?cGreen:cRed}">${currentBankroll.toFixed(2)} €</div>
        </div>
    </div>

    <div class="kpi-row">
        <div class="kpi-card">
            <div class="kpi-title">Profit Net (Total)</div>
            <div class="kpi-val" style="color:${netProfit>=0? cGreen:cRed}">${netProfit>0?'+':''}${netProfit.toFixed(2)} €</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">Réussite</div>
            <div class="kpi-val">${winRate.toFixed(1)}%</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">Volume Paris</div>
            <div class="kpi-val">${totalBets}</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-title">En Attente</div>
            <div class="kpi-val" style="color:${cGold}">${pending.length}</div>
        </div>
    </div>

    <div class="section-label">
        <span class="section-title">⏳ Paris en Cours</span>
        <span class="section-sub">${pending.length} match(s) à venir</span>
    </div>
    <table>
        <thead><tr><th width="10%">Heure</th><th width="40%">Match & Ligue</th><th width="10%">État</th><th width="10%">Score</th><th width="15%">Cote / Mise</th><th width="15%">Gain Potentiel</th></tr></thead>
        <tbody>
            ${generateTableRows(pending, true)}
        </tbody>
    </table>

    <div class="section-label">
        <span class="section-title">📜 Historique Intégral</span>
        <span class="section-sub">${displayHistory.length} paris archivés</span>
    </div>
    <table>
        <thead><tr><th width="10%">Heure</th><th width="40%">Match & Ligue</th><th width="10%">Résultat</th><th width="10%">Score Final</th><th width="15%">Cote / Mise</th><th width="15%">Profit / Perte</th></tr></thead>
        <tbody>
            ${generateTableRows(displayHistory, false)}
        </tbody>
    </table>

    <div style="text-align:center; color:${cMuted}; font-size:0.8em; margin-top:20px; margin-bottom:50px;">
        Fin de l'historique complet.
    </div>

    <button id="backToTop" onclick="window.scrollTo(0,0)" title="Retour en haut">⬆</button>

    </body>
    </html>`;

    return html;
}

runValidator();