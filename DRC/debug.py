import requests
import json

# === CONFIGURATION ===
API_KEY = "7f7700a471beeeb52aecde406a3870ba"  # <--- METS TA VRAIE CLÉ ICI
FIXTURE_ID = 1400742

def diagnose_match():
    # 1. Vérifions d'abord l'état général du match
    url_fixture = f"https://v3.football.api-sports.io/fixtures?id={FIXTURE_ID}"
    # 2. Vérifions les statistiques
    url_stats = f"https://v3.football.api-sports.io/fixtures/statistics?fixture={FIXTURE_ID}"
    
    headers = {
        'x-rapidapi-host': "v3.football.api-sports.io",
        'x-rapidapi-key': API_KEY
    }

    try:
        print(f"📡 Interrogation de l'API pour le Fixture ID : {FIXTURE_ID}...")
        
        # Check Fixture
        req_fix = requests.get(url_fixture, headers=headers)
        fix_data = req_fix.json()
        
        if not fix_data.get('response'):
            print("❌ Erreur : Le match lui-même n'est pas trouvé par l'API. L'ID est peut-être incorrect.")
            print(f"Réponse API : {fix_data}")
            return

        match_info = fix_data['response'][0]
        print(f"\n✅ MATCH TROUVÉ : {match_info['teams']['home']['name']} vs {match_info['teams']['away']['name']}")
        print(f"Statut : {match_info['fixture']['status']['long']} ({match_info['fixture']['status']['short']})")
        print(f"Score final : {match_info['goals']['home']}-{match_info['goals']['away']}")

        # Check Statistics
        print(f"\n📡 Récupération des statistiques...")
        req_stats = requests.get(url_stats, headers=headers)
        stats_data = req_stats.json()

        if not stats_data.get('response') or len(stats_data['response']) == 0:
            print("❌ RÉSULTAT : L'API ne possède aucune statistique pour ce match.")
        else:
            print("✅ Statistiques reçues ! Voici les clés disponibles :")
            for team_data in stats_data['response']:
                team_name = team_data['team']['name']
                available_keys = [s['type'] for s in team_data['statistics']]
                print(f"- {team_name} : {', '.join(available_keys)}")

    except Exception as e:
        print(f"❌ Erreur technique : {e}")

if __name__ == "__main__":
    diagnose_match()