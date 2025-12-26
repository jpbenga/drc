const fs = require('fs');
const http = require('http');
const PORT = 3000;

// ============================================================================
// CHEMINS DES FICHIERS
// ============================================================================
const PATHS = {
    elo: './data/elo/elo_history_archive.json',
    history: (lid) => `./data/history/history_${lid}.json`,
    meta: (lid) => `./data/meta/league_${lid}_meta.json`,
    params: './data/params/optimized_params.json',
    results: './data/results/'
};

// PARAMÈTRES OPTIMISÉS + NOUVEAUX
let PARAMS = {
    w_xg: 1.0591,
    w_elo: 0.6315,
    rho: -0.1319,
    hfa: 75.4065,
    impact_offensive: 0.0569,
    impact_defensive: 0.2140,
    min_matches: 3,
    // NOUVEAUX PARAMÈTRES POUR RÉDUIRE LE LISSAGE
    bayesian_confidence_base: 15,      // Confiance de base (ancien système)
    bayesian_confidence_strong: 8,     // Confiance réduite pour équipes fortes
    strong_threshold: 2.0              // Seuil xG pour être considéré "fort"
};

if (fs.existsSync(PATHS.params)) {
    try {
        const optimized = JSON.parse(fs.readFileSync(PATHS.params, 'utf8'));
        PARAMS = { ...PARAMS, ...optimized.best_params };
        console.log('✅ Paramètres optimisés chargés');
    } catch (err) {
        console.log('⚠️  Utilisation des paramètres par défaut');
    }
}

const ELO_HISTORY = JSON.parse(fs.readFileSync(PATHS.elo, 'utf8'));

const LEAGUES_CONFIG = {
    '39': { name: "Premier League" }, 
    '61': { name: "Ligue 1" }, 
    '78': { name: "Bundesliga" },
    '140': { name: "La Liga" }, 
    '135': { name: "Serie A" }, 
    '94': { name: "Liga Portugal" },
    '88': { name: "Eredivisie" }, 
    '197': { name: "Super League (GRE)" }, 
    '203': { name: "Süper Lig" }
};

// ============================================================================
// UTILITAIRES MATHÉMATIQUES
// ============================================================================

function fact(n) { 
    return n <= 1 ? 1 : n * fact(n - 1); 
}

function clubEloWinProb(deltaElo) { 
    return 1 / (Math.pow(10, -deltaElo / 400) + 1); 
}

// BAYESIAN SHRINKAGE ADAPTATIF (Solution au problème des scores à 3 buts)
function bayesianShrinkageAdaptive(teamStats, leagueAvg) {
    const n = teamStats.length;
    if (n === 0) return leagueAvg;
    
    const teamMean = teamStats.reduce((a, b) => a + b, 0) / n;
    
    // CORRECTION MAJEURE : Réduire la confiance pour les équipes performantes
    let confidence = PARAMS.bayesian_confidence_base;
    if (teamMean > PARAMS.strong_threshold) {
        confidence = PARAMS.bayesian_confidence_strong;
        console.log(`🔥 Équipe forte détectée (xG: ${teamMean.toFixed(2)}) - Confiance réduite à ${confidence}`);
    }
    
    return (confidence * leagueAvg + n * teamMean) / (confidence + n);
}

// VECTEUR D'ÉCART (Solution à l'illisibilité de la distance)
function calculateErrorVector(pred, actual) {
    const [pH, pA] = pred.split('-').map(Number);
    const [aH, aA] = actual.split('-').map(Number);
    return {
        home: pH - aH,      // Positif = trop optimiste, Négatif = trop pessimiste
        away: pA - aA,
        manhattan: Math.abs(pH - aH) + Math.abs(pA - aA)
    };
}

// ============================================================================
// DÉTECTION DES IMPACT PLAYERS
// ============================================================================

function detectImpactAbsences(match, meta, side) {
    const injuries = side === 'home' ? match.context?.injuries_home : match.context?.injuries_away;
    if (!injuries || !meta) return { offensive: 0, defensive: 0 };

    let offensiveImpact = 0;
    let defensiveImpact = 0;

    injuries.forEach(inj => {
        if (inj.type !== "Missing Fixture") return;

        const isTopScorer = meta.top_scorers?.some(vip => vip.id === inj.player_id);
        if (isTopScorer) offensiveImpact++;

        const isTopAssist = meta.top_assists?.some(vip => vip.id === inj.player_id);
        if (isTopAssist) offensiveImpact += 0.5;

        const playerRatings = side === 'home' ? 
            match.context?.player_ratings_home : 
            match.context?.player_ratings_away;
        
        const player = playerRatings?.find(p => p.id === inj.player_id);
        if (player && (player.position === 'Defender' || player.position === 'Goalkeeper')) {
            if (player.rating > 7.0) defensiveImpact++;
        }
    });

    return { offensive: offensiveImpact, defensive: defensiveImpact };
}

// ============================================================================
// CALCUL POISSON PRO + SOUS-MARCHÉS COMPLETS + A/B TESTING
// ============================================================================

