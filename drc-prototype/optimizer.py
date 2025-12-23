import optuna
import numpy as np
import json
import os
from datetime import datetime
from scipy.stats import poisson
from collections import defaultdict

# Configuration complète des 9 ligues
LEAGUES = [39, 61, 78, 140, 135, 94, 88, 197, 203]
DATA_DIR = "./"

def tau(x, y, lh, la, rho):
    """ Correction Dixon-Coles : Ajuste la probabilité des nuls """
    if lh == 0 or la == 0: return 1
    if x == 0 and y == 0: return 1 - (lh * la * rho)
    if x == 0 and y == 1: return 1 + (la * rho)
    if x == 1 and y == 0: return 1 + (lh * rho)
    if x == 1 and y == 1: return 1 - rho
    return 1

def load_all_matches():
    """ Charge et filtre les matchs terminés avec xG depuis history_*.json """
    all_matches = []
    for lid in LEAGUES:
        filename = os.path.join(DATA_DIR, f"history_{lid}.json")
        if not os.path.exists(filename): continue
        with open(filename, 'r') as file:
            data = json.load(file)
            for m in data:
                # On ne garde que les matchs finis ayant des stats xG
                if (m.get('fixture', {}).get('status', {}).get('short') == 'FT' and 
                    m.get('stats') and m['stats'].get('home')):
                    all_matches.append(m)
    all_matches.sort(key=lambda x: x['fixture']['date'])
    return all_matches

def compute_simulated_stats(matches, window):
    """ Simule la saison pour calculer l'état de forme avant chaque match """
    tracker = defaultdict(lambda: {'xg': [], 'ga': []})
    standings = defaultdict(lambda: {'pts': 0})
    match_data_for_opti = []

    for m in matches:
        h_id = m['teams']['home']['id']
        a_id = m['teams']['away']['id']
        
        # On ne commence à prédire qu'après avoir assez d'historique (window)
        if len(tracker[h_id]['xg']) >= window and len(tracker[a_id]['xg']) >= window:
            # On calcule les moyennes glissantes (Force offensive / Faiblesse défensive)
            xg_h = np.mean(tracker[h_id]['xg'][-window:])
            ga_h = np.mean(tracker[h_id]['ga'][-window:])
            xg_a = np.mean(tracker[a_id]['xg'][-window:])
            ga_a = np.mean(tracker[a_id]['ga'][-window:])

            # Calcul du rang au moment du match
            sorted_teams = sorted(standings.items(), key=lambda x: x[1]['pts'], reverse=True)
            r_h = next((i+1 for i, (tid, _) in enumerate(sorted_teams) if tid == h_id), 10)
            r_a = next((i+1 for i, (tid, _) in enumerate(sorted_teams) if tid == a_id), 10)

            match_data_for_opti.append({
                'date': m['fixture']['date'][:10],
                'xg_h': xg_h, 'ga_h': ga_h, 'xg_a': xg_a, 'ga_a': ga_a,
                'rank_h': r_h, 'rank_a': r_a,
                'res_h': m['goals']['home'], 'res_a': m['goals']['away']
            })

        # Mise à jour de l'historique APRES le match (pour le prochain)
        tracker[h_id]['xg'].append(float(m['stats']['home'].get('expected_goals', 0) or 0))
        tracker[h_id]['ga'].append(m['goals']['away'])
        tracker[a_id]['xg'].append(float(m['stats']['away'].get('expected_goals', 0) or 0))
        tracker[a_id]['ga'].append(m['goals']['home'])
        standings[h_id]['pts'] += 3 if m['goals']['home'] > m['goals']['away'] else (1 if m['goals']['home'] == m['goals']['away'] else 0)
        standings[a_id]['pts'] += 3 if m['goals']['away'] > m['goals']['home'] else (1 if m['goals']['home'] == m['goals']['away'] else 0)

    return match_data_for_opti

def objective(trial):
    w_xg = trial.suggest_float("w_xg", 0.1, 2.0)
    w_rank = trial.suggest_float("w_rank", 0.0, 0.5)
    rho = trial.suggest_float("rho", -0.1, 0.1)
    phi = trial.suggest_float("phi", 0.0001, 0.01)
    window = trial.suggest_int("window", 4, 10)

    matches = load_all_matches()
    match_stats = compute_simulated_stats(matches, window)
    if not match_stats: return 1.0

    current_date = datetime.now()
    log_losses = []

    for ms in match_stats:
        m_date = datetime.strptime(ms['date'], '%Y-%m-%d')
        decay = np.exp(-phi * (current_date - m_date).days)

        # Calcul Lambda (Même logique que backtest.js)
        lh = max(((ms['xg_h'] * 0.6 + ms['ga_a'] * 0.4) * w_xg + (1/ms['rank_h'] * w_rank)) * decay, 0.01)
        la = max(((ms['xg_a'] * 0.6 + ms['ga_h'] * 0.4) * w_xg + (1/ms['rank_a'] * w_rank)) * decay, 0.01)

        p_h, p_d, p_a = 0, 0, 0
        for i in range(9):
            for j in range(9):
                p = (poisson.pmf(i, lh) * poisson.pmf(j, la)) * tau(i, j, lh, la, rho)
                if i > j: p_h += p
                elif i == j: p_d += p
                else: p_a += p

        # Optimisation sur la Double Chance la plus probable
        if (p_h + p_d) >= (p_a + p_d):
            p_pred, actual = np.clip(p_h + p_d, 0.01, 0.99), (1 if ms['res_h'] >= ms['res_a'] else 0)
        else:
            p_pred, actual = np.clip(p_a + p_d, 0.01, 0.99), (1 if ms['res_a'] >= ms['res_h'] else 0)
        
        log_losses.append(-(actual * np.log(p_pred) + (1 - actual) * np.log(1 - p_pred)))

    return np.mean(log_losses)

if __name__ == "__main__":
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=100)
    print("\n--- PARAMÈTRES OPTIMAUX ---")
    print(study.best_params)