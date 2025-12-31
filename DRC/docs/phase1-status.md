# Phase 1 — état et vérifications

## Ce qui a été livré
- Extraction d'un module `src/core` qui regroupe le modèle Poisson/Dixon-Coles (shrinkage bayésien, impact players) et la calibration Platt.
- Le backtest (`scripts/backtest/backtest_v2.js`) consomme désormais ces fonctions centralisées via le barrel `src/core/index.js`.
- Ajout d'un test fumigène déterministe (`npm test` / `tests/smoke_backtest.js`) qui verrouille le score-matrix, les probabilités dérivées et la mise à jour du calibrateur.

## Comment valider
1. Installer les dépendances Node (si nécessaire) : `npm install`.
2. Lancer le smoke test : `npm test`. Il doit afficher `✅ smoke_backtest passed`.

## Prochaines étapes (Phase 2)
- Factoriser un client API robuste (API-Football + ClubElo) avec retry/backoff et validation de schéma.
- Centraliser le mapping des marchés (OU 2.5/3.5, BTTS, TT Away >0.5, double chance) avec contrôles d'incohérences.
- Poser la couche cache/validation partagée pour fixtures/odds/meta.
