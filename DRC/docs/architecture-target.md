# Architecture cible & plan de migration

## Principes
- Séparation nette ingestion → stockage/cache → features → modèle → calibration → évaluation → reporting/UI.
- Modules réutilisables (JS/TS) pour le modèle, la calibration et le mapping odds ; clients API résilients avec retries/backoff.
- Données déterministes : caches versionnés, schémas validés, seeds explicites pour optimisation.
- Observabilité : logs structurés, dumps debug standardisés (fixtures bruts, odds, mapping, features).
- Compatibilité progressive : CommonJS maintenu, ouverture vers TS via validation runtime (zod/superstruct) sans big bang.

## Arborescence proposée
```
src/
  core/              # Modèle, calibration, utilities stats (Poisson/DC, impact players, Platt)
  data/              # Clients API + adapters + schémas (API-Football, ClubElo) + cache layer
  features/          # Construction features match/équipe, normalisation chronologique, enrichissements
  pipeline/          # Orchestration ingestion → features → prédiction → calibration → évaluation
  cli/               # Commandes harmonisées (fetch, enrich, backtest, today, last7days, optimize)
  apps/
    backtest/        # Services/dashboards backtest (UI séparée du modèle)
    daily/           # Analyzer jour + odds mapping + UI
  ui/                # Composants HTML/JS partagés (cartes ligues, tableaux métriques, charts)
  config/            # Fichiers YAML/JSON (ligues, mapping bookmakers, paramètres par défaut)
  logging/           # Logger structuré + hooks dump debug
  validation/        # Schémas (zod/superstruct) pour data, odds, params

scripts/             # Alias CLI vers `node ./src/cli/*.js`
tests/               # Smoke tests (pipeline mini), snapshot métriques, tests mapping odds
```

## Interfaces & contrats
- **Client API** : `fetchFixtures({league, season, from, to, tz})`, `fetchOdds(fixtureId, markets)` avec retries/backoff et contrôles de quota.
- **Cache** : interface clé/valeur (`getCached`, `setCached`, TTL, validation schema) pour odds/fixtures/history.
- **Features** : `buildTeamTracker(history, params)` ; `extractImpactSignals(match, meta)` ; sortie normalisée pour le modèle.
- **Modèle** : `computeScoreMatrix({params, tracker, match, elo, meta})` → `{probs, debug}` ; `computeSubmarkets(matrix)` ; `calibrate(submarketId, probs, outcome)`.
- **Evaluation** : `runBacktest({leagues, params, calibrators})` générant métriques + traces par match.
- **UI** : composants stateless recevant un JSON normalisé (`matches`, `leagues`, `metrics`) pour éviter le couplage HTML/modèle.

## Pipeline cible
1. **Ingestion** : clients API robustes (rate-limit, retries, logs) → cache brut versionné.
2. **Normalisation/Validation** : schémas runtime pour fixtures, stats, odds ; nettoyage timezone/date ; mapping marchés centralisé.
3. **Features** : trackers chronologiques (xG, GA, elo), impact players (absences, ratings), dérivées météo/forme.
4. **Prédiction** : modèle Poisson/DC + shrinkage + impact players, piloté par un module unique.
5. **Calibration** : walk-forward par sous-marché (Platt/isotonic) avec snapshots et versioning.
6. **Évaluation** : métriques (Brier, NLL score exact, ROI simulé), buckets de confiance, comparaison vs baseline.
7. **Reporting/UI** : dashboards basés sur JSON normalisé ; export HTML/CSV ; hooks dumps debug ; persistance des dumps (local/S3) avec rotation.

## Plan de migration (5 phases)
1. **Phase 1 (cette PR)** : extraire un module `core` pour le modèle (Poisson/DC + impact players + calibration) et brancher le backtest dessus. Ajouter un smoke test déterministe.
2. **Phase 2** : créer un client API unifié avec cache/validation (fixtures, odds, meta) + gestion rate-limit/backoff. Centraliser le mapping des marchés (OU2.5/3.5, BTTS, TT Away >0.5, double chance) et les contrôles d’incohérences.
3. **Phase 3** : isoler la génération UI (composants) et introduire une CLI (`src/cli`) enveloppant backtest/today/enrich. Ajouter des dumps debug standardisés et des logs structurés.
4. **Phase 4** : formaliser la validation de schémas (zod/superstruct), ajouter des tests de non-régression (snapshot métriques, comparaison Brier/ROI), et aligner optimiser/backtest sur un contrat de paramètres commun. Préparer une migration progressive vers TS si souhaité.
5. **Phase 5** : simulations ROI (flat/Kelly), hooks money management, stockage persistant des dumps/rapports (rotation), et monitoring des anomalies odds en temps réel.
