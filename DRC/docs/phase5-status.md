# Phase 5 — ROI simulée et persistance des dumps

## Ce qui a été livré
- Ajout d'un tracker ROI configurable (flat ou Kelly) exposé dans le pipeline backtest et les CLI pour suivre bankroll, nombre de bets et ROI.
- Connexion de l'odds mapping aux paris simulés (double chance, O/U 2.5, BTTS, Away >0.5) avec calcul d'edge et logiques de stake sécurisées.
- Rotation des dumps avec manifest maintenu et persistance locale optionnelle (archives) pour préparer un stockage durable.

## Comment valider
1. `npm test` : couvre le tracker ROI, la rotation des dumps et le backtest enrichi.
2. `npm run backtest -- --fixtures=tests/fixtures/history_sample.json --collect` : vérifie que le résumé contient le bloc `roi` et que la bankroll est mise à jour.
3. `npm run today -- --fixtures=tests/fixtures/history_sample.json --sample=3 --dump=debug/live_dump.json` : observe les dumps tournants et le résumé ROI en sortie CLI.

## Prochaines étapes
- Brancher un stockage distant (S3/MinIO) via l'interface de persistance et ajouter une stratégie de rotation par taille/âge.
- Étendre le simulateur ROI avec gestion du money management (stop-loss, unit sizing progressif) et reporting par marché.
- Ajouter un monitoring temps-réel des anomalies odds (implied prob, swings) avec alerting léger.