function calculatePoissonPro(hID, aID, hElo, aElo, tracker, match, metaHome, metaAway) {
    const minMatches = PARAMS.min_matches;
    
    if (tracker[hID].xg.length < minMatches || tracker[aID].xg.length < minMatches) {
        return null;
    }

    const allXG = [...tracker[hID].xg, ...tracker[aID].xg];
    const leagueAvgXG = allXG.reduce((a, b) => a + b, 0) / allXG.length;

    // UTILISATION DU SHRINKAGE ADAPTATIF
    const attH = bayesianShrinkageAdaptive(tracker[hID].xg, leagueAvgXG);
    const defA = bayesianShrinkageAdaptive(tracker[aID].ga, leagueAvgXG);
    const attA = bayesianShrinkageAdaptive(tracker[aID].xg, leagueAvgXG);
    const defH = bayesianShrinkageAdaptive(tracker[hID].ga, leagueAvgXG);

    const pWinH = clubEloWinProb((hElo - aElo) + PARAMS.hfa);
    const pWinA = 1 - pWinH;

    let lh = (attH * 0.6 + defA * 0.4) * PARAMS.w_xg * Math.pow((pWinH / 0.5), PARAMS.w_elo);
    let la = (attA * 0.6 + defH * 0.4) * PARAMS.w_xg * Math.pow((pWinA / 0.5), PARAMS.w_elo);

    // AJUSTEMENT IMPACT PLAYERS
    if (match.context) {
        const impactH = detectImpactAbsences(match, metaHome, 'home');
        const impactA = detectImpactAbsences(match, metaAway, 'away');

        if (impactH.offensive > 0) lh *= (1 - PARAMS.impact_offensive * impactH.offensive);
        if (impactA.defensive > 0) lh *= (1 + PARAMS.impact_defensive * impactA.defensive);
        if (impactA.offensive > 0) la *= (1 - PARAMS.impact_offensive * impactA.offensive);
        if (impactH.defensive > 0) la *= (1 + PARAMS.impact_defensive * impactH.defensive);
    }

    lh = Math.max(lh, 0.01); 
    la = Math.max(la, 0.01);

    // MATRICE DE SCORES (9x9)
    let pH = 0, pD = 0, pA = 0;
    let scoreProbs = [];
    
    // SOUS-MARCHÉS MÉTHODE 1 (MATRICE AVEC CORRÉLATION)
    let m1_btts = 0, m1_over05 = 0, m1_over15 = 0, m1_over25 = 0, m1_over35 = 0;
    let m1_under05 = 0, m1_under15 = 0, m1_under25 = 0, m1_under35 = 0;
    let m1_homeScores = 0, m1_awayScores = 0;
    let m1_homeOver05 = 0, m1_homeOver15 = 0, m1_homeOver25 = 0;
    let m1_awayOver05 = 0, m1_awayOver15 = 0, m1_awayOver25 = 0;

    for (let i = 0; i < 9; i++) {
        for (let j = 0; j < 9; j++) {
            let corr = 1;
            if (i === 0 && j === 0) corr = 1 - (lh * la * PARAMS.rho);
            else if (i === 0 && j === 1) corr = 1 + (la * PARAMS.rho);
            else if (i === 1 && j === 0) corr = 1 + (lh * PARAMS.rho);
            else if (i === 1 && j === 1) corr = 1 - PARAMS.rho;

            const p = (Math.exp(-lh) * Math.pow(lh, i) / fact(i)) * (Math.exp(-la) * Math.pow(la, j) / fact(j)) * corr;

            scoreProbs.push({ score: `${i}-${j}`, prob: p });

            if (i > j) pH += p; 
            else if (i === j) pD += p; 
            else pA += p;

            // MÉTHODE 1 : AGRÉGATION MATRICIELLE
            if (i > 0 && j > 0) m1_btts += p;
            if (i + j > 0) m1_over05 += p;
            if (i + j > 1) m1_over15 += p;
            if (i + j > 2) m1_over25 += p;
            if (i + j > 3) m1_over35 += p;
            if (i + j < 1) m1_under05 += p;
            if (i + j < 2) m1_under15 += p;
            if (i + j < 3) m1_under25 += p;
            if (i + j < 4) m1_under35 += p;
            if (i > 0) m1_homeScores += p;
            if (j > 0) m1_awayScores += p;
            if (i > 0) m1_homeOver05 += p;
            if (i > 1) m1_homeOver15 += p;
            if (i > 2) m1_homeOver25 += p;
            if (j > 0) m1_awayOver05 += p;
            if (j > 1) m1_awayOver15 += p;
            if (j > 2) m1_awayOver25 += p;
        }
    }

    // MÉTHODE 2 : POISSON BRUT (SANS CORRÉLATION)
    const m2_homeScores = 1 - Math.exp(-lh);
    const m2_awayScores = 1 - Math.exp(-la);
    const m2_btts = m2_homeScores * m2_awayScores;
    
    // Over/Under bruts (approximation via Poisson)
    const m2_over25 = 1 - poissonCumulative(lh + la, 2);
    const m2_under25 = poissonCumulative(lh + la, 2);
    const m2_homeOver15 = 1 - poissonCumulative(lh, 1);
    const m2_awayOver15 = 1 - poissonCumulative(la, 1);

    // Top 3 scores
    const top3 = scoreProbs.sort((a, b) => b.prob - a.prob).slice(0, 3);

    return { 
        H: pH, D: pD, A: pA,
        debug: { lh, la, rho: PARAMS.rho, hfa: PARAMS.hfa, hElo, aElo },
        top3: top3,
        top3: top3,
        pred: top3[0].score,
        pScore: (top3[0].prob * 100).toFixed(1),
        
        // MÉTHODE 1 (Matrice)
        m1: {
            btts: (m1_btts * 100).toFixed(1),
            over05: (m1_over05 * 100).toFixed(1),
            over15: (m1_over15 * 100).toFixed(1),
            over25: (m1_over25 * 100).toFixed(1),
            over35: (m1_over35 * 100).toFixed(1),
            under05: (m1_under05 * 100).toFixed(1),
            under15: (m1_under15 * 100).toFixed(1),
            under25: (m1_under25 * 100).toFixed(1),
            under35: (m1_under35 * 100).toFixed(1),
            homeScores: (m1_homeScores * 100).toFixed(1),
            awayScores: (m1_awayScores * 100).toFixed(1),
            homeOver05: (m1_homeOver05 * 100).toFixed(1),
            homeOver15: (m1_homeOver15 * 100).toFixed(1),
            homeOver25: (m1_homeOver25 * 100).toFixed(1),
            awayOver05: (m1_awayOver05 * 100).toFixed(1),
            awayOver15: (m1_awayOver15 * 100).toFixed(1),
            awayOver25: (m1_awayOver25 * 100).toFixed(1)
        },
        
        // MÉTHODE 2 (Brut)
        m2: {
            btts: (m2_btts * 100).toFixed(1),
            over25: (m2_over25 * 100).toFixed(1),
            under25: (m2_under25 * 100).toFixed(1),
            homeScores: (m2_homeScores * 100).toFixed(1),
            awayScores: (m2_awayScores * 100).toFixed(1),
            homeOver15: (m2_homeOver15 * 100).toFixed(1),
            awayOver15: (m2_awayOver15 * 100).toFixed(1)
        }
    };
}

// Fonction auxiliaire : Cumulative Poisson Distribution
function poissonCumulative(lambda, k) {
    let sum = 0;
    for (let i = 0; i <= k; i++) {
        sum += (Math.exp(-lambda) * Math.pow(lambda, i)) / fact(i);
    }
    return sum;
}

// ============================================================================
// BACKTEST ENRICHI AVEC VECTEURS D'ÉCART
// ============================================================================

