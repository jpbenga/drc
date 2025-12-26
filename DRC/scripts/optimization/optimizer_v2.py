import json
import numpy as np
import optuna
from scipy.stats import poisson
import os
from datetime import datetime

# ============================================================================
# CONFIGURATION - CHEMINS RÉORGANISÉS
# ============================================================================

LEAGUES = ['39', '61', '78', '140', '135', '94', '88', '203']  # 197 retiré (pas de stats)
CONFIDENCE_SHRINKAGE = 15

# Chemins des fichiers
PATHS = {
    'elo': './data/elo/elo_history_archive.json',
    'history': lambda lid: f'./data/history/history_{lid}.json',
    'meta': lambda lid: f'./data/meta/league_{lid}_meta.json',
    'params_output': './data/params/optimized_params.json'
}

def load_all_matches():
    """Charge tous les matchs terminés avec enrichissement"""
    all_matches = []
    for lid in LEAGUES:
        file_path = PATHS['history'](lid)
        if os.path.exists(file_path):
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for m in data:
                    status = m.get('fixture', {}).get('status', {}).get('short')
                    goals_h = m.get('goals', {}).get('home')
                    
                    if status == 'FT' and goals_h is not None:
                        m['league_id_str'] = str(lid)
                        all_matches.append(m)
        else:
            print(f"⚠️  Fichier {file_path} introuvable, skip.")
    return all_matches

def load_meta_data():
    """Charge les meta-données (Top Players) pour toutes les ligues"""
    meta = {}
    for lid in LEAGUES:
        meta_path = PATHS['meta'](lid)
        if os.path.exists(meta_path):
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta[lid] = json.load(f)
        else:
            print(f"⚠️  Meta manquante pour ligue {lid}")
    return meta

# Vérifications
if not os.path.exists(PATHS['elo']):
    raise FileNotFoundError(f"❌ L'archive Elo est manquante : {PATHS['elo']}")

# Créer le dossier params si inexistant
os.makedirs('./data/params', exist_ok=True)

with open(PATHS['elo'], 'r', encoding='utf-8') as f:
    ELO_ARCHIVE = json.load(f)

MATCHES = load_all_matches()
META = load_meta_data()

# Split chronologique 80/20
if len(MATCHES) < 100:
    TRAIN_MATCHES = MATCHES
    TEST_MATCHES = []
    USE_VALIDATION = False
else:
    MATCHES.sort(key=lambda x: x['fixture']['date'])
    split_idx = int(len(MATCHES) * 0.8)
    TRAIN_MATCHES = MATCHES[:split_idx]
    TEST_MATCHES = MATCHES[split_idx:]
    USE_VALIDATION = True

print(f"\n{'='*60}")
print(f"📊 BASE DE DONNÉES CHARGÉE")
print(f"{'='*60}")
print(f"Total Matchs    : {len(MATCHES)}")
if USE_VALIDATION:
    print(f"Train Set       : {len(TRAIN_MATCHES)}")
    print(f"Test Set        : {len(TEST_MATCHES)}")
print(f"Ligues avec Meta: {len(META)}")
print(f"{'='*60}\n")

# ============================================================================
# FONCTIONS MATHÉMATIQUES
# ============================================================================

def clubelo_win_probability(delta_elo):
    """Probabilité de victoire selon Club Elo"""
    return 1 / (10**(-delta_elo / 400) + 1)

def bayesian_shrinkage(team_stats, league_avg, confidence=CONFIDENCE_SHRINKAGE):
    """
    Shrinkage Bayésien : mélange moyenne ligue et équipe
    Plus l'équipe joue, plus sa vraie valeur émerge
    """
    n = len(team_stats)
    if n == 0:
        return league_avg
    
    team_mean = np.mean(team_stats)
    return (confidence * league_avg + n * team_mean) / (confidence + n)

def dixon_coles_adjustment(goals_h, goals_a, lambda_h, lambda_a, rho):
    """Correction Dixon-Coles pour les scores faibles"""
    if rho == 0:
        return 1.0
    if goals_h == 0 and goals_a == 0:
        return 1 - (lambda_h * lambda_a * rho)
    if goals_h == 0 and goals_a == 1:
        return 1 + (lambda_h * rho)
    if goals_h == 1 and goals_a == 0:
        return 1 + (lambda_a * rho)
    if goals_h == 1 and goals_a == 1:
        return 1 - rho
    return 1.0

