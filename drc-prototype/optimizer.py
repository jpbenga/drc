import optuna
import json
import math
import os

LEAGUES = [39, 61, 78, 140, 135, 94, 88, 197, 203]

def poisson_prob(k, lamb):
    if lamb <= 0: return 1.0 if k == 0 else 0.0
    try:
        return (math.exp(-lamb) * (lamb**k)) / math.factorial(k)
    except OverflowError: return 0.0

def get_1n2_probs(lH, lA):
    pH, pD, pA = 0, 0, 0
    for h in range(7): 
        for a in range(7):
            p_score = poisson_prob(h, lH) * poisson_prob(a, lA)
            if h > a: pH += p_score
            elif h < a: pA += p_score
            else: pD += p_score
    return pH, pD, pA

def objective(trial):
    # --- ESPACE DE RECHERCHE ---
    # Optuna va chercher les meilleures valeurs dans ces plages
    w_xg = trial.suggest_float("w_xg", 0.1, 2.0)
    w_rank = trial.suggest_float("w_rank", 0.0, 1.0)
    window = trial.suggest_int("window", 4, 8)
    
    hits, total = 0, 0

    for league_id in LEAGUES:
        path = f"history_{league_id}.json"
        if not os.path.exists(path): continue
        with open(path, 'r') as f:
            data = json.load(f)
        
        data.sort(key=lambda x: x['fixture']['date'])
        tracker = {}

        for m in data:
            h_id, a_id = m['teams']['home']['id'], m['teams']['away']['id']
            if h_id not in tracker: tracker[h_id] = []
            if a_id not in tracker: tracker[a_id] = []
            
            if len(tracker[h_id]) >= window and len(tracker[a_id]) >= window:
                avg_h = sum(tracker[h_id][-window:]) / window
                avg_a = sum(tracker[a_id][-window:]) / window
                
                # Formule Lambda sans données en dur
                lh = (avg_h * w_xg) + (w_rank * 0.2)
                la = (avg_a * w_xg)
                
                ph, pd, pa = get_1n2_probs(lh, la)
                
                # On optimise la précision sur les signaux forts (>65%)
                if ph > 0.65 or pa > 0.65:
                    total += 1
                    actual = 'H' if m['goals']['home'] > m['goals']['away'] else ('A' if m['goals']['away'] > m['goals']['home'] else 'D')
                    pred = 'H' if ph > pa else 'A'
                    if pred == actual: hits += 1

            if 'stats' in m and m['stats']:
                tracker[h_id].append(float(m['stats']['home']['expected_goals'] or 0))
                tracker[a_id].append(float(m['stats']['away']['expected_goals'] or 0))

    return hits / total if total > 0 else 0

study = optuna.create_study(direction="maximize")
study.optimize(objective, n_trials=50) # On commence par 50 essais pour voir la tendance

print("\n🏆 PARAMÈTRES TROUVÉS :")
print(json.dumps(study.best_params, indent=4))
print(f"📈 Précision : {study.best_value:.2%}")