function runBacktest() {
    let globalStats = { 
        total: 0, sdmW: 0, 
        scoreExact: 0, scoreTop3: 0,
        errorVectors: { home: [], away: [] }, // Pour analyse des biais
        
        // Sous-marchés M1
        m1_bttsCorrect: 0, m1_over25Correct: 0, m1_under25Correct: 0,
        m1_homeScoresCorrect: 0, m1_awayScoresCorrect: 0,
        
        // Sous-marchés M2
        m2_bttsCorrect: 0, m2_over25Correct: 0, m2_under25Correct: 0,
        m2_homeScoresCorrect: 0, m2_awayScoresCorrect: 0
    };

    let leagues = {};

    console.log('\n' + '='.repeat(90));
    console.log('🚀 BACKTEST V3 - Vecteur d\'Écart & A/B Testing (Matrice vs Brut)');
    console.log('='.repeat(90));
    console.log(`📊 Confiance Bayésienne : Base=${PARAMS.bayesian_confidence_base}, Équipes Fortes=${PARAMS.bayesian_confidence_strong}`);
    console.log('='.repeat(90) + '\n');

    for (const lid of Object.keys(LEAGUES_CONFIG)) {
        const file = PATHS.history(lid);
        const metaFile = PATHS.meta(lid);
        
        if (!fs.existsSync(file)) continue;

        let meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null;

        leagues[lid] = { 
            name: LEAGUES_CONFIG[lid].name, 
            matches: []
        };

        const history = JSON.parse(fs.readFileSync(file))
            .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
        
        let tracker = {};

        for (const m of history) {
            const rKey = m.league.round;
            const hID = m.teams.home.id; 
            const aID = m.teams.away.id;
            const hName = m.teams.home.name; 
            const aName = m.teams.away.name;

            if (!tracker[hID]) tracker[hID] = { xg: [], ga: [] };
            if (!tracker[aID]) tracker[aID] = { xg: [], ga: [] };

            if (tracker[hID].xg.length >= PARAMS.min_matches && 
                tracker[aID].xg.length >= PARAMS.min_matches) {
                
                const hElo = ELO_HISTORY[lid]?.[rKey]?.[hName] || 1500;
                const aElo = ELO_HISTORY[lid]?.[rKey]?.[aName] || 1500;

                const res = calculatePoissonPro(hID, aID, hElo, aElo, tracker, m, meta, meta);
                
                if (res) {
                    const actual = `${m.goals.home}-${m.goals.away}`;
                    const actualH = m.goals.home;
                    const actualA = m.goals.away;
                    
                    // VECTEUR D'ÉCART
                    const errorVec = calculateErrorVector(res.pred, actual);
                    globalStats.errorVectors.home.push(errorVec.home);
                    globalStats.errorVectors.away.push(errorVec.away);
                    
                    // SDM
                    const isSdmOk = (res.H + res.D >= res.A + res.D) ? 
                        (actualH >= actualA) : (actualA >= actualH);
                    
                    // SDM PICK + CONFIANCE (pour tranches UI)
                    const sdmPick = (res.H >= res.A) ? '1X' : 'X2';
                    const sdmConf = ((sdmPick === '1X') ? (res.H + res.D) : (res.A + res.D)) * 100;

                    // Score
                    const isScoreExact = (res.pred === actual);
                    const isTop3 = res.top3.some(s => s.score === actual);
                    
                    // Sous-marchés actuels
                    const actualBTTS = (actualH > 0 && actualA > 0);
                    const actualOver25 = (actualH + actualA > 2);
                    const actualUnder25 = (actualH + actualA < 3);
                    const actualHomeScores = (actualH > 0);
                    const actualAwayScores = (actualA > 0);
                    
                    // Prédictions M1 (seuil 50%)
                    const m1_predBTTS = parseFloat(res.m1.btts) > 50;
                    const m1_predOver25 = parseFloat(res.m1.over25) > 50;
                    const m1_predUnder25 = parseFloat(res.m1.under25) > 50;
                    const m1_predHomeScores = parseFloat(res.m1.homeScores) > 50;
                    const m1_predAwayScores = parseFloat(res.m1.awayScores) > 50;
                    
                    // Prédictions M2
                    const m2_predBTTS = parseFloat(res.m2.btts) > 50;
                    const m2_predOver25 = parseFloat(res.m2.over25) > 50;
                    const m2_predUnder25 = parseFloat(res.m2.under25) > 50;
                    const m2_predHomeScores = parseFloat(res.m2.homeScores) > 50;
                    const m2_predAwayScores = parseFloat(res.m2.awayScores) > 50;
                    
                    // Stats
                    globalStats.total++;
                    if (isSdmOk) globalStats.sdmW++;
                    if (isScoreExact) globalStats.scoreExact++;
                    if (isTop3) globalStats.scoreTop3++;
                    
                    if (m1_predBTTS === actualBTTS) globalStats.m1_bttsCorrect++;
                    if (m1_predOver25 === actualOver25) globalStats.m1_over25Correct++;
                    if (m1_predUnder25 === actualUnder25) globalStats.m1_under25Correct++;
                    if (m1_predHomeScores === actualHomeScores) globalStats.m1_homeScoresCorrect++;
                    if (m1_predAwayScores === actualAwayScores) globalStats.m1_awayScoresCorrect++;
                    
                    if (m2_predBTTS === actualBTTS) globalStats.m2_bttsCorrect++;
                    if (m2_predOver25 === actualOver25) globalStats.m2_over25Correct++;
                    if (m2_predUnder25 === actualUnder25) globalStats.m2_under25Correct++;
                    if (m2_predHomeScores === actualHomeScores) globalStats.m2_homeScoresCorrect++;
                    if (m2_predAwayScores === actualAwayScores) globalStats.m2_awayScoresCorrect++;
                    
                    leagues[lid].matches.push({
                        leagueId: lid,
                        round: rKey,
                        date: m.fixture?.date,
                        home: hName, away: aName, actual, 
                        pred: res.pred,
                        top3: res.top3,
                        errorVec: errorVec,
                        sdmPick, sdmConf,
                        isSdmOk, isScoreExact, isTop3,
                        m1: res.m1,
                        m2: res.m2,
                        submarkets: {
                            btts: { actual: actualBTTS, m1: m1_predBTTS, m2: m2_predBTTS },
                            over25: { actual: actualOver25, m1: m1_predOver25, m2: m2_predOver25 },
                            under25: { actual: actualUnder25, m1: m1_predUnder25, m2: m2_predUnder25 },
                            homeScores: { actual: actualHomeScores, m1: m1_predHomeScores, m2: m2_predHomeScores },
                            awayScores: { actual: actualAwayScores, m1: m1_predAwayScores, m2: m2_predAwayScores }
                        }
                    });
                }
            }

            if (m.stats?.home && m.goals.home !== null) {
                tracker[hID].xg.push(parseFloat(m.stats.home.expected_goals || 0)); 
                tracker[hID].ga.push(m.goals.away);
                tracker[aID].xg.push(parseFloat(m.stats.away.expected_goals || 0)); 
                tracker[aID].ga.push(m.goals.home);
            }
        }
    }

    printResults(globalStats, leagues);
    startServer(globalStats, leagues);
}

