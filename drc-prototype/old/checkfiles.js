const fs = require('fs');

const LEAGUES = [
    { id: 39, name: "Premier League" }, { id: 61, name: "Ligue 1" }, { id: 140, name: "La Liga" },
    { id: 78, name: "Bundesliga" }, { id: 135, name: "Serie A" }, { id: 94, name: "Liga Portugal" },
    { id: 88, name: "Eredivisie" }, { id: 144, name: "Jupiler Pro" }, { id: 179, name: "Premiership" },
    { id: 203, name: "Süper Lig" }, { id: 197, name: "Super League (GRE)" }, { id: 119, name: "Superliga (DAN)" },
    { id: 207, name: "Super League (SUI)" }, { id: 218, name: "Bundesliga (AUT)" }, { id: 40, name: "Championship" },
    { id: 62, name: "Ligue 2" }, { id: 136, name: "Serie B" }, { id: 79, name: "2. Bundesliga" },
    { id: 141, name: "La Liga 2" }, { id: 106, name: "Ekstraklasa" }, { id: 210, name: "HNL" },
    { id: 209, name: "Czech Liga" }, { id: 283, name: "Liga I" }, { id: 253, name: "MLS" },
    { id: 71, name: "Brasileiro A" }, { id: 128, name: "Liga Prof" }, { id: 262, name: "Liga MX" },
    { id: 307, name: "Saudi Pro" }, { id: 98, name: "J1 League" }, { id: 188, name: "A-League" }
];

console.log("🔍 VÉRIFICATION DES 30 FICHIERS JSON...");
console.log("---------------------------------------");

let missing = 0;
let empty = 0;
let ok = 0;

for (const league of LEAGUES) {
    const file = `history_${league.id}.json`;
    
    if (fs.existsSync(file)) {
        try {
            const content = fs.readFileSync(file);
            const data = JSON.parse(content);
            if (Array.isArray(data) && data.length > 0) {
                console.log(`✅ ${league.name.padEnd(20)} : OK (${data.length} matchs)`);
                ok++;
            } else {
                console.log(`⚠️ ${league.name.padEnd(20)} : VIDE (0 match) -> À re-télécharger`);
                empty++;
            }
        } catch (e) {
            console.log(`❌ ${league.name.padEnd(20)} : CORROMPU (Erreur lecture)`);
            empty++;
        }
    } else {
        console.log(`❌ ${league.name.padEnd(20)} : MANQUANT`);
        missing++;
    }
}

console.log("---------------------------------------");
console.log(`BILAN : ${ok} OK | ${empty} Vides/Erreurs | ${missing} Manquants`);

if (missing > 0 || empty > 0) {
    console.log("\n👉 SOLUTION : Relancez l'Étape 1 (1_download.js) pour récupérer les fichiers manquants.");
} else {
    console.log("\n👉 TOUT EST OK : Le problème vient du script d'audit (Étape 2), pas des fichiers.");
}