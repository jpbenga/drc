"""Download Championship fixture history from API-Football.

This script queries the API-Football v3 fixtures endpoint and stores the
raw responses in ``data/history/history_<league>.json`` so the backtesting
pipeline can work with fresh data for the English Championship.

Usage example:

    APISPORTS_KEY=... python scripts/enrichment/fetch_championship_history.py \
        --season 2024

Optional arguments allow targeting a specific date (``--date``) or output
path. The script paginates automatically until all fixtures are retrieved.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime
from typing import Dict, List, Optional

import requests

API_URL = "https://v3.football.api-sports.io/fixtures"
DEFAULT_LEAGUE_ID = 40  # English Championship


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--league",
        type=int,
        default=DEFAULT_LEAGUE_ID,
        help="League ID to fetch (default: 40 for Championship)",
    )
    parser.add_argument(
        "--season",
        type=int,
        default=datetime.utcnow().year,
        help="Season to download (defaults to current year)",
    )
    parser.add_argument(
        "--date",
        type=str,
        default=None,
        help="Specific date (YYYY-MM-DD) to restrict fixtures",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Custom output path (defaults to data/history/history_<league>.json)",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.25,
        help="Delay between paginated calls to respect rate limits",
    )
    return parser.parse_args()


def get_api_key() -> str:
    api_key = os.getenv("APISPORTS_KEY")
    if not api_key:
        raise RuntimeError("Missing APISPORTS_KEY environment variable.")
    return api_key


def fetch_page(api_key: str, params: Dict[str, str], page: int) -> Dict:
    response = requests.get(
        API_URL,
        headers={"x-apisports-key": api_key},
        params={**params, "page": page},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def collect_fixtures(api_key: str, league: int, season: int, date: Optional[str], pause: float) -> List[Dict]:
    params: Dict[str, str] = {"league": league, "season": season}
    if date:
        params["date"] = date

    fixtures: List[Dict] = []
    page = 1
    while True:
        payload = fetch_page(api_key, params, page)
        fixtures.extend(payload.get("response", []))

        paging = payload.get("paging") or {}
        if paging.get("current", 0) >= paging.get("total", 0):
            break

        page += 1
        time.sleep(pause)

    fixtures.sort(key=lambda f: f.get("fixture", {}).get("date", ""))
    return fixtures


def build_output_path(league: int, custom: Optional[str]) -> str:
    if custom:
        return custom
    return os.path.join("data", "history", f"history_{league}.json")


def save_history(fixtures: List[Dict], path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(fixtures, f, indent=2, ensure_ascii=False)


def main() -> None:
    args = parse_args()
    api_key = get_api_key()

    print(
        f"📥 Téléchargement des matchs (league={args.league}, season={args.season}, date={args.date or 'ALL'})"
    )
    fixtures = collect_fixtures(api_key, args.league, args.season, args.date, args.sleep)
    output_path = build_output_path(args.league, args.output)
    save_history(fixtures, output_path)
    print(f"✅ {len(fixtures)} matchs enregistrés dans {output_path}")


if __name__ == "__main__":
    main()
