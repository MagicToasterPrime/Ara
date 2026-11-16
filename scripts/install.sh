#!/usr/bin/env bash
# ==============================================================================
# ARA — Script d'installation automatisé clé-en-main (Ubuntu / Debian)
# Usage : sudo bash scripts/install.sh
# Ce script est idempotent et peut être relancé sans risque pour mettre à jour.
# ==============================================================================
set -euo pipefail

# Couleurs pour la console
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[ARA]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()   { echo -e "${RED}[ERREUR]${NC} $1"; }

# Vérification des privilèges root
if [[ "${EUID}" -ne 0 ]]; then
  log_err "Ce script doit être exécuté avec sudo : sudo bash scripts/install.sh"
  exit 1
fi

# Détermination du répertoire du projet Ara
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_USER="${SUDO_USER:-$(whoami)}"
if [[ "${APP_USER}" == "root" ]] && id -u ubuntu &>/dev/null; then
  APP_USER="ubuntu"
fi

log_info "Installation d'Ara dans : ${APP_DIR} (utilisateur service : ${APP_USER})"

# ------------------------------------------------------------------------------
# 1. Vérification et installation des prérequis système
# ------------------------------------------------------------------------------
log_info "1/7 — Vérification des prérequis système (curl, git, openssl, Node.js 20, Docker)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git openssl ca-certificates gnupg lsb-release build-essential

# Node.js 20 LTS via NodeSource si absent ou version < 20
NEED_NODE=false
if ! command -v node &>/dev/null; then
  NEED_NODE=true
else
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "${NODE_MAJOR}" -lt 20 ]]; then
    NEED_NODE=true
  fi
fi

if [[ "${NEED_NODE}" == "true" ]]; then
  log_info "Installation de Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
log_ok "Node.js $(node -v) & npm $(npm -v) prêts."

# Docker & Docker Compose v2 plugin
if ! command -v docker &>/dev/null; then
  log_info "Installation de Docker Engine & Docker Compose..."
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg --yes
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
    ${VERSION_CODENAME} stable" | tee /etc/apt/sources.list.d/docker.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

if ! docker compose version &>/dev/null; then
  apt-get install -y -qq docker-compose-plugin
fi
log_ok "Docker $(docker --version) & Docker Compose prêts."

# ------------------------------------------------------------------------------
# 2. Génération automatique du fichier .env sécurisé (idempotent)
# ------------------------------------------------------------------------------
log_info "2/7 — Configuration sécurisée de .env..."
cd "${APP_DIR}"
mkdir -p "${APP_DIR}/storage/uploads"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  PG_PASS="$(openssl rand -hex 32)"
  AUTH_SEC="$(openssl rand -hex 32)"
  cat > "${APP_DIR}/.env" <<EOF
DATABASE_URL="postgresql://ara:${PG_PASS}@127.0.0.1:5432/ara?schema=public&connection_limit=10"
POSTGRES_USER="ara"
POSTGRES_PASSWORD="${PG_PASS}"
POSTGRES_DB="ara"
AUTH_SECRET="${AUTH_SEC}"
AUTH_TRUST_HOST="true"
NEXTAUTH_URL="http://localhost:3000"
OLLAMA_HOST="http://127.0.0.1:11434"
OLLAMA_MODEL="qwen2.5:7b"
OLLAMA_EMBED_MODEL="nomic-embed-text"
UPLOAD_DIR="./storage/uploads"
PORT="3000"
EOF
  chmod 600 "${APP_DIR}/.env"
  log_ok "Fichier .env généré avec secrets aléatoires (openssl rand -hex 32)."
else
  log_ok "Fichier .env existant conservé."
fi

# Chargement des variables pour la suite du script
set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a

# ------------------------------------------------------------------------------
# 3. Démarrage de PostgreSQL 16 + pgvector via Docker Compose
# ------------------------------------------------------------------------------
log_info "3/7 — Démarrage de PostgreSQL 16 + pgvector..."
docker compose up -d

log_info "Attente de disponibilité de PostgreSQL (pg_isready)..."
RETRIES=30
until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-ara}" -d "${POSTGRES_DB:-ara}" &>/dev/null; do
  RETRIES=$((RETRIES - 1))
  if [[ "${RETRIES}" -le 0 ]]; then
    log_err "PostgreSQL n'a pas démarré dans le temps imparti."
    exit 1
  fi
  sleep 2