def detect_impact_absences(match, meta, side):
    """
    Détecte les absences de joueurs clés
    Retourne : (impact_offensif, impact_défensif)
    """
    if not match.get('context') or not meta:
        return 0, 0
    
    lid = match['league_id_str']
    injuries = match['context'].get(f'injuries_{side}', [])
    
    offensive_impact = 0
    defensive_impact = 0
    
    for inj in injuries:
        if inj.get('type') != 'Missing Fixture':
            continue
        
        player_id = inj.get('player_id')
        
        # Check Top Scorers
        top_scorers = meta.get(lid, {}).get('top_scorers', [])
        if any(p['id'] == player_id for p in top_scorers):
            offensive_impact += 1
        
        # Check Top Assists
        top_assists = meta.get(lid, {}).get('top_assists', [])
        if any(p['id'] == player_id for p in top_assists):
            offensive_impact += 0.5
        
        # Check Défenseurs clés (via ratings)
        ratings_key = f'player_ratings_{side}'
        player_ratings = match['context'].get(ratings_key, [])
        player_data = next((p for p in player_ratings if p['id'] == player_id), None)
        
        if player_data:
            position = player_data.get('position', '')
            rating = player_data.get('rating', 0)
            
            if position in ['Defender', 'Goalkeeper'] and rating > 7.0:
                defensive_impact += 1
    
    return offensive_impact, defensive_impact

def compute_lambdas_with_impact(match, xg_h, xg_a, delta_elo, params):
    """
    Calcul des lambdas avec ajustement Impact Players
    """
    w_xg = params['w_xg']
    w_elo = params['w_elo']
    hfa = params['hfa']
    impact_off = params['impact_offensive']
    impact_def = params['impact_defensive']
    
    # Probabilités Elo
    delta_elo_adjusted = delta_elo + hfa
    prob_win_h = clubelo_win_probability(delta_elo_adjusted)
    prob_win_a = 1 - prob_win_h
    
    # Lambda de base
    lambda_h = xg_h * w_xg * ((prob_win_h / 0.5) ** w_elo)
    lambda_a = xg_a * w_xg * ((prob_win_a / 0.5) ** w_elo)
    
    # Ajustement Impact Players
    lid = match['league_id_str']
    meta_data = META.get(lid)
    
    if meta_data:
        impact_h_off, impact_h_def = detect_impact_absences(match, {lid: meta_data}, 'home')
        impact_a_off, impact_a_def = detect_impact_absences(match, {lid: meta_data}, 'away')
        
        # Home perd des attaquants
        if impact_h_off > 0:
            lambda_h *= (1 - impact_off * impact_h_off)
        
        # Away perd des défenseurs (aide Home)
        if impact_a_def > 0:
            lambda_h *= (1 + impact_def * impact_a_def)
        
        # Away perd des attaquants
        if impact_a_off > 0:
            lambda_a *= (1 - impact_off * impact_a_off)
        
        # Home perd des défenseurs (aide Away)
        if impact_h_def > 0:
            lambda_a *= (1 + impact_def * impact_h_def)
    
    return max(lambda_h, 0.01), max(lambda_a, 0.01)

