import optuna
import numpy as np
import json
import os
from datetime import datetime
from scipy.stats import poisson

# Configuration complète des 9 ligues identifiées dans ton projet
LEAGUES = [39, 61, 78, 140, 135, 94, 88, 197, 203]
DATA_DIR = "./"

def tau(x, y, lh, la, rho):
    """ Ajustement Dixon-Coles pour les scores faibles """
    if lh == 0 or la == 0: return 1
    if x == 0 and y == 0: return 1 - (lh * la * rho)
    if x == 0 and y == 1: return 1 + (la * rho)
    if x == 1 and y == 0: return 1 + (lh * rho)
    if x == 1 and y == 1: return 1 - rho
    return 1

def load_all_matches():
    all_matches = []
    for lid in LEAGUES:
        filename = os.path.join(DATA_DIR, f"ultimate_{lid}.json")
        if os.path.exists(filename):
            with open(filename, 'r') as file:
                data = json.load(file)
                all_matches.extend(data)
    # Tri chronologique pour la validité du Time-Decay
    all_matches.sort(key=lambda x: x['info']['date'])
    return all_matches

def predict_match_probas(match, w_xg, w_rank, rho, phi, current_date):
    # Calcul du Time Decay (Poids temporel)
    m_date = datetime.strptime(match['info']['date'], '%Y-%m-%d')
    days_diff = (current_date - m_date).days
    decay = np.exp(-phi * days_diff)

    # Calcul des Lambdas (Espérance de buts)
    lh = max(((match['stats']['xg_home'] * 0.6 + match['stats']['ga_away'] * 0.4) * w_xg + (1/match['rank']['home'] * w_rank)) * decay, 0.01)
    la = max(((match['stats']['xg_away'] * 0.6 + match['stats']['ga_home'] * 0.4) * w_xg + (1/match['rank']['away'] * w_rank)) * decay, 0.01)

    p_h, p_d, p_a = 0, 0, 0
    for i in range(10): # Jusqu'à 9 buts
        for j in range(10):
            prob = (poisson.pmf(i, lh) * poisson.pmf(j, la)) * tau(i, j, lh, la, rho)
            if i > j: p_h += prob
            elif i == j: p_d += prob
            else: p_a += prob
            
    return p_h, p_d, p_a

def objective(trial):
    # Suggestions d'hyperparamètres
    w_xg = trial.suggest_float("w_xg", 0.1, 2.0)
    w_rank = trial.suggest_float("w_rank", 0.0, 1.0)
    rho = trial.suggest_float("rho", -0.1, 0.1)
    phi = trial.suggest_float("phi", 0.0001, 0.01)
    
    matches = load_all_matches()
    if not matches: return 1.0
    
    current_date = datetime.now()
    log_losses = []

    for m in matches:
        p_h, p_d, p_a = predict_match_probas(m, w_xg, w_rank, rho, phi, current_date)
        
        # Logique Double Chance (On optimise sur le fait que le favori ne perde pas)
        if (p_h + p_d) >= (p_a + p_d):
            p_pred = np.clip(p_h + p_d, 0.01, 0.99)
            actual = 1 if m['score']['home'] >= m['score']['away'] else 0
        else:
            p_pred = np.clip(p_a + p_d, 0.01, 0.99)
            actual = 1 if m['score']['away'] >= m['score']['home'] else 0
        
        # Calcul du Log-Loss
        loss = -(actual * np.log(p_pred) + (1 - actual) * np.log(1 - p_pred))
        log_losses.append(loss)
            
    return np.mean(log_losses)

if __name__ == "__main__":
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=100)
    print("--- MEILLEURS PARAMÈTRES ---")
    print(study.best_params)