#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
optimizer.py — SDM Ultra (Robust Quant Optimizer, High-Volume Evaluation)

Goal: evaluate and optimize on *as many historical matches as possible* (hundreds/thousands),
while staying statistically sound and production-like.

Why you previously saw only 18 matches on TEST:
- The TEST evaluation restarted team histories from zero, so most matches were skipped.
This version fixes that with:
1) Walk-forward evaluation (chronological, online update)
2) A configurable burn-in per team (e.g., start after matchday ~6)
3) Warm-starting TEST with a tracker seeded from TRAIN (no reset)

Model/Math upgrades kept:
- Combined loss (proper scoring rules):
  * Brier 1X2 + NLL exact score + Brier submarkets (from the score matrix)
- Dixon–Coles safety: clamp negative probs + renormalize matrix to sum=1
- Lambdas use attack (xG) and defense proxy (GA = goals conceded), with shrinkage
- Shrinkage strength optimized (confidence_shrinkage)
- Impact players tuned (impact_offensive / impact_defensive)

Run:
  python optimizer.py

Output:
  ./data/params/optimized_params.json
"""

from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Tuple, Optional

import numpy as np
import optuna
from scipy.stats import poisson


# =============================================================================
# CONFIG
# =============================================================================

LEAGUES: List[str] = ['39', '61', '78', '140', '135', '94', '88', '203']  # 197 removed
PATHS = {
    'elo': './data/elo/elo_history_archive.json',
    'history': lambda lid: f'./data/history/history_{lid}.json',
    'meta': lambda lid: f'./data/meta/league_{lid}_meta.json',
    'params_output': './data/params/optimized_params.json'
}

MAX_GOALS = 8  # matrix 0..MAX_GOALS inclusive
EPS = 1e-12

LOSS_WEIGHTS = {
    "brier_1x2": 0.55,
    "nll_score": 0.30,
    "brier_sub": 0.15,
}

SUBMARKETS = [
    "btts",
    "over25",
    "under25",
    "home_scores",
    "away_scores",
    "home_over15",
    "away_over15",
]

# This is the "start around matchday 6" knob.
# We only SCORE matches when BOTH teams have at least this many prior matches in the tracker.
MIN_TEAM_HISTORY_MATCHES = 5

# Optuna
N_TRIALS = 200
RANDOM_SEED = 42


# =============================================================================
# DATA LOADING
# =============================================================================

def load_all_matches() -> List[dict]:
    all_matches: List[dict] = []
    for lid in LEAGUES:
        fp = PATHS['history'](lid)
        if not os.path.exists(fp):
            print(f"⚠️  Missing history file: {fp} (skip)")
            continue
        with open(fp, 'r', encoding='utf-8') as f:
            data = json.load(f)
        for m in data:
            status = m.get('fixture', {}).get('status', {}).get('short')
            goals_h = m.get('goals', {}).get('home')
            if status == 'FT' and goals_h is not None:
                m['league_id_str'] = str(lid)
                all_matches.append(m)
    return all_matches


def load_meta_data() -> Dict[str, dict]:
    meta: Dict[str, dict] = {}
    for lid in LEAGUES:
        mp = PATHS['meta'](lid)
        if os.path.exists(mp):
            with open(mp, 'r', encoding='utf-8') as f:
                meta[lid] = json.load(f)
        else:
            print(f"⚠️  Missing meta for league {lid}")
    return meta


if not os.path.exists(PATHS['elo']):
    raise FileNotFoundError(f"❌ Missing Elo archive: {PATHS['elo']}")

os.makedirs('./data/params', exist_ok=True)

with open(PATHS['elo'], 'r', encoding='utf-8') as f:
    ELO_ARCHIVE: Dict[str, dict] = json.load(f)

MATCHES: List[dict] = load_all_matches()
META: Dict[str, dict] = load_meta_data()

# Chronological split 80/20 across all leagues combined
MATCHES.sort(key=lambda x: x['fixture']['date'])
if len(MATCHES) < 100:
    TRAIN_MATCHES, TEST_MATCHES, USE_VALIDATION = MATCHES, [], False
else:
    split_idx = int(len(MATCHES) * 0.8)
    TRAIN_MATCHES, TEST_MATCHES, USE_VALIDATION = MATCHES[:split_idx], MATCHES[split_idx:], True

print(f"\n{'='*80}")
print("📊 DATASET LOADED")
print(f"{'='*80}")
print(f"Total matches (all leagues) : {len(MATCHES)}")
if USE_VALIDATION:
    print(f"Train set                  : {len(TRAIN_MATCHES)}")
    print(f"Test set                   : {len(TEST_MATCHES)}")
print(f"Leagues with meta          : {len(META)}")
print(f"Min team history matches   : {MIN_TEAM_HISTORY_MATCHES}")
print(f"{'='*80}\n")


# =============================================================================
# MODEL MATH
# =============================================================================

def clubelo_win_probability(delta_elo: float) -> float:
    return 1.0 / (10 ** (-delta_elo / 400.0) + 1.0)


def bayesian_shrinkage(team_stats: List[float], league_avg: float, confidence: float) -> float:
    n = len(team_stats)
    if n <= 0:
        return league_avg
    team_mean = float(np.mean(team_stats))
    return (confidence * league_avg + n * team_mean) / (confidence + n)


def dixon_coles_tau(i: int, j: int, lh: float, la: float, rho: float) -> float:
    if abs(rho) < 1e-15:
        return 1.0
    if i == 0 and j == 0:
        return 1.0 - (lh * la * rho)
    if i == 0 and j == 1:
        return 1.0 + (lh * rho)   # convention (keep consistent everywhere)
    if i == 1 and j == 0:
        return 1.0 + (la * rho)
    if i == 1 and j == 1:
        return 1.0 - rho
    return 1.0


def detect_impact_absences(match: dict, meta_by_league: Dict[str, dict], side: str) -> Tuple[float, float]:
    if not match.get('context') or not meta_by_league:
        return 0.0, 0.0

    lid = match['league_id_str']
    injuries = match['context'].get(f'injuries_{side}', []) or []
    offensive_impact = 0.0
    defensive_impact = 0.0

    top_scorers = meta_by_league.get(lid, {}).get('top_scorers', []) or []
    top_assists = meta_by_league.get(lid, {}).get('top_assists', []) or []

    ratings_key = f'player_ratings_{side}'
    player_ratings = match['context'].get(ratings_key, []) or []

    for inj in injuries:
        if inj.get('type') != 'Missing Fixture':
            continue
        pid = inj.get('player_id')

        if any(p.get('id') == pid for p in top_scorers):
            offensive_impact += 1.0
        if any(p.get('id') == pid for p in top_assists):
            offensive_impact += 0.5

        pdata = next((p for p in player_ratings if p.get('id') == pid), None)
        if pdata:
            pos = pdata.get('position', '')
            rating = float(pdata.get('rating') or 0.0)
            if pos in ['Defender', 'Goalkeeper'] and rating > 7.0:
                defensive_impact += 1.0

    return offensive_impact, defensive_impact


def compute_lambdas(
    match: dict,
    tracker_home: dict,
    tracker_away: dict,
    delta_elo: float,
    params: dict,
    league_avg_xg: float,
    league_avg_ga: float,
) -> Tuple[float, float]:
    w_xg = float(params['w_xg'])
    w_elo = float(params['w_elo'])
    hfa = float(params['hfa'])
    impact_off = float(params['impact_offensive'])
    impact_def = float(params['impact_defensive'])
    conf = float(params['confidence_shrinkage'])

    att_h = bayesian_shrinkage(tracker_home['xg'], league_avg_xg, conf)
    def_h = bayesian_shrinkage(tracker_home['ga'], league_avg_ga, conf)
    att_a = bayesian_shrinkage(tracker_away['xg'], league_avg_xg, conf)
    def_a = bayesian_shrinkage(tracker_away['ga'], league_avg_ga, conf)

    p_win_h = clubelo_win_probability(delta_elo + hfa)
    p_win_a = 1.0 - p_win_h

    lh = (att_h * 0.60 + def_a * 0.40) * w_xg * ((p_win_h / 0.5) ** w_elo)
    la = (att_a * 0.60 + def_h * 0.40) * w_xg * ((p_win_a / 0.5) ** w_elo)

    # Impact players
    lid = match['league_id_str']
    meta_lid = META.get(lid)
    if meta_lid:
        i_h_off, i_h_def = detect_impact_absences(match, {lid: meta_lid}, 'home')
        i_a_off, i_a_def = detect_impact_absences(match, {lid: meta_lid}, 'away')

        if i_h_off > 0:
            lh *= (1.0 - impact_off * i_h_off)
        if i_a_def > 0:
            lh *= (1.0 + impact_def * i_a_def)

        if i_a_off > 0:
            la *= (1.0 - impact_off * i_a_off)
        if i_h_def > 0:
            la *= (1.0 + impact_def * i_h_def)

    return max(float(lh), 0.01), max(float(la), 0.01)


def build_score_matrix(lh: float, la: float, rho: float, max_goals: int = MAX_GOALS) -> Tuple[np.ndarray, Dict[str, float]]:
    size = max_goals + 1
    mat = np.zeros((size, size), dtype=np.float64)

    for i in range(size):
        p_i = poisson.pmf(i, lh)
        for j in range(size):
            p = p_i * poisson.pmf(j, la) * dixon_coles_tau(i, j, lh, la, rho)
            if p < 0:
                p = 0.0
            mat[i, j] = p

    s = float(mat.sum())
    if s <= 0:
        for i in range(size):
            p_i = poisson.pmf(i, lh)
            for j in range(size):
                mat[i, j] = p_i * poisson.pmf(j, la)
        s = float(mat.sum())

    mat /= max(s, EPS)

    i_idx, j_idx = np.indices(mat.shape)
    total_goals = i_idx + j_idx

    markets = {
        "p_home": float(mat[i_idx > j_idx].sum()),
        "p_draw": float(mat[i_idx == j_idx].sum()),
        "p_away": float(mat[i_idx < j_idx].sum()),
        "btts": float(mat[(i_idx > 0) & (j_idx > 0)].sum()),
        "over25": float(mat[total_goals > 2].sum()),
        "under25": float(mat[total_goals < 3].sum()),
        "home_scores": float(mat[i_idx > 0].sum()),
        "away_scores": float(mat[j_idx > 0].sum()),
        "home_over15": float(mat[i_idx > 1].sum()),
        "away_over15": float(mat[j_idx > 1].sum()),
    }
    return mat, markets


# =============================================================================
# SCORING
# =============================================================================

def brier_1x2(pred: Tuple[float, float, float], actual: Tuple[int, int, int]) -> float:
    return float(np.mean([(pred[i] - actual[i]) ** 2 for i in range(3)]))


def brier_binary(p: float, y: int) -> float:
    return float((p - float(y)) ** 2)


def nll_of_score(mat: np.ndarray, actual_h: int, actual_a: int) -> float:
    h = int(np.clip(actual_h, 0, mat.shape[0] - 1))
    a = int(np.clip(actual_a, 0, mat.shape[1] - 1))
    p = float(mat[h, a])
    return float(-np.log(p + EPS))


# =============================================================================
# WALK-FORWARD EVAL (HIGH VOLUME)
# =============================================================================

@dataclass
class EvalDiag:
    scored: int
    skipped_insufficient_history: int
    skipped_missing_elo: int
    skipped_missing_xg: int
    avg_loss: float
    avg_brier_1x2: float
    avg_nll_score: float
    avg_brier_sub: float


def _ensure_tracker(tracker: Dict[int, dict], team_id: int) -> None:
    if team_id not in tracker:
        tracker[team_id] = {"xg": [], "ga": [], "played": 0}


def _update_tracker_from_match(tracker: Dict[int, dict], m: dict) -> bool:
    h_id = m['teams']['home']['id']
    a_id = m['teams']['away']['id']
    _ensure_tracker(tracker, h_id)
    _ensure_tracker(tracker, a_id)

    xg_home = m.get('stats', {}).get('home', {}).get('expected_goals')
    xg_away = m.get('stats', {}).get('away', {}).get('expected_goals')
    goals_h = m.get('goals', {}).get('home')
    goals_a = m.get('goals', {}).get('away')

    tracker[h_id]["played"] += 1
    tracker[a_id]["played"] += 1

    if xg_home is None or xg_away is None or goals_h is None or goals_a is None:
        return False

    tracker[h_id]["xg"].append(float(xg_home))
    tracker[h_id]["ga"].append(int(goals_a))
    tracker[a_id]["xg"].append(float(xg_away))
    tracker[a_id]["ga"].append(int(goals_h))
    return True


def build_tracker_seed(matches: List[dict]) -> Dict[int, dict]:
    tracker: Dict[int, dict] = {}
    for m in matches:
        _update_tracker_from_match(tracker, m)
    return tracker


def walk_forward_evaluate(
    matches: List[dict],
    params: dict,
    tracker_seed: Optional[Dict[int, dict]] = None,
) -> Tuple[float, EvalDiag]:
    rho = float(params["rho"])
    tracker: Dict[int, dict] = copy.deepcopy(tracker_seed) if tracker_seed else {}

    scored = 0
    skip_hist = 0
    skip_elo = 0
    skip_xg = 0

    loss_sum = 0.0
    brier1x2_sum = 0.0
    nll_sum = 0.0
    brier_sub_sum = 0.0

    for m in matches:
        lid = m["league_id_str"]
        rnd = m["league"]["round"]
        h_id = m["teams"]["home"]["id"]
        a_id = m["teams"]["away"]["id"]
        h_name = m["teams"]["home"]["name"]
        a_name = m["teams"]["away"]["name"]

        _ensure_tracker(tracker, h_id)
        _ensure_tracker(tracker, a_id)

        # burn-in per team (your "start around matchday 6")
        if tracker[h_id]["played"] < MIN_TEAM_HISTORY_MATCHES or tracker[a_id]["played"] < MIN_TEAM_HISTORY_MATCHES:
            ok = _update_tracker_from_match(tracker, m)
            if not ok:
                skip_xg += 1
            else:
                skip_hist += 1
            continue

        # Elo required
        h_elo = ELO_ARCHIVE.get(lid, {}).get(rnd, {}).get(h_name)
        a_elo = ELO_ARCHIVE.get(lid, {}).get(rnd, {}).get(a_name)
        if h_elo is None or a_elo is None:
            skip_elo += 1
            ok = _update_tracker_from_match(tracker, m)
            if not ok:
                skip_xg += 1
            continue

        # league averages for shrinkage (simple)
        all_xg = tracker[h_id]["xg"] + tracker[a_id]["xg"]
        league_avg_xg = float(np.mean(all_xg)) if all_xg else 1.5
        all_ga = tracker[h_id]["ga"] + tracker[a_id]["ga"]
        league_avg_ga = float(np.mean(all_ga)) if all_ga else 1.5

        lh, la = compute_lambdas(
            m, tracker[h_id], tracker[a_id], float(h_elo) - float(a_elo),
            params, league_avg_xg=league_avg_xg, league_avg_ga=league_avg_ga
        )

        mat, mk = build_score_matrix(lh, la, rho, max_goals=MAX_GOALS)

        goals_h = m["goals"]["home"]
        goals_a = m["goals"]["away"]
        if goals_h is None or goals_a is None:
            ok = _update_tracker_from_match(tracker, m)
            if not ok:
                skip_xg += 1
            continue

        actual_h = int(goals_h)
        actual_a = int(goals_a)

        if actual_h > actual_a:
            y_1x2 = (1, 0, 0)
        elif actual_h == actual_a:
            y_1x2 = (0, 1, 0)
        else:
            y_1x2 = (0, 0, 1)

        pred_1x2 = (mk["p_home"], mk["p_draw"], mk["p_away"])

        l_brier = brier_1x2(pred_1x2, y_1x2)
        l_nll = nll_of_score(mat, actual_h, actual_a)

        y_sub = {
            "btts": 1 if (actual_h > 0 and actual_a > 0) else 0,
            "over25": 1 if (actual_h + actual_a > 2) else 0,
            "under25": 1 if (actual_h + actual_a < 3) else 0,
            "home_scores": 1 if (actual_h > 0) else 0,
            "away_scores": 1 if (actual_a > 0) else 0,
            "home_over15": 1 if (actual_h > 1) else 0,
            "away_over15": 1 if (actual_a > 1) else 0,
        }
        l_sub = float(np.mean([brier_binary(float(mk[k]), int(y_sub[k])) for k in SUBMARKETS]))

        L = (LOSS_WEIGHTS["brier_1x2"] * l_brier
             + LOSS_WEIGHTS["nll_score"] * l_nll
             + LOSS_WEIGHTS["brier_sub"] * l_sub)

        loss_sum += L
        brier1x2_sum += l_brier
        nll_sum += l_nll
        brier_sub_sum += l_sub
        scored += 1

        ok = _update_tracker_from_match(tracker, m)
        if not ok:
            skip_xg += 1

    if scored <= 0:
        return 1e10, EvalDiag(0, skip_hist, skip_elo, skip_xg, 1e10, 0, 0, 0)

    avg_loss = loss_sum / scored
    return avg_loss, EvalDiag(
        scored=scored,
        skipped_insufficient_history=skip_hist,
        skipped_missing_elo=skip_elo,
        skipped_missing_xg=skip_xg,
        avg_loss=avg_loss,
        avg_brier_1x2=brier1x2_sum / scored,
        avg_nll_score=nll_sum / scored,
        avg_brier_sub=brier_sub_sum / scored,
    )


# =============================================================================
# OPTUNA
# =============================================================================

def objective(trial: optuna.Trial) -> float:
    params = {
        "w_xg": trial.suggest_float("w_xg", 0.4, 2.8),
        "w_elo": trial.suggest_float("w_elo", 0.1, 2.8),
        "rho": trial.suggest_float("rho", -0.20, 0.30),
        "hfa": trial.suggest_float("hfa", 10.0, 180.0),
        "impact_offensive": trial.suggest_float("impact_offensive", 0.02, 0.35),
        "impact_defensive": trial.suggest_float("impact_defensive", 0.02, 0.30),
        "confidence_shrinkage": trial.suggest_float("confidence_shrinkage", 2.0, 30.0),
    }

    loss, _ = walk_forward_evaluate(TRAIN_MATCHES, params, tracker_seed=None)
    return float(loss)


def main() -> None:
    print("\n🚀 OPTIMIZATION START (High-Volume Walk-Forward)")
    print(f"   Burn-in per team: {MIN_TEAM_HISTORY_MATCHES} matches")
    print("   Loss = 0.55*Brier(1X2) + 0.30*NLL(score) + 0.15*Brier(submarkets)\n")

    sampler = optuna.samplers.TPESampler(seed=RANDOM_SEED, multivariate=True, group=True)
    study = optuna.create_study(direction="minimize", sampler=sampler)
    study.optimize(objective, n_trials=N_TRIALS, show_progress_bar=True)

    print(f"\n{'='*80}")
    print("🏆 BEST PARAMETERS FOUND")
    print(f"{'='*80}")
    for k, v in study.best_params.items():
        print(f"{k:24s} : {v:.6f}" if isinstance(v, float) else f"{k:24s} : {v}")
    print(f"{'-'*80}")
    print(f"Best Combined Loss (Train): {study.best_value:.6f}")
    print(f"{'='*80}\n")

    test_loss = None
    test_diag = None

    if USE_VALIDATION:
        print("🧪 VALIDATION ON TEST SET (warm-started from TRAIN)...\n")
        seed = build_tracker_seed(TRAIN_MATCHES)
        test_loss, test_diag = walk_forward_evaluate(TEST_MATCHES, study.best_params, tracker_seed=seed)

        print(f"\n{'='*80}")
        print("🔬 TEST SET REPORT (High-Volume Walk-Forward)")
        print(f"{'='*80}")
        print(f"Scored matches                 : {test_diag.scored}")
        print(f"Skipped (insufficient history) : {test_diag.skipped_insufficient_history}")
        print(f"Skipped (missing Elo)          : {test_diag.skipped_missing_elo}")
        print(f"Skipped (missing xG/goals)     : {test_diag.skipped_missing_xg}")
        print(f"{'-'*80}")
        print(f"Avg Combined Loss              : {test_diag.avg_loss:.6f}")
        print(f"Avg Brier (1X2)                : {test_diag.avg_brier_1x2:.6f}")
        print(f"Avg NLL (score)                : {test_diag.avg_nll_score:.6f}")
        print(f"Avg Brier (submarkets)         : {test_diag.avg_brier_sub:.6f}")
        print(f"{'='*80}\n")

    output = {
        "timestamp": datetime.now().isoformat(),
        "best_params": study.best_params,
        "train_loss": float(study.best_value),
        "test_loss": float(test_loss) if test_loss is not None else None,
        "n_trials": int(N_TRIALS),
        "random_seed": int(RANDOM_SEED),
        "loss_weights": LOSS_WEIGHTS,
        "submarkets": SUBMARKETS,
        "max_goals": int(MAX_GOALS),
        "leagues": LEAGUES,
        "min_team_history_matches": int(MIN_TEAM_HISTORY_MATCHES),
        "total_matches": int(len(MATCHES)),
    }

    with open(PATHS["params_output"], "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"💾 Parameters saved to '{PATHS['params_output']}'")
    print("🎯 Next: run your Node backtest script which loads optimized_params.json")
    print("=" * 80)


if __name__ == "__main__":
    main()