def evaluate_model_brier(matches, params, mode="Training"):
    """
    Évalue le modèle avec le Brier Score
    Pénalise plus fortement les fausses certitudes que le Log-Loss
    """
    w_xg = params['w_xg']
    w_elo = params['w_elo']
    rho = params['rho']
    min_matches = params['min_matches']
    
    total_brier = 0
    count = 0
    errors = {"no_elo": 0, "no_xg": 0, "insufficient_data": 0}
    
    # Tracker par équipe
    tracker = {}
    
    for m in matches:
        lid = m['league_id_str']
        round_name = m['league']['round']
        h_id = m['teams']['home']['id']
        a_id = m['teams']['away']['id']
        h_name = m['teams']['home']['name']
        a_name = m['teams']['away']['name']
        
        # Initialiser tracker
        if h_id not in tracker:
            tracker[h_id] = {'xg': [], 'ga': []}
        if a_id not in tracker:
            tracker[a_id] = {'xg': [], 'ga': []}
        
        # Vérifier données minimales
        if len(tracker[h_id]['xg']) < min_matches or len(tracker[a_id]['xg']) < min_matches:
            if m.get('stats', {}).get('home') and m['goals']['home'] is not None:
                xg_home = m['stats']['home'].get('expected_goals')
                xg_away = m['stats']['away'].get('expected_goals')
                
                if xg_home is not None and xg_away is not None:
                    tracker[h_id]['xg'].append(float(xg_home))
                    tracker[h_id]['ga'].append(m['goals']['away'])
                    tracker[a_id]['xg'].append(float(xg_away))
                    tracker[a_id]['ga'].append(m['goals']['home'])
            errors["insufficient_data"] += 1
            continue
        
        # Check Elo
        h_elo = ELO_ARCHIVE.get(lid, {}).get(round_name, {}).get(h_name)
        a_elo = ELO_ARCHIVE.get(lid, {}).get(round_name, {}).get(a_name)
        
        if h_elo is None or a_elo is None:
            errors["no_elo"] += 1
            continue
        
        # Calcul moyenne ligue
        all_xg = tracker[h_id]['xg'] + tracker[a_id]['xg']
        league_avg = np.mean(all_xg) if all_xg else 1.5
        
        # Statistiques avec Shrinkage Bayésien
        xg_h = bayesian_shrinkage(tracker[h_id]['xg'], league_avg)
        xg_a = bayesian_shrinkage(tracker[a_id]['xg'], league_avg)
        
        # Calcul lambdas avec Impact Players
        lh, la = compute_lambdas_with_impact(m, xg_h, xg_a, h_elo - a_elo, params)
        
        # Matrice de probabilités
        prob_h, prob_d, prob_a = 0, 0, 0
        for i in range(8):
            for j in range(8):
                p = poisson.pmf(i, lh) * poisson.pmf(j, la) * \
                    dixon_coles_adjustment(i, j, lh, la, rho)
                
                if i > j:
                    prob_h += p
                elif i == j:
                    prob_d += p
                else:
                    prob_a += p
        
        # Brier Score
        actual_h, actual_a = m['goals']['home'], m['goals']['away']
        
        if actual_h > actual_a:
            outcome = [1, 0, 0]
        elif actual_h == actual_a:
            outcome = [0, 1, 0]
        else:
            outcome = [0, 0, 1]
        
        predictions = [prob_h, prob_d, prob_a]
        
        brier = np.mean([(predictions[i] - outcome[i])**2 for i in range(3)])
        total_brier += brier
        count += 1
        
        # Mise à jour du tracker
        if m.get('stats', {}).get('home') and m['goals']['home'] is not None:
            xg_home = m['stats']['home'].get('expected_goals')
            xg_away = m['stats']['away'].get('expected_goals')
            
            # Gérer les valeurs None ou null
            if xg_home is not None and xg_away is not None:
                tracker[h_id]['xg'].append(float(xg_home))
                tracker[h_id]['ga'].append(m['goals']['away'])
                tracker[a_id]['xg'].append(float(xg_away))
                tracker[a_id]['ga'].append(m['goals']['home'])
            else:
                errors["no_xg"] += 1
    
    if count == 0:
        return 1e10
    
    avg_brier = total_brier / count
    
    if mode == "Test":
        print(f"\n{'='*60}")
        print(f"🔬 RAPPORT D'ÉVALUATION TEST SET")
        print(f"{'='*60}")
        print(f"Matchs évalués         : {count}")
        print(f"Elo manquants          : {errors['no_elo']}")
        print(f"xG manquants           : {errors['no_xg']}")
        print(f"Données insuffisantes  : {errors['insufficient_data']}")
        print(f"Brier Score moyen      : {avg_brier:.4f}")
        print(f"{'='*60}\n")
    
    return avg_brier

def objective(trial):
    """Fonction objectif pour Optuna"""
    params = {
        'w_xg': trial.suggest_float('w_xg', 0.4, 2.5),
        'w_elo': trial.suggest_float('w_elo', 0.1, 2.5),
        'rho': trial.suggest_float('rho', -0.15, 0.25),
        'hfa': trial.suggest_float('hfa', 15, 150),
        'impact_offensive': trial.suggest_float('impact_offensive', 0.05, 0.30),
        'impact_defensive': trial.suggest_float('impact_defensive', 0.05, 0.25),
        'min_matches': 3
    }
    return evaluate_model_brier(TRAIN_MATCHES, params)

# ============================================================================
# OPTIMISATION
# ============================================================================

print("\n🚀 DÉMARRAGE DE L'OPTIMISATION (Brier Score)\n")

study = optuna.create_study(direction='minimize')
study.optimize(objective, n_trials=150, show_progress_bar=True)

# ============================================================================
# RÉSULTATS
# ============================================================================

print(f"\n{'='*60}")
print(f"🏆 MEILLEURS PARAMÈTRES TROUVÉS")
print(f"{'='*60}")
for param, value in study.best_params.items():
    print(f"{param:20s} : {value:.4f}")
print(f"{'='*60}")
print(f"Brier Score (Train) : {study.best_value:.4f}")
print(f"{'='*60}\n")

# Test Set Validation
test_brier = None
if USE_VALIDATION:
    print("🧪 VALIDATION SUR TEST SET...\n")
    test_params = study.best_params.copy()
    test_params['min_matches'] = 3
    test_brier = evaluate_model_brier(TEST_MATCHES, test_params, mode="Test")
    print(f"✅ Brier Score (Test) : {test_brier:.4f}\n")

# Sauvegarde des paramètres
output = {
    'timestamp': datetime.now().isoformat(),
    'best_params': study.best_params,
    'train_brier': study.best_value,
    'test_brier': test_brier,
    'n_trials': 150,
    'leagues': LEAGUES,
    'total_matches': len(MATCHES)
}

with open(PATHS['params_output'], 'w') as f:
    json.dump(output, f, indent=2)

print(f"💾 Paramètres sauvegardés dans '{PATHS['params_output']}'\n")
print("🎯 Copiez ces valeurs dans backtest_v2.js pour voir l'impact !\n")
print("=" * 60)