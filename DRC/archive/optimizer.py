import json
import numpy as np
import optuna
from scipy.stats import poisson
import os
from datetime import datetime

# --- 1. CONFIGURATION ET CHARGEMENT ---
LEAGUES = ['39', '61', '78', '140', '135', '94', '88', '197', '203']

def load_all_matches():
    all_matches = []
    for lid in LEAGUES:
        file_path = f'history_{lid}.json'
        if os.path.exists(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for m in data:
                    # FILTRE CRUCIAL : On ne prend que les matchs terminés avec un score
                    status = m.get('fixture', {}).get('status', {}).get('short')
                    goals_h = m.get('goals', {}).get('home')
                    
                    if status == 'FT' and goals_h is not None:
                        m['league_id_str'] = str(lid)
                        all_matches.extend([m])
    return all_matches

# Chargement de l'archive Elo
if not os.path.exists('elo_history_archive.json'):
    raise FileNotFoundError("L'archive Elo est manquante.")

with open('elo_history_archive.json', 'r', encoding='utf-8') as f:
    ELO_ARCHIVE = json.load(f)

MATCHES = load_all_matches()

# Split Chronologique
if len(MATCHES) < 100:
    TRAIN_MATCHES = MATCHES
    TEST_MATCHES = []
    USE_VALIDATION = False
else:
    # On trie par date pour ne pas tester sur le passé avec des données du futur
    MATCHES.sort(key=lambda x: x['fixture']['date'])
    split_idx = int(len(MATCHES) * 0.8)
    TRAIN_MATCHES = MATCHES[:split_idx]
    TEST_MATCHES = MATCHES[split_idx:]
    USE_VALIDATION = True

print(f"✅ Base chargée : {len(MATCHES)} matchs joués identifiés.")
if USE_VALIDATION:
    print(f"   📊 Train : {len(TRAIN_MATCHES)} | 🧪 Test : {len(TEST_MATCHES)}")

# --- 2. FONCTIONS MATHÉMATIQUES ---

def clubelo_win_probability(delta_elo):
    return 1 / (10**(-delta_elo / 400) + 1)

def dixon_coles_adjustment(goals_h, goals_a, lambda_h, lambda_a, rho):
    if rho == 0: return 1.0
    if goals_h == 0 and goals_a == 0: return 1 - (lambda_h * lambda_a * rho)
    if goals_h == 0 and goals_a == 1: return 1 + (lambda_h * rho)
    if goals_h == 1 and goals_a == 0: return 1 + (lambda_a * rho)
    if goals_h == 1 and goals_a == 1: return 1 - rho
    return 1.0

def compute_lambdas(xg_h, xg_a, delta_elo, w_xg, w_elo, hfa):
    delta_elo_adjusted = delta_elo + hfa
    prob_win_h = clubelo_win_probability(delta_elo_adjusted)
    prob_win_a = 1 - prob_win_h
    
    # Formule de puissance Elo
    lambda_h = xg_h * w_xg * ((prob_win_h / 0.5) ** w_elo)
    lambda_a = xg_a * w_xg * ((prob_win_a / 0.5) ** w_elo)
    
    return max(lambda_h, 0.01), max(lambda_a, 0.01)

def evaluate_model(matches, params, mode="Training"):
    w_xg, w_elo, rho, hfa = params['w_xg'], params['w_elo'], params['rho'], params['hfa']
    total_log_loss = 0
    count = 0
    errors = {"no_elo": 0, "no_xg": 0}

    for m in matches:
        lid = m['league_id_str']
        round_name = m['league']['round']
        h_name = m['teams']['home']['name']
        a_name = m['teams']['away']['name']
        
        # 1. Check Elo
        h_elo = ELO_ARCHIVE.get(lid, {}).get(round_name, {}).get(h_name)
        a_elo = ELO_ARCHIVE.get(lid, {}).get(round_name, {}).get(a_name)
        
        if h_elo is None or a_elo is None:
            errors["no_elo"] += 1
            continue

        # 2. Check xG
        xg_h = m.get('stats', {}).get('home', {}).get('avg_xg')
        xg_a = m.get('stats', {}).get('away', {}).get('avg_xg')
        if xg_h is None or xg_a is None:
            errors["no_xg"] += 1
            continue

        # 3. Calcul
        lh, la = compute_lambdas(xg_h, xg_a, h_elo - a_elo, w_xg, w_elo, hfa)
        
        prob_h, prob_d, prob_a = 0, 0, 0
        for i in range(8):
            for j in range(8):
                p = poisson.pmf(i, lh) * poisson.pmf(j, la) * dixon_coles_adjustment(i, j, lh, la, rho)
                if i > j: prob_h += p
                elif i == j: prob_d += p
                else: prob_a += p

        # Log-Loss sur le résultat réel
        actual_h, actual_a = m['goals']['home'], m['goals']['away']
        res_prob = prob_h if actual_h > actual_a else (prob_d if actual_h == actual_a else prob_a)
        
        total_log_loss -= np.log(max(res_prob, 1e-10))
        count += 1

    if count == 0: return 1e10
    
    avg_loss = total_log_loss / count
    if mode == "Test":
        print(f"   🔎 Rapport d'erreurs Test : Elo manquants={errors['no_elo']}, xG manquants={errors['no_xg']}")
    return avg_loss

def objective(trial):
    p = {
        'w_xg': trial.suggest_float('w_xg', 0.5, 2.0),
        'w_elo': trial.suggest_float('w_elo', 0.1, 2.0),
        'rho': trial.suggest_float('rho', -0.1, 0.2),
        'hfa': trial.suggest_float('hfa', 20, 120)
    }
    return evaluate_model(TRAIN_MATCHES, p)

# --- 3. OPTIMISATION ---
study = optuna.create_study(direction='minimize')
study.optimize(objective, n_trials=100)

# --- 4. RÉSULTATS ---
print(f"\n🏆 MEILLEURS PARAMÈTRES : {study.best_params}")
if USE_VALIDATION:
    print("\n🧪 ÉVALUATION SUR TEST SET :")
    evaluate_model(TEST_MATCHES, study.best_params, mode="Test")