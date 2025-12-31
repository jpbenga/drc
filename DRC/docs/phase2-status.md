# Phase 2 — data layer et mapping odds

## Ce qui a été livré
- Client API unifié (`src/data/apiClient.js`) avec rate-limit, retries/backoff et validation optionnelle.
- Cache JSON simple (`src/data/cache.js`) réutilisable pour fixtures/meta/odds.
- Mapping centralisé des marchés odds sensibles (OU 2.5/3.5, BTTS, Away >0.5, double chance) avec détection d'anomalies de pricing.
- Validations runtime légères (`src/validation`) pour fixtues/meta/odds en attendant zod/superstruct.
- Logger structuré + dumps debug (`src/logging`) et premiers composants UI stateless.
- Backtest headless pipeline (`src/pipeline/backtest.js`) et CLI (`src/cli/backtest.js`) branchés sur le cœur modèle.

## Comment valider
1. `npm install` si besoin.
2. `npm test` exécute le smoke modèle + tests client API, mapping odds et pipeline headless.
3. `npm run backtest -- --fixtures=tests/fixtures/history_sample.json` pour un run CLI de démonstration (dump optionnel via `--dump=debug/backtest_phase2.json`).

## Prochaines étapes (Phase 3 → 4)
- Étendre le client API aux endpoints réels (API-Football, ClubElo) avec quotas et cache disque.
- Généraliser les dumps debug par type de pipeline (ingestion/features/odds) et brancher les dashboards HTML sur des composants UI partagés.
- Normaliser les schémas via une lib dédiée (zod/superstruct) et ajouter des tests de non-régression (snapshots métriques, ROI) sur des échantillons représentatifs.
