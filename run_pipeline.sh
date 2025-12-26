#!/bin/bash

# ============================================================================
# PIPELINE COMPLET DRC - Deep Research Classifier
# ============================================================================

set -e  # Arrêter en cas d'erreur

# Couleurs pour les logs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Fonction de log
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# ============================================================================
# BANNIÈRE
# ============================================================================

echo -e "${BLUE}"
cat << "EOF"
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║          DRC - DEEP RESEARCH CLASSIFIER                  ║
║          Pipeline Complet d'Analyse SDM                  ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# ============================================================================
# VÉRIFICATIONS INITIALES
# ============================================================================

log_info "Vérification de l'environnement..."

# Vérifier Node.js
if ! command -v node &> /dev/null; then
    log_error "Node.js n'est pas installé"
    exit 1
fi
log_success "Node.js $(node --version)"

# Vérifier Python
if ! command -v python3 &> /dev/null; then
    log_error "Python 3 n'est pas installé"
    exit 1
fi
log_success "Python $(python3 --version)"

# Vérifier npm
if ! command -v npm &> /dev/null; then
    log_error "npm n'est pas installé"
    exit 1
fi
log_success "npm $(npm --version)"

echo ""

# ============================================================================
# CRÉATION DE LA STRUCTURE
# ============================================================================

log_info "Création de la structure de dossiers..."

dirs=(
    "data/meta"
    "data/history"
    "data/elo"
    "data/params"
    "data/results"
    "data/backups"
    "scripts/enrichment"
    "scripts/backtest"
    "scripts/optimization"
    "scripts/utils"
    "logs"
)

for dir in "${dirs[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        log_success "Créé : $dir"
    fi
done

echo ""

# ============================================================================
# MENU PRINCIPAL
# ============================================================================

show_menu() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║         PIPELINE DRC - MENU              ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
    echo ""
    echo "  1) 🔧 Enrichissement complet (Meta + Matchs)"
    echo "  2) 📊 Optimisation des paramètres"
    echo "  3) 🚀 Backtest avec dashboard"
    echo "  4) ⚡ Pipeline complet (1 → 2 → 3)"
    echo "  5) 🔍 Vérifier les données"
    echo "  6) 📦 Créer une sauvegarde"
    echo "  7) 🧹 Nettoyer les logs"
    echo "  8) ❌ Quitter"
    echo ""
    read -p "Votre choix : " choice
    echo ""
}

# ============================================================================
# FONCTIONS DU PIPELINE
# ============================================================================

run_enrichment() {
    log_info "Démarrage de l'enrichissement..."
    
    if [ ! -f "scripts/enrichment/enrich_ultra.js" ]; then
        log_error "Script enrich_ultra.js introuvable dans scripts/enrichment/"
        return 1
    fi
    
    cd scripts/enrichment
    node enrich_ultra.js | tee ../../logs/enrichment_$(date +%Y%m%d_%H%M%S).log
    cd ../..
    
    log_success "Enrichissement terminé"
}

run_optimization() {
    log_info "Démarrage de l'optimisation..."
    
    if [ ! -f "scripts/optimization/optimizer_v2.py" ]; then
        log_error "Script optimizer_v2.py introuvable dans scripts/optimization/"
        return 1
    fi
    
    if [ ! -f "data/elo/elo_history_archive.json" ]; then
        log_error "Fichier ELO manquant : data/elo/elo_history_archive.json"
        return 1
    fi
    
    cd scripts/optimization
    python3 optimizer_v2.py | tee ../../logs/optimization_$(date +%Y%m%d_%H%M%S).log
    cd ../..
    
    if [ -f "data/params/optimized_params.json" ]; then
        log_success "Paramètres optimisés sauvegardés"
        log_info "Aperçu des paramètres :"
        cat data/params/optimized_params.json | python3 -m json.tool | grep -A 8 "best_params"
    else
        log_error "Échec de l'optimisation"
        return 1
    fi
}

run_backtest() {
    log_info "Démarrage du backtest..."
    
    if [ ! -f "scripts/backtest/backtest_v2.js" ]; then
        log_error "Script backtest_v2.js introuvable dans scripts/backtest/"
        return 1
    fi
    
    cd scripts/backtest
    log_success "Backtest lancé - Dashboard disponible sur http://localhost:3000"
    log_info "Appuyez sur Ctrl+C pour arrêter le serveur"
    node backtest_v2.js
    cd ../..
}