function printResults(global, leagues) {
    const avgErrorHome = global.errorVectors.home.reduce((a, b) => a + b, 0) / (global.errorVectors.home.length || 1);
    const avgErrorAway = global.errorVectors.away.reduce((a, b) => a + b, 0) / (global.errorVectors.away.length || 1);

    console.log("\n" + "=".repeat(90));
    console.log("📊 RÉSULTATS GLOBAUX");
    console.log("=".repeat(90));
    console.log(`Total Matchs          : ${global.total}`);
    console.log(`Précision SDM         : ${(global.sdmW / global.total * 100).toFixed(2)}% (${global.sdmW}/${global.total})`);
    console.log(`Score Exact (Top 1)   : ${(global.scoreExact / global.total * 100).toFixed(2)}% (${global.scoreExact}/${global.total})`);
    console.log(`Score Exact (Top 3)   : ${(global.scoreTop3 / global.total * 100).toFixed(2)}% (${global.scoreTop3}/${global.total})`);
    console.log("=".repeat(90));

    console.log("\n🎯 ANALYSE DES BIAIS (Vecteur d'Écart Moyen)");
    console.log("=".repeat(90));
    console.log(`Erreur Domicile Moy.  : ${avgErrorHome >= 0 ? '+' : ''}${avgErrorHome.toFixed(3)} but(s) ${avgErrorHome > 0 ? '(Trop optimiste)' : avgErrorHome < 0 ? '(Trop pessimiste)' : '(Parfait)'}`);
    console.log(`Erreur Extérieur Moy. : ${avgErrorAway >= 0 ? '+' : ''}${avgErrorAway.toFixed(3)} but(s) ${avgErrorAway > 0 ? '(Trop optimiste)' : avgErrorAway < 0 ? '(Trop pessimiste)' : '(Parfait)'}`);
    console.log("=".repeat(90));

    const getWinner = (m1, m2) => m1 > m2 ? '✅ M1 GAGNE' : m2 > m1 ? '❌ M2 GAGNE' : '🟰 ÉGALITÉ';

    console.log("\n🆚 COMPARAISON A/B : MATRICE (M1) vs BRUT (M2)");
    console.log("=".repeat(90));
    console.log(`BTTS              : M1=${(global.m1_bttsCorrect/global.total*100).toFixed(2)}% vs M2=${(global.m2_bttsCorrect/global.total*100).toFixed(2)}% ${getWinner(global.m1_bttsCorrect, global.m2_bttsCorrect)}`);
    console.log(`Over 2.5          : M1=${(global.m1_over25Correct/global.total*100).toFixed(2)}% vs M2=${(global.m2_over25Correct/global.total*100).toFixed(2)}% ${getWinner(global.m1_over25Correct, global.m2_over25Correct)}`);
    console.log(`Under 2.5         : M1=${(global.m1_under25Correct/global.total*100).toFixed(2)}% vs M2=${(global.m2_under25Correct/global.total*100).toFixed(2)}% ${getWinner(global.m1_under25Correct, global.m2_under25Correct)}`);
    console.log(`Home Marque       : M1=${(global.m1_homeScoresCorrect/global.total*100).toFixed(2)}% vs M2=${(global.m2_homeScoresCorrect/global.total*100).toFixed(2)}% ${getWinner(global.m1_homeScoresCorrect, global.m2_homeScoresCorrect)}`);
    console.log(`Away Marque       : M1=${(global.m1_awayScoresCorrect/global.total*100).toFixed(2)}% vs M2=${(global.m2_awayScoresCorrect/global.total*100).toFixed(2)}% ${getWinner(global.m1_awayScoresCorrect, global.m2_awayScoresCorrect)}`);
    console.log("=".repeat(90) + "\n");
}

// ============================================================================
// SERVEUR WEB AVEC TABLEAU A/B
// ============================================================================

