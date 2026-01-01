# Phase 3 — CLI unifiée et génération UI

## Ce qui a été livré
- CLI centralisée (`src/cli/index.js`) enveloppant le backtest et un outil d'enrichissement odds.
- Rapport HTML statique pour le backtest via des composants UI stateless (`src/ui/layout.js`, `src/ui/backtestDashboard.js`).
- Dumps debug standardisés avec manifest (`createDumpWriter`) et collecte optionnelle des traces match.
- Script npm dédiés (`npm run cli`, `npm run enrich`) et tests unitaires supplémentaires pour les dumps et le rendu UI.

## Comment valider
1. `npm test` : exécute le smoke backtest, les tests API client/mapping/pipeline et les nouveaux tests UI/dumps.
2. `npm run backtest -- --html=debug/report.html --dump=debug/backtest_dump.json --collect=true` pour produire un rapport statique + dump manifesté.
3. `npm run enrich -- --fixtures=tests/fixtures/history_sample.json --dump=debug/dumps` pour générer les contrôles de mapping odds et consulter le manifest.

## Prochaines étapes (Phase 4)
- Renforcer la validation de schémas (zod/superstruct) sur tous les flux d'ingestion/odds/features.
- Ajouter des tests de non-régression (snapshots métriques, ROI simulé) et automatiser la comparaison vs baseline.
- Étendre la CLI à `today`/`last7days` avec ingestion live (API-Football + ClubElo) et config ligues externalisée.