run_full_pipeline() {
    log_info "🚀 Lancement du pipeline complet..."
    echo ""
    
    # Étape 1 : Enrichissement
    log_info "ÉTAPE 1/3 : Enrichissement"
    run_enrichment || { log_error "Enrichissement échoué"; return 1; }
    echo ""
    
    # Étape 2 : Optimisation
    log_info "ÉTAPE 2/3 : Optimisation"
    run_optimization || { log_error "Optimisation échouée"; return 1; }
    echo ""
    
    # Étape 3 : Backtest
    log_info "ÉTAPE 3/3 : Backtest"
    run_backtest
}

verify_data() {
    log_info "Vérification des données..."
    echo ""
    
    # Vérifier les fichiers d'historique
    hist_count=$(find data/history -name "history_*.json" 2>/dev/null | wc -l)
    log_info "Fichiers d'historique : $hist_count"
    
    # Vérifier les meta
    meta_count=$(find data/meta -name "league_*_meta.json" 2>/dev/null | wc -l)
    log_info "Fichiers meta : $meta_count"
    
    # Vérifier ELO
    if [ -f "data/elo/elo_history_archive.json" ]; then
        log_success "Fichier ELO présent"
    else
        log_warning "Fichier ELO manquant"
    fi
    
    # Vérifier paramètres
    if [ -f "data/params/optimized_params.json" ]; then
        log_success "Paramètres optimisés présents"
    else
        log_warning "Paramètres optimisés manquants"
    fi
    
    # Vérifier résultats
    results_count=$(find data/results -name "backtest_*.json" 2>/dev/null | wc -l)
    log_info "Résultats de backtest : $results_count"
    
    echo ""
    log_info "Taille totale du dossier data :"
    du -sh data/ 2>/dev/null || echo "Impossible de calculer"
}

create_backup() {
    log_info "Création d'une sauvegarde..."
    
    timestamp=$(date +%Y%m%d_%H%M%S)
    backup_dir="data/backups/backup_$timestamp"
    
    mkdir -p "$backup_dir"
    
    # Copier les données importantes
    cp -r data/meta "$backup_dir/" 2>/dev/null || log_warning "Pas de meta à sauvegarder"
    cp -r data/elo "$backup_dir/" 2>/dev/null || log_warning "Pas de ELO à sauvegarder"
    cp -r data/params "$backup_dir/" 2>/dev/null || log_warning "Pas de paramètres à sauvegarder"
    
    # Créer un fichier de métadonnées
    cat > "$backup_dir/backup_info.txt" << EOF
Backup créé le : $(date)
Hostname : $(hostname)
User : $(whoami)
EOF
    
    log_success "Sauvegarde créée : $backup_dir"
    
    # Compresser
    tar -czf "$backup_dir.tar.gz" -C data/backups "backup_$timestamp"
    rm -rf "$backup_dir"
    
    log_success "Archive créée : $backup_dir.tar.gz"
}

clean_logs() {
    log_info "Nettoyage des logs..."
    
    if [ -d "logs" ]; then
        log_count=$(find logs -name "*.log" | wc -l)
        
        if [ "$log_count" -gt 0 ]; then
            read -p "Supprimer $log_count fichiers de log ? (o/N) : " confirm
            if [ "$confirm" = "o" ] || [ "$confirm" = "O" ]; then
                rm -f logs/*.log
                log_success "Logs supprimés"
            else
                log_info "Annulé"
            fi
        else
            log_info "Aucun log à nettoyer"
        fi
    else
        log_warning "Dossier logs inexistant"
    fi
}

# ============================================================================
# BOUCLE PRINCIPALE
# ============================================================================

while true; do
    show_menu
    
    case $choice in
        1)
            run_enrichment
            read -p "Appuyez sur Entrée pour continuer..."
            ;;
        2)
            run_optimization
            read -p "Appuyez sur Entrée pour continuer..."
            ;;
        3)
            run_backtest
            ;;
        4)
            run_full_pipeline
            ;;
        5)
            verify_data
            read -p "Appuyez sur Entrée pour continuer..."
            ;;
        6)
            create_backup
            read -p "Appuyez sur Entrée pour continuer..."
            ;;
        7)
            clean_logs
            read -p "Appuyez sur Entrée pour continuer..."
            ;;
        8)
            log_info "Au revoir !"
            exit 0
            ;;
        *)
            log_warning "Choix invalide"
            ;;
    esac
done