function startServer(global, leagues) {
    // ----------------------------
    // Helpers (server-side render)
    // ----------------------------
    const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
    const pct = (num, den, d = 1) => den ? (num / den * 100).toFixed(d) : (0).toFixed(d);
	const fmt2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—');
	const fmtInt = (x) => (Number.isFinite(Number(x)) ? String(Math.round(Number(x))) : '—');

    const BUCKETS = [
        { key: "90-100", label: "Tranche 90-100%", min: 90, max: 100, color: "#fbbf24" },
        { key: "80-90",  label: "Tranche 80-90%",  min: 80, max: 90,  color: "#10b981" },
        { key: "70-80",  label: "Tranche 70-80%",  min: 70, max: 80,  color: "#0ea5e9" },
        { key: "60-70",  label: "Tranche 60-70%",  min: 60, max: 70,  color: "#f59e0b" },
        { key: "50-60",  label: "Tranche 50-60%",  min: 50, max: 60,  color: "#94a3b8" },
    ];

    const allMatches = Object.values(leagues).flatMap(l => l.matches || []);

    function bucketKeyFromConfidence(conf) {
        const c = clamp(conf, 0, 100);
        for (const b of BUCKETS) {
            if (c >= b.min && (c < b.max || b.max === 100)) return b.key;
        }
        return null;
    }

    // --- SDM (1X / X2) buckets ---
    const sdmBuckets = Object.fromEntries(BUCKETS.map(b => [b.key, { total: 0, win: 0, scoreExact: 0 }]));
    for (const m of allMatches) {
        if (typeof m.sdmConf !== "number") continue;
        const k = bucketKeyFromConfidence(m.sdmConf);
        if (!k) continue;
        sdmBuckets[k].total++;
        if (m.isSdmOk) sdmBuckets[k].win++;
        if (m.isScoreExact) sdmBuckets[k].scoreExact++;
    }

    // --- Submarkets buckets (M1 vs M2) ---
    const SUBMARKETS = [
        {
            id: "ou25",
            title: "⚽ OVER/UNDER 2.5 Goals",
            // returns { conf1, ok1, conf2, ok2 }
            eval: (m) => {
                const m1o = parseFloat(m.m1?.over25 ?? "0");
                const m1u = parseFloat(m.m1?.under25 ?? "0");
                const m2o = parseFloat(m.m2?.over25 ?? "0");
                const m2u = parseFloat(m.m2?.under25 ?? "0");

                const pick1 = m1o >= m1u ? "over" : "under";
                const pick2 = m2o >= m2u ? "over" : "under";

                const conf1 = Math.max(m1o, m1u);
                const conf2 = Math.max(m2o, m2u);

                const actualOver = !!m.submarkets?.over25?.actual;
                const ok1 = (pick1 === "over") ? actualOver : !actualOver;
                const ok2 = (pick2 === "over") ? actualOver : !actualOver;

                return { conf1, ok1, conf2, ok2 };
            }
        },
        {
            id: "btts",
            title: "🎲 BTTS (Both Teams To Score)",
            eval: (m) => {
                const p1 = parseFloat(m.m1?.btts ?? "0");
                const p2 = parseFloat(m.m2?.btts ?? "0");
                const conf1 = Math.max(p1, 100 - p1);
                const conf2 = Math.max(p2, 100 - p2);
                const ok1 = (m.submarkets?.btts?.m1 === m.submarkets?.btts?.actual);
                const ok2 = (m.submarkets?.btts?.m2 === m.submarkets?.btts?.actual);
                return { conf1, ok1, conf2, ok2 };
            }
        },
        {
            id: "home15",
            title: "🏠 HOME TEAM Over 1.5",
            eval: (m) => {
                const p1 = parseFloat(m.m1?.homeOver15 ?? "0");
                const p2 = parseFloat(m.m2?.homeOver15 ?? "0");
                const conf1 = Math.max(p1, 100 - p1);
                const conf2 = Math.max(p2, 100 - p2);
                // on n'a pas stocké l'actual home>1.5 explicitement : on le déduit via actual score
                const [aH, aA] = (m.actual || "0-0").split("-").map(Number);
                const actual = aH > 1;
                const pred1 = p1 > 50;
                const pred2 = p2 > 50;
                return { conf1, ok1: pred1 === actual, conf2, ok2: pred2 === actual };
            }
        },
        {
            id: "away05",
            title: "✈️ AWAY TEAM Over 0.5",
            eval: (m) => {
                const p1 = parseFloat(m.m1?.awayScores ?? "0");
                const p2 = parseFloat(m.m2?.awayScores ?? "0");
                const conf1 = Math.max(p1, 100 - p1);
                const conf2 = Math.max(p2, 100 - p2);
                const ok1 = (m.submarkets?.awayScores?.m1 === m.submarkets?.awayScores?.actual);
                const ok2 = (m.submarkets?.awayScores?.m2 === m.submarkets?.awayScores?.actual);
                return { conf1, ok1, conf2, ok2 };
            }
        },
        {
            id: "home05",
            title: "🏟️ HOME TEAM Over 0.5",
            eval: (m) => {
                const p1 = parseFloat(m.m1?.homeScores ?? "0");
                const p2 = parseFloat(m.m2?.homeScores ?? "0");
                const conf1 = Math.max(p1, 100 - p1);
                const conf2 = Math.max(p2, 100 - p2);
                const ok1 = (m.submarkets?.homeScores?.m1 === m.submarkets?.homeScores?.actual);
                const ok2 = (m.submarkets?.homeScores?.m2 === m.submarkets?.homeScores?.actual);
                return { conf1, ok1, conf2, ok2 };
            }
        },
    ];

    const subBucketsByMarket = {};
    for (const sm of SUBMARKETS) {
        subBucketsByMarket[sm.id] = Object.fromEntries(
            BUCKETS.map(b => [b.key, { total: 0, m1ok: 0, m2ok: 0 }])
        );

        for (const m of allMatches) {
            const { conf1, ok1, conf2, ok2 } = sm.eval(m);
            const k = bucketKeyFromConfidence(conf1);
            if (!k) continue;
            subBucketsByMarket[sm.id][k].total++;
            if (ok1) subBucketsByMarket[sm.id][k].m1ok++;
            if (ok2) subBucketsByMarket[sm.id][k].m2ok++;
        }
    }

    // --- League cards stats ---
    function leagueStats(l) {
        const ms = l.matches || [];
        const total = ms.length || 0;
        const sdmW = ms.filter(x => x.isSdmOk).length;
        const scoreExact = ms.filter(x => x.isScoreExact).length;
        const avgDist = total
            ? (ms.reduce((acc, x) => acc + (x.errorVec?.manhattan ?? 0), 0) / total).toFixed(2)
            : "0.00";
        const bttsM1 = total
            ? pct(ms.filter(x => x.submarkets?.btts?.m1 === x.submarkets?.btts?.actual).length, total, 1)
            : "0.0";
        const ou25M1 = total
            ? pct(ms.filter(x => x.submarkets?.over25?.m1 === x.submarkets?.over25?.actual).length, total, 1)
            : "0.0";
        return { total, sdmW, scoreExact, avgDist, bttsM1, ou25M1 };
    }

    // --- Render helpers ---
    function renderBucketCards(bucketObj, renderSub) {
        return BUCKETS.map(b => {
            const s = bucketObj[b.key];
            return `
                <div class="kpi-card" style="color: ${b.color};">
                    <div class="label">${b.label}</div>
                    <div class="value">${pct(s.win ?? s.m1ok ?? 0, s.total, 1)}%</div>
                    <div class="sub">${renderSub(b, s)}</div>
                </div>
            `;
        }).join("");
    }

    function renderSubmarketCards(smId) {
        const bucketObj = subBucketsByMarket[smId];
        return BUCKETS.map(b => {
            const s = bucketObj[b.key];
            const m1p = parseFloat(pct(s.m1ok, s.total, 1));
            const m2p = parseFloat(pct(s.m2ok, s.total, 1));
            const delta = (m1p - m2p);
            const deltaTxt = (s.total === 0) ? "—" : `${delta >= 0 ? "M1" : "M2"} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
            const deltaColor = (s.total === 0) ? "#94a3b8" : (delta >= 0 ? "#4ade80" : "#ef4444");
            return `
                <div class="kpi-card" style="color: ${b.color};">
                    <div class="label">${b.key}%</div>
                    <div class="value">${pct(s.m1ok, s.total, 1)}%</div>
                    <div class="sub">✅ ${s.m1ok}/${s.total} | <span style="color:${deltaColor}; font-weight:bold">${deltaTxt}</span></div>
                </div>
            `;
        }).join("");
    }

    function formatConfBadge(conf) {
        const c = clamp(conf, 0, 100);
        const bg = c >= 85 ? "#10b981" : c >= 75 ? "#0ea5e9" : c >= 65 ? "#fbbf24" : "#94a3b8";
        const fg = (bg === "#94a3b8") ? "#0f172a" : "#000";
        return `<span style="padding:5px 10px; border-radius:6px; background:${bg}; color:${fg}; font-weight:bold">${c.toFixed(0)}%</span>`;
    }

    function vectorClass(m) {
        const d = m.errorVec?.manhattan ?? 99;
        if (d === 0) return "vector-perfect";
        if (d <= 1) return "vector-close";
        return "vector-far";
    }

    function sdmResultLabel(m) {
        return m.isSdmOk
            ? `<span style="color:#4ade80; font-weight:bold;">✅ SDM</span>`
            : `<span style="color:#ef4444; font-weight:bold;">❌ FAIL</span>`;
    }

    function safeId(s) {
        return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    // Group by league then by round
    const leaguesHtml = Object.entries(leagues).map(([lid, l]) => {
        const st = leagueStats(l);
        return `
            <div class="league-card">
                <div class="league-header">⚽ ${l.name}</div>
                <div class="stat-row">
                    <span class="stat-label">SDM (1X/X2)</span>
                    <span class="stat-value">${pct(st.sdmW, st.total, 1)}% (${st.sdmW}/${st.total})</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Score Exact</span>
                    <span class="stat-value">${pct(st.scoreExact, st.total, 1)}% (${st.scoreExact}/${st.total})</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Distance Moy.</span>
                    <span class="stat-value">${st.avgDist} buts</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">BTTS (M1)</span>
                    <span class="stat-value">${st.bttsM1}%</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Over/Under 2.5 (M1)</span>
                    <span class="stat-value">${st.ou25M1}%</span>
                </div>
            </div>
        `;
    }).join("");

    function renderLeagueLogs(lid, l) {
        // group matches by round key
        const byRound = {};
        for (const m of (l.matches || [])) {
            const r = m.round || "N/A";
            byRound[r] = byRound[r] || [];
            byRound[r].push(m);
        }

        const roundsHtml = Object.keys(byRound).sort().map(r => {
            const rows = byRound[r].map((m, idx) => {
                const matchId = `m_${safeId(lid)}_${safeId(r)}_${idx}`;
                const [aH, aA] = (m.actual || "0-0").split("-").map(Number);

                const topScoresHtml = (m.top3 || []).map(s => {
                    const score = s.score;
                    const prob = (s.prob * 100).toFixed(1);
                    const cls = score === m.pred ? "score-item predicted" : (score === m.actual ? "score-item actual" : "score-item");
                    const tag = score === m.pred ? `<div style="font-size:0.7em; color:#38bdf8; margin-top:5px;">⭐ PRÉDIT</div>`
                             : score === m.actual ? `<div style="font-size:0.7em; color:#4ade80; margin-top:5px;">✅ RÉEL</div>`
                             : "";
                    return `
                        <div class="${cls}">
                            <div class="score">${score}</div>
                            <div class="prob">${prob}%</div>
                            ${tag}
                        </div>
                    `;
                }).join("");

                const debug = m.debug || {};
                const abRows = [
                    { name: "BTTS", m1: m.m1?.btts, m2: m.m2?.btts, actual: m.submarkets?.btts?.actual, ok1: m.submarkets?.btts?.m1 === m.submarkets?.btts?.actual, ok2: m.submarkets?.btts?.m2 === m.submarkets?.btts?.actual },
                    { name: "Over 2.5", m1: m.m1?.over25, m2: m.m2?.over25, actual: m.submarkets?.over25?.actual, ok1: m.submarkets?.over25?.m1 === m.submarkets?.over25?.actual, ok2: m.submarkets?.over25?.m2 === m.submarkets?.over25?.actual },
                    { name: "Under 2.5", m1: m.m1?.under25, m2: m.m2?.under25, actual: m.submarkets?.under25?.actual, ok1: m.submarkets?.under25?.m1 === m.submarkets?.under25?.actual, ok2: m.submarkets?.under25?.m2 === m.submarkets?.under25?.actual },
                    { name: "Home >0.5", m1: m.m1?.homeScores, m2: m.m2?.homeScores, actual: m.submarkets?.homeScores?.actual, ok1: m.submarkets?.homeScores?.m1 === m.submarkets?.homeScores?.actual, ok2: m.submarkets?.homeScores?.m2 === m.submarkets?.homeScores?.actual },
                    { name: "Away >0.5", m1: m.m1?.awayScores, m2: m.m2?.awayScores, actual: m.submarkets?.awayScores?.actual, ok1: m.submarkets?.awayScores?.m1 === m.submarkets?.awayScores?.actual, ok2: m.submarkets?.awayScores?.m2 === m.submarkets?.awayScores?.actual },
                    { name: "Home >1.5", m1: m.m1?.homeOver15, m2: m.m2?.homeOver15, actual: (aH > 1), ok1: (parseFloat(m.m1?.homeOver15 ?? "0") > 50) === (aH > 1), ok2: (parseFloat(m.m2?.homeOver15 ?? "0") > 50) === (aH > 1) },
                    { name: "Away >1.5", m1: m.m1?.awayOver15, m2: m.m2?.awayOver15, actual: (aA > 1), ok1: (parseFloat(m.m1?.awayOver15 ?? "0") > 50) === (aA > 1), ok2: (parseFloat(m.m2?.awayOver15 ?? "0") > 50) === (aA > 1) },
                ].map(row => {
                    const m1v = row.m1 !== undefined ? `${row.m1}%` : "—";
                    const m2v = row.m2 !== undefined ? `${row.m2}%` : "—";
                    const resTxt = (row.actual === true) ? "✅ OUI" : "❌ NON";
                    const okBadge = row.ok1 ? `<span class="badge badge-success">✅</span>` : `<span class="badge badge-danger">❌</span>`;
                    // value = (m1 - m2)
                    const v = (row.m1 !== undefined && row.m2 !== undefined) ? (parseFloat(row.m1) - parseFloat(row.m2)) : null;
                    const vTxt = v === null ? "—" : `${v >= 0 ? "M1" : "M2"} ${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
                    const vColor = v === null ? "#94a3b8" : (v >= 0 ? "#4ade80" : "#ef4444");
                    return `
                        <tr>
                            <td>${row.name}</td>
                            <td><strong>${m1v}</strong></td>
                            <td>${m2v}</td>
                            <td>${resTxt}</td>
                            <td>${okBadge}</td>
                            <td style="color:${vColor}; font-weight:bold;">${vTxt}</td>
                        </tr>
                    `;
                }).join("");

                return `
                    <tr class="match-row" onclick="toggleMatchDetails('${matchId}')">
                        <td style="font-weight:500">${m.home} vs ${m.away}</td>
                        <td><span class="badge badge-info">${m.actual}</span></td>
                        <td><span class="badge">${m.sdmPick || "—"}</span></td>
                        <td>${formatConfBadge(m.sdmConf ?? 0)}</td>
                        <td><span class="vector ${vectorClass(m)}">[${m.errorVec?.home >= 0 ? "+" : ""}${m.errorVec?.home} | ${m.errorVec?.away >= 0 ? "+" : ""}${m.errorVec?.away}]</span></td>
                        <td>${sdmResultLabel(m)}</td>
                    </tr>
                    <tr>
                        <td colspan="6" style="padding: 0; border: none;">
                            <div id="${matchId}" class="match-details">
                                <!-- RÉCAP -->
                                <div style="background: #1e293b; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                                    <h3 style="color: #38bdf8; margin-bottom: 15px;">🏟️ ${m.home} vs ${m.away}</h3>
                                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                                        <div>
                                            <div style="color: #64748b; font-size: 0.8em;">Score Réel</div>
                                            <div style="font-size: 1.5em; font-weight: bold; color: #4ade80;">${m.actual}</div>
                                        </div>
                                        <div>
                                            <div style="color: #64748b; font-size: 0.8em;">Score Prédit</div>
                                            <div style="font-size: 1.5em; font-weight: bold; color: #38bdf8;">${m.pred}</div>
                                        </div>
                                        <div>
                                            <div style="color: #64748b; font-size: 0.8em;">Écart Vectoriel</div>
                                            <div style="font-size: 1.5em; font-weight: bold; color: #fbbf24;">[${m.errorVec?.home >= 0 ? "+" : ""}${m.errorVec?.home} | ${m.errorVec?.away >= 0 ? "+" : ""}${m.errorVec?.away}]</div>
                                        </div>
                                        <div>
                                            <div style="color: #64748b; font-size: 0.8em;">SDM</div>
                                            <div style="font-size: 0.9em; color: #94a3b8;">Pick ${m.sdmPick} • Confiance ${clamp(m.sdmConf ?? 0, 0, 100).toFixed(0)}%</div>
                                        </div>
                                    </div>
                                </div>

                                <!-- A/B -->
                                <div class="detail-section">
                                    <div class="detail-title">🎯 Analyse Comparative des Sous-Marchés (A/B Testing)</div>
                                    <table class="comparison-table">
                                        <thead>
                                            <tr>
                                                <th>Marché</th>
                                                <th>Prob. Matrice (M1)</th>
                                                <th>Prob. Brute (M2)</th>
                                                <th>Résultat</th>
                                                <th>Correct ?</th>
                                                <th>Value</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${abRows}
                                        </tbody>
                                    </table>
                                </div>

                                <!-- TOP SCORES -->
                                <div class="detail-section">
                                    <div class="detail-title">📊 Distribution de la Matrice 9×9 - Top Scores</div>
                                    <div class="top-scores">
                                        ${topScoresHtml || `<div style="color:#94a3b8;">—</div>`}
                                    </div>
                                </div>

                                <!-- METRICS -->
                                <div class="detail-section">
                                    <div class="detail-title">🔬 Métriques Techniques</div>
                                    <div class="metrics-grid">
                                        <div class="metric-item">
                                            <div class="metric-label">λ Domicile</div>
											<div class="metric-value">${fmt2(debug?.lh)}</div>
                                        </div>
                                        <div class="metric-item">
                                            <div class="metric-label">λ Extérieur</div>
											<div class="metric-value">${fmt2(debug?.la)}</div>
                                        </div>
                                        <div class="metric-item">
                                            <div class="metric-label">Corrélation Rho</div>
											<div class="metric-value">${debug?.rho ?? "—"}</div>
                                        </div>
                                        <div class="metric-item">
                                            <div class="metric-label">HFA</div>
											<div class="metric-value">${debug?.hfa != null ? `+${fmt2(Number(debug.hfa))}` : "—"}</div>
                                        </div>
                                        <div class="metric-item">
                                            <div class="metric-label">Elo Home</div>
											<div class="metric-value">${debug?.hElo ?? "—"}</div>
                                        </div>
                                        <div class="metric-item">
                                            <div class="metric-label">Elo Away</div>
											<div class="metric-value">${debug?.aElo ?? "—"}</div>
                                        </div>
                                    </div>
                                </div>

                            </div>
                        </td>
                    </tr>
                `;
            }).join("");

            return `
                <div style="margin-top:25px; font-weight:bold; color:#94a3b8; font-size:0.9em; padding:8px; background:#0f172a; border-radius:6px">
                    📅 ${r}
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Match</th>
                            <th>Score</th>
                            <th>Pari SDM</th>
                            <th>Confiance</th>
                            <th>Écart Vectoriel</th>
                            <th>Résultat</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
            `;
        }).join("");

        return `
            <div class="round-box">
                <h2 style="margin:0 0 20px 0; font-size:1.3em; color:#38bdf8">⚽ ${l.name} - Logs Détaillés</h2>
                ${roundsHtml || `<div style="color:#94a3b8;">Aucun match</div>`}
            </div>
        `;
    }

    const logsHtml = Object.entries(leagues).map(([lid, l]) => renderLeagueLogs(lid, l)).join("");

    // ----------------------------
    // HTML (design.html port)
    // ----------------------------
    const html = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SDM Ultra - Backtest</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0f172a;
            color: white;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            padding: 30px;
        }
        .container { max-width: 1800px; margin: auto; }
        h1 {
            color: #38bdf8;
            border-left: 5px solid #38bdf8;
            padding-left: 15px;
            margin-bottom: 30px;
            font-size: 2em;
        }
        h2 {
            color: #38bdf8;
            margin: 40px 0 20px 0;
            font-size: 1.5em;
        }

        /* KPI GRID - MARCHÉ PRINCIPAL */
        .kpi-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 15px;
            margin: 30px 0;
        }
        .kpi-card {
            background: #1e293b;
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            border: 1px solid #334155;
            position: relative;
            transition: transform 0.2s;
        }
        .kpi-card:hover { transform: translateY(-3px); }
        .kpi-card::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background: currentColor;
            border-radius: 0 0 12px 12px;
        }
        .kpi-card .label {
            font-size: 0.75em;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        .kpi-card .value {
            font-size: 2.2em;
            font-weight: 800;
            color: #38bdf8;
        }
        .kpi-card .sub {
            font-size: 0.85em;
            color: #94a3b8;
            margin-top: 8px;
        }

        /* SOUS-MARCHÉS SECTION */
        .submarkets-section {
            background: #1e293b;
            border-radius: 12px;
            padding: 25px;
            margin: 30px 0;
            border: 1px solid #334155;
        }
        .submarket-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        .submarket-title {
            font-size: 1.3em;
            color: #38bdf8;
            font-weight: bold;
        }
        .toggle-btn {
            background: #38bdf8;
            color: #000;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
        }
        .toggle-btn:hover {
            background: #0ea5e9;
            transform: scale(1.05);
        }
        .submarkets-visible {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 15px;
        }
        .submarkets-hidden {
            display: none;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 15px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #334155;
        }
        .submarkets-hidden.active { display: grid; }

        /* LEAGUE GRID */
        .league-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
            gap: 20px;
            margin-bottom: 50px;
        }
        .league-card {
            background: #1e293b;
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #334155;
        }
        .league-header {
            font-weight: bold;
            color: #38bdf8;
            font-size: 1.1em;
            margin-bottom: 15px;
            border-bottom: 2px solid #334155;
            padding-bottom: 10px;
        }
        .stat-row {
            display: flex;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            font-size: 0.9em;
        }
        .stat-label { color: #94a3b8; }
        .stat-value { font-weight: bold; color: #4ade80; }

        /* MATCH TABLE */
        .round-box {
            background: #1e293b;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 35px;
            border: 1px solid #334155;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            background: #1e293b;
            border-radius: 12px;
            overflow: hidden;
        }
        th {
            text-align: left;
            color: #64748b;
            font-size: 0.8em;
            text-transform: uppercase;
            padding: 15px;
            border-bottom: 2px solid #0f172a;
            background: #1e293b;
        }
        td {
            padding: 12px 15px;
            border-bottom: 1px solid #334155;
            font-size: 0.9em;
        }
        tr:hover { background: #334155; cursor: pointer; }
        tr.match-row.expanded { background: #334155; }

        /* MATCH DETAILS */
        .match-details {
            display: none;
            background: #0f172a;
            padding: 25px;
            border-radius: 8px;
            margin: 15px 0;
        }
        .match-details.active {
            display: block;
            animation: slideDown 0.3s ease-out;
        }
        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-10px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .detail-section { margin: 20px 0; }
        .detail-title {
            color: #38bdf8;
            font-weight: bold;
            font-size: 1.1em;
            margin-bottom: 15px;
            border-bottom: 2px solid #334155;
            padding-bottom: 8px;
        }
        .comparison-table {
            width: 100%;
            background: #1e293b;
            border-radius: 8px;
            overflow: hidden;
        }
        .comparison-table th {
            background: #1e293b;
            color: #38bdf8;
            font-size: 0.85em;
        }
        .comparison-table td { font-size: 0.85em; }

        /* BADGES */
        .badge {
            padding: 5px 10px;
            border-radius: 6px;
            font-weight: bold;
            font-size: 0.85em;
            display: inline-block;
        }
        .badge-success { background: #4ade80; color: #000; }
        .badge-warning { background: #fbbf24; color: #000; }
        .badge-danger  { background: #ef4444; color: #fff; }
        .badge-info    { background: #38bdf8; color: #000; }

        /* VECTOR ERROR */
        .vector {
            font-weight: bold;
            padding: 5px 10px;
            border-radius: 5px;
            font-family: 'Courier New', monospace;
        }
        .vector-perfect { background: #4ade80; color: #000; }
        .vector-close   { background: #fbbf24; color: #000; }
        .vector-far     { background: #ef4444; color: #fff; }

        /* TOP SCORES */
        .top-scores {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 10px;
            margin-top: 10px;
        }
        .score-item {
            background: #1e293b;
            padding: 10px;
            border-radius: 6px;
            text-align: center;
            border: 2px solid transparent;
        }
        .score-item.predicted { border-color: #38bdf8; }
        .score-item.actual    { border-color: #4ade80; }
        .score-item .score {
            font-size: 1.5em;
            font-weight: bold;
            color: #38bdf8;
        }
        .score-item .prob {
            font-size: 0.8em;
            color: #94a3b8;
            margin-top: 5px;
        }

        /* METRICS GRID */
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 15px;
        }
        .metric-item {
            background: #1e293b;
            padding: 15px;
            border-radius: 8px;
            border-left: 3px solid #38bdf8;
        }
        .metric-label {
            font-size: 0.8em;
            color: #64748b;
            margin-bottom: 5px;
        }
        .metric-value {
            font-size: 1.3em;
            font-weight: bold;
            color: #38bdf8;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎯 SDM ULTRA - Enhanced Backtest</h1>

        <!-- MARCHÉ PRINCIPAL -->
        <h2>📊 Marché Principal : SDM (1X/X2) - Tranches de Confiance</h2>
        <div class="kpi-grid">
            ${BUCKETS.map(b => {
                const s = sdmBuckets[b.key];
                return `
                    <div class="kpi-card" style="color: ${b.color};">
                        <div class="label">${b.label}</div>
                        <div class="value">${pct(s.win, s.total, 1)}%</div>
                        <div class="sub">🎯 ${s.win}/${s.total} paris | Score Exact: ${s.scoreExact}/${s.total}</div>
                    </div>
                `;
            }).join("")}
        </div>

        <!-- SOUS-MARCHÉS -->
        <div class="submarkets-section">
            <div class="submarket-header">
                <div class="submarket-title">📈 Sous-Marchés : Performance par Tranche de Confiance</div>
                <button class="toggle-btn" onclick="toggleSubmarkets()">
                    <span id="toggleText">Afficher tous les sous-marchés</span>
                </button>
            </div>

            <!-- OVER/UNDER 2.5 (Toujours visible) -->
            <div style="margin-bottom: 30px;">
                <div style="color: #38bdf8; font-weight: bold; font-size: 1.1em; margin-bottom: 15px;">⚽ OVER/UNDER 2.5 Goals</div>
                <div class="submarkets-visible">
                    ${renderSubmarketCards("ou25")}
                </div>
            </div>

            <!-- AUTRES SOUS-MARCHÉS (Masqués par défaut) -->
            <div id="hiddenSubmarkets" class="submarkets-hidden">
                ${SUBMARKETS.filter(s => s.id !== "ou25").map(sm => `
                    <div style="grid-column: 1 / -1; margin: 20px 0 15px 0;">
                        <div style="color: #38bdf8; font-weight: bold; font-size: 1.1em;">${sm.title}</div>
                    </div>
                    ${renderSubmarketCards(sm.id)}
                `).join("")}
            </div>
        </div>

        <!-- PERFORMANCE PAR LIGUE -->
        <h2>🏆 Performance par Ligue</h2>
        <div class="league-grid">
            ${leaguesHtml}
        </div>

        <!-- DÉTAIL DES MATCHS -->
        ${logsHtml}

    </div>

    <script>
        function toggleSubmarkets() {
            const hidden = document.getElementById('hiddenSubmarkets');
            const btn = document.getElementById('toggleText');

            if (hidden.classList.contains('active')) {
                hidden.classList.remove('active');
                btn.textContent = 'Afficher tous les sous-marchés';
            } else {
                hidden.classList.add('active');
                btn.textContent = 'Masquer les sous-marchés';
            }
        }

        function toggleMatchDetails(matchId) {
            const detail = document.getElementById(matchId);
            const row = event.currentTarget;

            // Fermer tous les autres détails
            document.querySelectorAll('.match-details').forEach(d => {
                if (d.id !== matchId) d.classList.remove('active');
            });

            document.querySelectorAll('.match-row').forEach(r => {
                if (r !== row) r.classList.remove('expanded');
            });

            // Toggle le détail actuel
            detail.classList.toggle('active');
            row.classList.toggle('expanded');
        }
    </script>
</body>
</html>`;

    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    }).listen(PORT, () => console.log(`
🌍 Dashboard : http://localhost:${PORT}`));
}

runBacktest();