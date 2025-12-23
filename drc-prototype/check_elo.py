import requests
import csv
import io
import json
from datetime import datetime

# Configuration des 9 ligues (ID API-Football -> Code Pays ClubElo)
LEAGUES_MAP = {
    '39':  {'name': "Premier League",      'country': 'ENG'},
    '61':  {'name': "Ligue 1",             'country': 'FRA'},
    '78':  {'name': "Bundesliga",          'country': 'GER'},
    '140': {'name': "La Liga",             'country': 'ESP'},
    '135': {'name': "Serie A",             'country': 'ITA'},
    '94':  {'name': "Liga Portugal",       'country': 'POR'},
    '88':  {'name': "Eredivisie",          'country': 'NED'},
    '197': {'name': "Super League (GRE)",  'country': 'GRE'},
    '203': {'name': "Süper Lig",           'country': 'TUR'}
}

def fetch_all_elo_to_json():
    # Date du jour pour l'URL
    today = datetime.now().strftime('%Y-%m-%d')
    url = f"http://api.clubelo.com/{today}"
    
    print(f"📡 Connexion à ClubElo ({today})...")
    
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(url, timeout=15, headers=headers)
        response.raise_for_status()
        
        # Si la date n'existe pas encore sur le serveur, on utilise l'endpoint global
        if "Rank" not in response.text:
            print("⚠️ Date non trouvée, récupération des dernières données disponibles...")
            url = "http://api.clubelo.com/Rankings"
            response = requests.get(url, timeout=15, headers=headers)
            response.raise_for_status()

        # Lecture du CSV en mémoire
        f = io.StringIO(response.text.strip())
        reader = csv.DictReader(f)
        
        print(f"🔍 Colonnes disponibles : {reader.fieldnames}")
        
        # Préparation du dictionnaire de sortie
        final_data = {}
        for lid in LEAGUES_MAP.keys():
            final_data[lid] = []

        # On parcourt tout le classement mondial et on filtre
        count = 0
        skipped = 0
        
        for row in reader:
            country_code = row.get('Country', '').strip()
            level = row.get('Level', '').strip()
            
            # On ne garde que le niveau 1 (Première division) pour nos pays cibles
            for lid, config in LEAGUES_MAP.items():
                if country_code == config['country'] and level == '1':
                    try:
                        # Récupération des valeurs
                        rank_str = row.get('Rank', '').strip()
                        elo_str = row.get('Elo', '').strip()
                        club_name = row.get('Club', 'Unknown').strip()
                        
                        # Conversion sécurisée du rank (on accepte None/vide)
                        if rank_str and rank_str.lower() != 'none':
                            rank_int = int(rank_str)
                        else:
                            rank_int = 0  # Rank par défaut si manquant
                        
                        # Conversion sécurisée de l'Elo (OBLIGATOIRE)
                        if elo_str and elo_str.lower() != 'none':
                            elo_float = float(elo_str)
                        else:
                            # Si pas d'Elo, on ignore cette ligne
                            skipped += 1
                            print(f"⚠️ Pas d'Elo pour {club_name}, ligne ignorée")
                            continue
                        
                        final_data[lid].append({
                            'rank': rank_int,
                            'club': club_name,
                            'elo': elo_float,
                            'last_update': row.get('From', '').strip()
                        })
                        count += 1
                        
                    except (ValueError, TypeError) as e:
                        skipped += 1
                        print(f"⚠️ Erreur pour {row.get('Club', 'Unknown')}: {e}")

        # Enregistrement dans le fichier JSON
        with open("current_elo.json", "w", encoding='utf-8') as jf:
            json.dump(final_data, jf, indent=4, ensure_ascii=False)
            
        print(f"\n✅ Succès : {count} équipes réparties dans {len(LEAGUES_MAP)} ligues.")
        if skipped > 0:
            print(f"⚠️ {skipped} lignes ignorées")
        print(f"📁 Fichier créé : current_elo.json")
        
        # Afficher un résumé par ligue
        print("\n📊 Résumé par ligue:")
        for lid, config in LEAGUES_MAP.items():
            nb_teams = len(final_data[lid])
            print(f"   {config['name']} ({config['country']}): {nb_teams} équipes")

    except Exception as e:
        print(f"❌ Erreur lors de la récupération : {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    fetch_all_elo_to_json()