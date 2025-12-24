import json

with open("elo_history_archive.json", "r") as f:
    archive = json.load(f)

print(f"{'Ligue':<10} | {'Journées en archive':<20} | {'Clubs mappés (moyenne)':<20}")
print("-" * 60)

for lid, rounds in archive.items():
    nb_rounds = len(rounds)
    # On regarde combien de clubs ont un score Elo pour la première journée trouvée
    if nb_rounds > 0:
        first_round = list(rounds.keys())[0]
        nb_clubs = len(rounds[first_round])
    else:
        nb_clubs = 0
    
    print(f"{lid:<10} | {nb_rounds:<20} | {nb_clubs:<20}")