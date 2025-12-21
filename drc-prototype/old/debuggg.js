const fs = require('fs');

// On teste seulement sur la Ligue 1 (ID 61) et Premier League (ID 39) pour voir si ça marche
const LEAGUES_TEST = [
    { id: 61, name: "Ligue 1" },
    { id: 39, name: "Premier League" }
];

function debugCheck() {
    console.log(`\n🔍 DIAGNOSTIC DE VOS DONNÉES`);
    console.log(`=============================`);
    console.log(`📂 Dossier actuel du script : ${process.cwd()}`);
    
    // 1. Vérification de la présence des fichiers
    console.log(`\n--- ÉTAPE 1 : VÉRIFICATION DES FICHIERS ---`);
    let filesFound = 0;
    
    for (const league of LEAGUES_TEST) {
        const fileName = `history_${league.id}.json`;
        
        if (fs.existsSync(fileName)) {
            const stats = fs.statSync(fileName);
            const size = (stats.size / 1024).toFixed(2); // Taille en KB
            
            console.log(`✅ ${fileName} : TROUVÉ (${size} KB)`);
            
            // 2. Vérification du contenu
            try {
                const content = fs.readFileSync(fileName, 'utf8');
                const data = JSON.parse(content);
                
                if (Array.isArray(data) && data.length > 0) {
                    console.log(`   -> Contient ${data.length} matchs.`);
                    console.log(`   -> Premier match : ${data[0].teams.home.name} vs ${data[0].teams.away.name}`);
                    console.log(`   -> Round (Journée) du 1er match : "${data[0].league.round}"`);
                    
                    // Test du parsing de la journée
                    const r = parseInt(data[0].league.round.replace(/[^0-9]/g, '')||0);
                    console.log(`   -> Parsing du Round par l'algo : ${r}`);
                    
                    if (r === 0) console.log(`   ⚠️ ATTENTION: L'algo lit '0' pour la journée. Vérifiez le format.`);
                    
                    filesFound++;
                } else {
                    console.log(`   ❌ LE FICHIER EST VIDE (Tableau vide []).`);
                    console.log(`      -> Cause probable : Vous avez téléchargé la saison 2025 qui n'a pas commencé.`);
                    console.log(`      -> Solution : Changez SEASON = 2024 dans le script de téléchargement.`);
                }
            } catch (e) {
                console.log(`   ❌ FICHIER CORROMPU (Erreur JSON) : ${e.message}`);
            }

        } else {
            console.log(`❌ ${fileName} : NON TROUVÉ.`);
        }
    }

    console.log(`\n--- Bilan ---`);
    if (filesFound === 0) {
        console.log(`🚨 AUCUNE DONNÉE EXPLOITABLE.`);
        console.log(`Le script d'audit (Etape 2) ne peut rien calculer car il ne trouve pas les matchs.`);
    } else {
        console.log(`✅ Les données semblent correctes. Le problème vient peut-être du seuil 'r > 6' dans l'audit.`);
    }
}

debugCheck();