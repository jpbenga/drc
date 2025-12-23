import json
from difflib import SequenceMatcher

def similarity(a, b):
    """Calcule la similarité entre deux chaînes (0 à 1)"""
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()

def normalize_name(name):
    """Normalise un nom pour améliorer le matching"""
    replacements = {
        'fc ': '', 'sc ': '', '1. ': '', '1899 ': '',
        'vfb ': '', 'vfl ': '', 'fsv ': '',
        ' fc': '', ' sc': '', ' cf': '',
        'aek athens fc': 'aek',
        'olympiakos piraeus': 'olympiakos',
        'volos nfc': 'nfc volos',
    }
    name_lower = name.lower()
    for old, new in replacements.items():
        name_lower = name_lower.replace(old, new)
    return name_lower.strip()

def create_manual_mappings():
    """Mappings manuels pour les cas difficiles"""
    return {
        # Premier League
        'Manchester City': 'Man City',
        'Manchester United': 'Man United',
        'Nottingham Forest': 'Forest',
        
        # Ligue 1
        'Paris Saint Germain': 'Paris SG',
        'Stade Brestois 29': 'Brest',
        
        # Bundesliga
        '1. FC Heidenheim': 'Heidenheim',
        '1. FC Köln': 'Koeln',
        '1899 Hoffenheim': 'Hoffenheim',
        'Bayer Leverkusen': 'Leverkusen',
        'Bayern München': 'Bayern',
        'Borussia Dortmund': 'Dortmund',
        'Borussia Mönchengladbach': 'Gladbach',
        'Eintracht Frankfurt': 'Frankfurt',
        'FC Augsburg': 'Augsburg',
        'FC St. Pauli': 'St Pauli',
        'FSV Mainz 05': 'Mainz',
        'Hamburger SV': 'Hamburg',
        'SC Freiburg': 'Freiburg',
        'VfB Stuttgart': 'Stuttgart',
        'VfL Wolfsburg': 'Wolfsburg',
        'Werder Bremen': 'Werder',
        
        # La Liga
        'Athletic Club': 'Bilbao',
        'Atletico Madrid': 'Atletico',
        'Celta Vigo': 'Celta',
        'Real Betis': 'Betis',
        'Real Sociedad': 'Sociedad',
        
        # Serie A
        'AC Milan': 'Milan',
        'AS Roma': 'Roma',
        
        # Liga Portugal
        'AVS': 'AVS Futebol',
        'Estrela': 'Estrela Amadora',
        'FC Porto': 'Porto',
        'GIL Vicente': 'Gil Vicente',
        'SC Braga': 'Braga',
        'Sporting CP': 'Sporting',
        
        # Eredivisie
        'AZ Alkmaar': 'Alkmaar',
        'FC Volendam': 'Volendam',
        'Fortuna Sittard': 'Sittard',
        'GO Ahead Eagles': 'Go Ahead Eagles',
        'NAC Breda': 'Breda',
        'NEC Nijmegen': 'Nijmegen',
        'PEC Zwolle': 'Zwolle',
        'PSV Eindhoven': 'PSV',
        
        # Super League Greece
        'AEK Athens FC': 'AEK',
        'Aris Thessalonikis': 'Aris',
        'Kifisia': 'Kifisias',
        'Levadiakos': 'Levadeiakos',
        'Olympiakos Piraeus': 'Olympiakos',
        'Volos NFC': 'NFC Volos',
        
        # Süper Lig Turkey
        'Başakşehir': 'Bueyueksehir',
        'Beşiktaş': 'Besiktas',
        'Eyüpspor': 'Eyupspor',
        'Fatih Karagümrük': 'Fatih Karaguemruek',
        'Fenerbahçe': 'Fenerbahce',
        'Gazişehir Gaziantep': 'Gaziantep FK',
        'Göztepe': 'Goeztepe',
        'Kasımpaşa': 'Kasimpasa',
        'Kayserispor': 'Kayseri',
    }

def auto_match_clubs(history_clubs, elo_clubs, manual_mappings):
    """Match automatique avec fallback sur similarité"""
    mapping = {}
    unmatched = []
    
    for hist_club in history_clubs:
        # 1. Chercher dans les mappings manuels
        if hist_club in manual_mappings:
            mapping[hist_club] = manual_mappings[hist_club]
            continue
        
        # 2. Chercher une correspondance exacte (insensible à la casse)
        exact_match = None
        for elo_club in elo_clubs:
            if hist_club.lower() == elo_club.lower():
                exact_match = elo_club
                break
        
        if exact_match:
            mapping[hist_club] = exact_match
            continue
        
        # 3. Chercher par similarité normalisée
        hist_normalized = normalize_name(hist_club)
        best_match = None
        best_score = 0.0
        
        for elo_club in elo_clubs:
            elo_normalized = normalize_name(elo_club)
            score = similarity(hist_normalized, elo_normalized)
            
            if score > best_score:
                best_score = score
                best_match = elo_club
        
        # Seuil de confiance à 0.7 (70% de similarité)
        if best_score >= 0.7:
            mapping[hist_club] = best_match
        else:
            unmatched.append({
                'history': hist_club,
                'best_elo_match': best_match,
                'confidence': round(best_score, 2)
            })
    
    return mapping, unmatched

def generate_full_mapping():
    """Génère le mapping complet pour toutes les ligues"""
    
    # Charger les données
    with open('current_elo.json', 'r', encoding='utf-8') as f:
        elo_data = json.load(f)
    
    with open('history.json', 'r', encoding='utf-8') as f:
        history_data = json.load(f)
    
    manual_mappings = create_manual_mappings()
    
    full_mapping = {}
    all_unmatched = {}
    
    leagues = {
        '39': 'Premier League',
        '61': 'Ligue 1',
        '78': 'Bundesliga',
        '140': 'La Liga',
        '135': 'Serie A',
        '94': 'Liga Portugal',
        '88': 'Eredivisie',
        '197': 'Super League (GRE)',
        '203': 'Süper Lig'
    }
    
    for league_id, league_name in leagues.items():
        print(f"\n🏆 Traitement : {league_name}")
        
        # Récupérer les noms des clubs
        history_clubs = [match['home'] for match in history_data.get(league_id, [])]
        history_clubs += [match['away'] for match in history_data.get(league_id, [])]
        history_clubs = sorted(list(set(history_clubs)))
        
        elo_clubs = [team['club'] for team in elo_data.get(league_id, [])]
        
        # Faire le matching
        mapping, unmatched = auto_match_clubs(history_clubs, elo_clubs, manual_mappings)
        
        full_mapping[league_id] = mapping
        
        if unmatched:
            all_unmatched[league_id] = unmatched
            print(f"   ⚠️ {len(unmatched)} clubs non appariés")
        else:
            print(f"   ✅ Tous les clubs appariés ({len(mapping)} clubs)")
    
    # Sauvegarder le mapping
    with open('club_name_mapping.json', 'w', encoding='utf-8') as f:
        json.dump(full_mapping, f, indent=2, ensure_ascii=False)
    
    print(f"\n📁 Fichier créé : club_name_mapping.json")
    
    # Afficher les clubs non appariés
    if all_unmatched:
        print("\n⚠️ CLUBS NON APPARIÉS (confiance < 70%) :")
        for league_id, unmatched in all_unmatched.items():
            print(f"\n{leagues[league_id]} ({league_id}):")
            for item in unmatched:
                print(f"   • {item['history']} → {item['best_elo_match']} ({item['confidence']*100:.0f}%)")
    
    return full_mapping, all_unmatched

if __name__ == "__main__":
    generate_full_mapping()