# Cartographie de l'architecture actuelle

## Structure générale
- Scripts Node et Python répartis dans `scripts/` (ingestion, enrichment, backtest, optimisation, utilitaires) sans module partagé.
- Données brutes et enrichies dans `data/` (history, meta, elo, params, cache_odds, results, debug).
- Dashboards HTML générés à la volée par les scripts (`backtest/backtest_v2.js`, `today_analyzer.js`) via un serveur HTTP maison.
- Dépendances minimales déclarées dans `package.json` (`axios`, `express`, `opn`) et aucune commande de test.

## Rôles des scripts existants
- `scripts/enrichment/enrich_ultra.js` : construction de la base méta (top scorers/assists, squads) + enrichissement des historiques par ligue. Clé API codée en dur, pas de gestion avancée du rate-limit, pas de validation de schéma.
- `scripts/enrichment/enrich-all-history.js` / `update.js` : orchestration ponctuelle de mises à jour d'historiques.
- `scripts/optimization/optimizer_v2.py` : optimisation des paramètres (Optuna) avec pipeline d'entraînement/test walk-forward, mais logique encapsulée dans un script monolithique.
- `scripts/backtest/backtest_v2.js` : backtest + génération dashboard (HTML + serveur HTTP). Le calcul du modèle (Poisson/Dixon-Coles, impact players, calibration Platt) est imbriqué dans le fichier.
- `scripts/today_analyzer.js` : analyse des matchs du jour + odds cache + dashboard, duplique la logique modèle et le mapping des marchés de cotes.
- `scripts/utils/*.py|js` : scripts ponctuels de debug/audit (elo, squads) sans intégration dans un pipeline.

## Sources de données et « source of truth » actuelle
- Elo : `data/elo/elo_history_archive.json` consommé directement par backtest et today analyzer.
- Historique match enrichi : `data/history/history_<league>.json` produit par `enrich_ultra.js` et utilisé par backtest/optimisation.
- Méta joueurs/équipes : `data/meta/league_<league>_meta.json` construit par `enrich_ultra.js`, référencé pour impact players.
- Paramètres optimisés : `data/params/optimized_params.json` produit par `optimizer_v2.py`, chargé par backtest/today analyzer.
- Odds : caches individuels dans `data/cache_odds/fixture_<id>.json` créés depuis `today_analyzer.js`.
- Résultats : `data/results/` stocke les exports de backtest, sans format contractuel.

## Points de fragilité / doublons
- **Couplage fort UI + modèle** : HTML, serveur HTTP et logique statistique sont dans les mêmes fichiers (backtest, today analyzer).
- **Duplication du modèle** : calcul Poisson/DC, impact players, calibration, mapping des sous-marchés recopiés entre backtest et today analyzer, divergences possibles.
- **API / data safety** : clé API codée en dur (`enrich_ultra.js`), pas de normalisation des erreurs, retries ou backoff cohérents.
- **Chronologie** : tri manuel par `Date` sans utilitaire commun, risque d’incohérences par ligue et round.
- **Odds mapping** : logique de correspondance marchés/valeurs dispersée, aucune validation des ranges (ex: cotes aberrantes) ni schéma de cache.
- **Reproductibilité** : pas de configuration centrale ni de seed pour les parties pseudo-aléatoires (Optuna, ordonnancement), pas de tests automatisés.
- **Traçabilité** : pas de logs structurés ni de dumps standardisés (fixtures bruts, mapping odds) en dehors de fichiers debug écrits à la main.
- **Interop JS/Python** : optimisation en Python, backtest en JS sans contrat d’échange clair (params, features), rendant la maintenance difficile.
- **Structure de fichiers** : pas de séparation claire ingestion → features → modèle → calibration → évaluation → UI ; accumulation de « script soup ».

## Gaps fonctionnels vis-à-vis des objectifs
- Absence de CLI unifiée : les commandes sont des scripts isolés à lancer depuis des dossiers spécifiques.
- Pas de validation de schémas (zod ou équivalent) pour sécuriser l’ingestion/cache/params.
- Pas de gestion du rate-limit ni de retries exponentiels partagés pour l’API-Football.
- Pas de calage explicite des timezones dans les pipelines (buffers dates hardcodés dans today analyzer).
- Pas de tests de non-régression (Brier, calibration, ROI) pour sécuriser les évolutions.
