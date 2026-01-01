"""Generate API-Football ⇄ ClubElo name suggestions.

The script scans a history file (downloaded from the fixtures endpoint) and a
ClubElo ranking dump to propose mappings that can be pasted into
``CLUB_NAME_MAPPING.py``. It is designed to simplify refreshing the mapping
whenever the league roster changes.
"""

from __future__ import annotations

import argparse
import json
import unicodedata
from difflib import SequenceMatcher
from typing import Dict, Iterable, List, Tuple

DEFAULT_HISTORY = "data/history/history_40.json"
DEFAULT_ELO = "data/elo/clubelo_rankings.json"
DEFAULT_OUTPUT = "data/elo/championship_club_mapping.json"


STOP_WORDS = {"fc", "afc", "cf", "club"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", default=DEFAULT_HISTORY, help="Path to history_<league>.json")
    parser.add_argument("--elo", default=DEFAULT_ELO, help="Path to clubelo_rankings.json")
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Destination for the suggestion JSON report",
    )
    parser.add_argument(
        "--country",
        default="ENG",
        help="ISO Country code used by ClubElo (default: ENG for Championship)",
    )
    parser.add_argument(
        "--min-score",
        type=float,
        default=0.5,
        help="Minimum similarity ratio required to keep a suggestion",
    )
    return parser.parse_args()


def normalize(name: str) -> str:
    cleaned = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    words = [w for w in cleaned.replace("-", " ").replace("'", " ").lower().split() if w not in STOP_WORDS]
    return " ".join(words)


def load_history(path: str) -> List[str]:
    with open(path, "r", encoding="utf-8") as f:
        history = json.load(f)
    clubs = set()
    for match in history:
        clubs.add(match.get("teams", {}).get("home", {}).get("name"))
        clubs.add(match.get("teams", {}).get("away", {}).get("name"))
    return sorted(c for c in clubs if c)


def load_elo_names(path: str, country: str) -> List[str]:
    with open(path, "r", encoding="utf-8") as f:
        rankings = json.load(f)
    return sorted({row["Club"] for row in rankings if row.get("Country") == country})


def best_match(source: str, choices: Iterable[str]) -> Tuple[str, float]:
    normalized_choices = {c: normalize(c) for c in choices}
    target = normalize(source)
    best_choice = ""
    best_score = 0.0
    for club, norm in normalized_choices.items():
        score = SequenceMatcher(None, target, norm).ratio()
        if score > best_score:
            best_choice = club
            best_score = score
    return best_choice, best_score


def build_mapping(history_clubs: List[str], elo_clubs: List[str], min_score: float) -> Dict[str, Dict[str, str]]:
    suggestions: Dict[str, Dict[str, str]] = {}
    for club in history_clubs:
        match, score = best_match(club, elo_clubs)
        if score >= min_score:
            suggestions[club] = {"elo": match, "score": round(score, 3)}
    return suggestions


def main() -> None:
    args = parse_args()
    history_clubs = load_history(args.history)
    elo_clubs = load_elo_names(args.elo, args.country)

    print(f"🔎 {len(history_clubs)} clubs trouvés dans {args.history}")
    print(f"📊 {len(elo_clubs)} clubs Elo pour le pays {args.country}")

    suggestions = build_mapping(history_clubs, elo_clubs, args.min_score)

    report = {
        "history_file": args.history,
        "elo_file": args.elo,
        "country": args.country,
        "min_score": args.min_score,
        "suggestions": suggestions,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"✅ Suggestions sauvegardées dans {args.output}")
    print("💡 Copiez les paires dans CLUB_NAME_MAPPING.py pour actualiser le mapping.")


if __name__ == "__main__":
    main()
