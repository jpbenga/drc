# Phase 4 — Validation renforcée et flux live

## Ce qui a été livré
- Validation stricte des fixtures et odds via Zod (`src/validation/schemas.js`) utilisée par l'API client, le pipeline et la CLI.
- Tests de non-régression avec baseline métriques et validation de schémas/CLI pour sécuriser les évolutions.
- CLI étendue avec commandes `today` et `last7days`, configuration ligues externalisée (`config/leagues.json`) et support des fixtures locales ou live.

## Comment valider
1. `npm test` : exécute l'ensemble des tests (smoke, validation, backtest, UI, CLI live mock).
2. `npm run today -- --fixtures=tests/fixtures/history_sample.json --sample=3` pour simuler un run live sur un échantillon local.
3. `npm run last7days -- --fixtures=tests/fixtures/history_sample.json --dump=debug/live_dump.json --collect` pour vérifier la génération de dump et la collecte de traces.

## Prochaines étapes (Phase 5)
- Ajouter des modèles de ROI simulé plus détaillés et des hooks de money management.
- Connecter un stockage persistant pour les dumps et rapports (S3/local) avec rotation.
- Intégrer une étape d'évaluation temps réel (live updates) et monitoring des anomalies odds.
