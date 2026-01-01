"""Download ClubElo rankings and store them as JSON.

Usage:
    python scripts/enrichment/fetch_clubelo_rankings.py --date 2024-08-01

The ClubElo API returns CSV data. This helper converts it to JSON for
consistent consumption across the analytics pipeline.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
from datetime import date
from typing import List, Dict

import requests

BASE_URL = "http://api.clubelo.com"
DEFAULT_OUTPUT = os.path.join("data", "elo", "clubelo_rankings.json")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--date",
        type=str,
        default=date.today().isoformat(),
        help="Ranking date in YYYY-MM-DD format (default: today)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=DEFAULT_OUTPUT,
        help=f"Output JSON path (default: {DEFAULT_OUTPUT})",
    )
    return parser.parse_args()


def fetch_rankings(target_date: str) -> List[Dict[str, str]]:
    url = f"{BASE_URL}/{target_date}"
    response = requests.get(url, headers={"User-Agent": "drc-fetcher"}, timeout=30)
    response.raise_for_status()

    decoded = response.text.strip()
    if "Rank" not in decoded.splitlines()[0]:
        raise RuntimeError(f"Réponse ClubElo inattendue pour la date {target_date}")

    reader = csv.DictReader(io.StringIO(decoded))
    reader.fieldnames = [name.strip() for name in (reader.fieldnames or [])]
    return [dict(row) for row in reader]


def save_rankings(rows: List[Dict[str, str]], output: str) -> None:
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, ensure_ascii=False)


def main() -> None:
    args = parse_args()
    print(f"📥 Téléchargement du classement Elo pour {args.date}...")
    rows = fetch_rankings(args.date)
    save_rankings(rows, args.output)
    print(f"✅ {len(rows)} clubs sauvegardés dans {args.output}")


if __name__ == "__main__":
    main()