done
log_ok "PostgreSQL 16 + pgvector prêt."

# ------------------------------------------------------------------------------
# 4. Installation d'Ollama & téléchargement des modèles IA locaux
# ------------------------------------------------------------------------------
log_info "4/7 — Vérification d'Ollama et des modèles IA locaux..."
if ! command -v ollama &>/dev/null; then
  log_info "Installation d'Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

if systemctl list-unit-files | grep -q "ollama.service"; then
  systemctl enable --now ollama
fi

# Attente de l'API Ollama sur 127.0.0.1:11434
OLLAMA_RETRIES=15
until curl -sf http://127.0.0.1:11434/api/tags &>/dev/null; do
  OLLAMA_RETRIES=$((OLLAMA_RETRIES - 1))
  if [[ "${OLLAMA_RETRIES}" -le 0 ]]; then
    log_warn "Service Ollama non joignable sur 127.0.0.1:11434. Lancement en arrière-plan..."
    nohup ollama serve >/var/log/ollama-ara.log 2>&1 &
    sleep 3
    break
  fi
  sleep 2
done

if curl -sf http://127.0.0.1:11434/api/tags &>/dev/null; then
  log_info "Téléchargement du modèle d'embeddings : ${OLLAMA_EMBED_MODEL:-nomic-embed-text}..."
  ollama pull "${OLLAMA_EMBED_MODEL:-nomic-embed-text}"
  log_info "Téléchargement du modèle conversationnel : ${OLLAMA_MODEL:-qwen2.5:7b}..."
  ollama pull "${OLLAMA_MODEL:-qwen2.5:7b}"
  log_ok "Modèles Ollama téléchargés et prêts."
else
  log_warn "Impossible de joindre Ollama pour le téléchargement automatique des modèles. Ara fonctionnera en mode dégradé."
fi

# ------------------------------------------------------------------------------
# 5. Dépendances NPM, Prisma migrations & Build de production Next.js
# ------------------------------------------------------------------------------
log_info "5/7 — Installation NPM, migrations Prisma et build de production..."
cd "${APP_DIR}"
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
log_ok "Application Ara compilée et base de données migrée."

# ------------------------------------------------------------------------------
# 6. Création et activation du service systemd (/etc/systemd/system/ara.service)
# ------------------------------------------------------------------------------
log_info "6/7 — Configuration du service systemd ara.service..."
NPM_BIN="$(command -v npm)"

cat > /etc/systemd/system/ara.service <<EOF
[Unit]
Description=Ara — Plateforme Collaborative Académique (Next.js + Socket.io)
After=network.target docker.service ollama.service
Wants=docker.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
ExecStart=${NPM_BIN} run start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ara

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ara
systemctl restart ara
log_ok "Service systemd 'ara.service' actif et configuré pour démarrer au reboot."

# ------------------------------------------------------------------------------
# 7. Récapitulatif final
# ------------------------------------------------------------------------------
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
echo ""
echo "=============================================================================="
echo -e "${GREEN}  INSTALLATION D'ARA TERMINÉE AVEC SUCCÈS !${NC}"
echo "=============================================================================="
echo "  URL locale       : http://localhost:${PORT:-3000}"
echo "  URL réseau       : http://${SERVER_IP}:${PORT:-3000}"
echo "  Stockage PDF     : ${APP_DIR}/storage/uploads"
echo "  Base de données  : Docker container 'ara-postgres' (PostgreSQL 16 + pgvector)"
echo "  IA Spix          : Ollama (${OLLAMA_MODEL:-qwen2.5:7b} + ${OLLAMA_EMBED_MODEL:-nomic-embed-text})"
echo ""
echo "  Commandes utiles :"
echo "    - Logs temps réel   : journalctl -u ara -f"
echo "    - Statut service    : systemctl status ara"
echo "    - Redémarrer Ara    : sudo systemctl restart ara"
echo ""
echo "  Option Reverse Proxy (Caddy HTTPS automatique) :"
echo "    ara.votre-domaine.fr {"
echo "      reverse_proxy 127.0.0.1:${PORT:-3000}"
echo "    }"
echo "=============================================================================="
