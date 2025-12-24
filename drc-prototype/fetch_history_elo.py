import requests
import json
import os
import io
import csv
import time
from datetime import datetime
from CLUB_NAME_MAPPING import CLUB_NAME_MAPPING

# Configuration des codes pays ClubElo
COUNTRY_CODES = {
    '39': 'ENG', '61': 'FRA', '78': 'GER', '140': 'ESP',
    '135': 'ITA', '94': 'POR', '88': 'NED', '197': 'GRE', '203': 'TUR'
}

def get_round_start_dates(league_id):
    """ Trouve la date la plus ancienne pour chaque journée (round) """
    filename = f"history_{league_id}.json"
    if not os.path.exists(filename): return {}
    
    with open(filename, 'r', encoding='utf-8') as f:
        matches = json.load(f)
    
    round_dates = {}
    for m in matches:
        r = m['league']['round']
        d = m['fixture']['date'][:10] # On garde YYYY-MM-DD
        if r not in round_dates or d < round_dates[r]:
            round_dates[r] = d
    return round_dates

def fetch_elo_map_for_date(date_str):
    """ Télécharge le classement mondial complet pour une date donnée """
    url = f"http://api.clubelo.com/{date_str}"
    headers = {'User-Agent': 'Mozilla/5.0'}
    try:
        response = requests.get(url, headers=headers, timeout=15)
        if "Rank" not in response.text: return None
        
        f = io.StringIO(response.text.strip())
        reader = csv.DictReader(f)
        reader.fieldnames = [n.strip() for n in reader.fieldnames]
        
        # On indexe par [Pays][Nom_ClubElo] pour une recherche ultra-rapide
        data = {}
        for row in reader:
            country = row['Country']
            if country not in data: data[country] = {}
            data[country][row['Club']] = float(row['Elo'])
        return data
    except Exception as e:
        print(f"  ❌ Erreur ClubElo au {date_str}: {e}")
        return None

def main():
    # Structure finale : { league_id: { round_name: { api_team_name: elo_value } } }
    elo_archive = {}
    
    # Pour éviter de télécharger 10 fois la même date si plusieurs ligues jouent le même jour
    global_date_cache = {}

    for lid, country in COUNTRY_CODES.items():
        print(f"📦 Traitement Ligue {lid} ({country})...")
        rounds = get_round_start_dates(lid)
        elo_archive[lid] = {}
        
        # On trie les dates pour un log plus propre
        unique_dates = sorted(list(set(rounds.values())))
        
        for d in unique_dates:
            if d not in global_date_cache:
                print(f"  📥 Téléchargement Elo pour le {d}...")
                global_date_cache[d] = fetch_elo_map_for_date(d)
                time.sleep(1) # Politesse serveur
            
            # Pour chaque journée commençant à cette date 'd'
            current_day_data = global_date_cache[d].get(country, {}) if global_date_cache[d] else {}
            
            # On applique le mapping pour transformer le nom ClubElo en nom API-Football
            mapped_elos = {}
            # On parcourt ton mapping pour cette ligue
            for api_name, elo_name in CLUB_NAME_MAPPING.get(lid, {}).items():
                if elo_name in current_day_data:
                    mapped_elos[api_name] = current_day_data[elo_name]
            
            # On assigne cet état de force à toutes les journées qui commencent ce jour-là
            for r_name, r_date in rounds.items():
                if r_date == d:
                    elo_archive[lid][r_name] = mapped_elos

    # Sauvegarde finale
    with open("elo_history_archive.json", "w", encoding='utf-8') as f:
        json.dump(elo_archive, f, indent=4, ensure_ascii=False)
    
    print(f"\n✅ Terminé ! Archive créée : elo_history_archive.json")
    print(f"💡 Ton backtest peut maintenant simuler le passé avec précision.")

if __name__ == "__main__":
    main()