#!/usr/bin/env bash
# ==============================================================================
# ARA — Script d'installation & de blindage automatisé (Ubuntu / Debian VPS)
# Usage :
#   sudo bash scripts/install.sh
#   ARA_DOMAIN="ara.mon-domaine.fr" sudo -E bash install.sh
# Ce script est idempotent et peut être relancé sans risque pour mettre à jour.
# ==============================================================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[ARA]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()   { echo -e "${RED}[ERREUR]${NC} $1"; }

if [[ "${EUID}" -ne 0 ]]; then
  log_err "Ce script doit être exécuté avec sudo : sudo bash install.sh"
  exit 1
fi

# Détermination automatique de la racine du projet (fonctionne depuis ./install.sh ou ./scripts/install.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
  APP_DIR="${SCRIPT_DIR}"
elif [[ -f "${SCRIPT_DIR}/../package.json" ]]; then
  APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  log_err "Impossible de localiser package.json depuis ${SCRIPT_DIR}."
  exit 1
fi

APP_USER="${SUDO_USER:-$(whoami)}"
if [[ "${APP_USER}" == "root" ]] && id -u ubuntu &>/dev/null; then
  APP_USER="ubuntu"
fi

log_info "Installation & durcissement d'Ara dans : ${APP_DIR} (utilisateur service : ${APP_USER})"

# ------------------------------------------------------------------------------
# 0. Swap automatique (4 Go) si RAM < 12 Go et aucun swap actif
# ------------------------------------------------------------------------------
TOTAL_RAM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
ACTIVE_SWAP="$(swapon --show --noheadings 2>/dev/null | wc -l || echo 0)"
if [[ "${TOTAL_RAM_MB}" -lt 12288 ]] && [[ "${ACTIVE_SWAP}" -eq 0 ]] && [[ ! -f /swapfile ]]; then
  log_info "0/9 — Création d'un fichier d'échange (/swapfile, 4 Go) pour sécuriser le build et Ollama..."
  if fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none; then
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    if ! grep -q "^/swapfile " /etc/fstab; then
      echo "/swapfile none swap sw 0 0" >> /etc/fstab
    fi
    log_ok "Swap 4 Go activé."
  else
    log_warn "Impossible de créer /swapfile (environnement conteneurisé ?)."
  fi
fi

# ------------------------------------------------------------------------------
# 1. Prérequis système (Node.js 20, Docker, UFW, Fail2ban, outils)
# ------------------------------------------------------------------------------
log_info "1/9 — Vérification des prérequis système (Node.js 20, Docker, UFW, Fail2ban)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git openssl ca-certificates gnupg lsb-release build-essential ufw fail2ban cron

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
# 2. Configuration réseau / domaine & fichier .env sécurisé
# ------------------------------------------------------------------------------
log_info "2/9 — Configuration sécurisée de .env & domaine..."
cd "${APP_DIR}"
mkdir -p "${APP_DIR}/storage/uploads" "${APP_DIR}/storage/backups"
chmod 750 "${APP_DIR}/storage/uploads" "${APP_DIR}/storage/backups"

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')"
ARA_DOMAIN="${ARA_DOMAIN:-}"
if [[ -z "${ARA_DOMAIN}" ]] && [[ -t 0 ]]; then
  echo -e "${BLUE}[ARA]${NC} Nom de domaine pour HTTPS automatique Caddy (ex: ara.mon-domaine.fr)"
  read -r -t 10 -p "      Laisser vide pour accès IP/HTTP direct [10s timeout] : " ARA_DOMAIN || true
fi
ARA_DOMAIN="$(echo "${ARA_DOMAIN}" | tr -d '[:space:]')"

TARGET_NEXTAUTH_URL="http://${SERVER_IP}"
if [[ -n "${ARA_DOMAIN}" ]]; then
  TARGET_NEXTAUTH_URL="https://${ARA_DOMAIN}"
fi

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
NEXTAUTH_URL="${TARGET_NEXTAUTH_URL}"
OLLAMA_HOST="http://127.0.0.1:11434"
OLLAMA_MODEL="qwen2.5:7b"
OLLAMA_EMBED_MODEL="nomic-embed-text"
UPLOAD_DIR="./storage/uploads"
PORT="3000"
EOF
  log_ok "Fichier .env généré avec secrets aléatoires (openssl rand -hex 32)."
else
  if grep -q '^NEXTAUTH_URL=' "${APP_DIR}/.env"; then
    sed -i "s|^NEXTAUTH_URL=.*|NEXTAUTH_URL=\"${TARGET_NEXTAUTH_URL}\"|" "${APP_DIR}/.env"
  else
    echo "NEXTAUTH_URL=\"${TARGET_NEXTAUTH_URL}\"" >> "${APP_DIR}/.env"
  fi
  if ! grep -q '^AUTH_TRUST_HOST=' "${APP_DIR}/.env"; then
    echo 'AUTH_TRUST_HOST="true"' >> "${APP_DIR}/.env"
  fi
  log_ok "Fichier .env existant conservé et NEXTAUTH_URL mis à jour (${TARGET_NEXTAUTH_URL})."
fi
chmod 600 "${APP_DIR}/.env"

set -a
# shellcheck disable=SC1091
source "${APP_DIR}/.env"
set +a

# ------------------------------------------------------------------------------
# 3. Démarrage de PostgreSQL 16 + pgvector via Docker Compose (loopback uniquement)
# ------------------------------------------------------------------------------
log_info "3/9 — Démarrage de PostgreSQL 16 + pgvector..."
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
log_ok "PostgreSQL 16 + pgvector prêt (127.0.0.1:5432)."

# ------------------------------------------------------------------------------
# 4. Installation d'Ollama (strictement lié à 127.0.0.1) & modèles IA locaux
# ------------------------------------------------------------------------------
log_info "4/9 — Installation et confinement d'Ollama sur 127.0.0.1:11434..."
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

if systemctl list-unit-files | grep -q "ollama.service"; then
  mkdir -p /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
EOF
  systemctl daemon-reload
  systemctl enable --now ollama
  systemctl restart ollama
fi

OLLAMA_RETRIES=15
until curl -sf http://127.0.0.1:11434/api/tags &>/dev/null; do
  OLLAMA_RETRIES=$((OLLAMA_RETRIES - 1))
  if [[ "${OLLAMA_RETRIES}" -le 0 ]]; then
    log_warn "Service Ollama non joignable sur 127.0.0.1:11434. Lancement local en arrière-plan..."
    OLLAMA_HOST="127.0.0.1:11434" nohup ollama serve >/var/log/ollama-ara.log 2>&1 &
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
  log_ok "Modèles Ollama téléchargés et isolés sur 127.0.0.1:11434."
else
  log_warn "Impossible de joindre Ollama pour télécharger les modèles. Ara fonctionnera normalement sans IA jusqu'au démarrage d'Ollama."
fi

# ------------------------------------------------------------------------------
# 5. Dépendances NPM, synchronisation Prisma & Build de production Next.js
# ------------------------------------------------------------------------------
log_info "5/9 — Installation NPM, migrations Prisma et build de production..."
cd "${APP_DIR}"
npm ci
npx prisma generate
npx prisma migrate deploy || true
npx prisma db push --skip-generate
npm run build
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"
chmod 750 "${APP_DIR}/storage/uploads" "${APP_DIR}/storage/backups"
log_ok "Application Ara compilée et schéma PostgreSQL synchronisé."

# ------------------------------------------------------------------------------
# 6. Configuration du service systemd (/etc/systemd/system/ara.service)
# ------------------------------------------------------------------------------
log_info "6/9 — Configuration du service systemd ara.service..."
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
log_ok "Service systemd 'ara.service' actif."

# ------------------------------------------------------------------------------
# 7. Reverse Proxy Caddy (HTTPS Let's Encrypt / Port 80 + WebSockets Socket.io)
# ------------------------------------------------------------------------------
log_info "7/9 — Installation et configuration du Reverse Proxy Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https || true
  if curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes && \
     curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null; then
    apt-get update -qq && apt-get install -y -qq caddy || log_warn "Installation de Caddy via Cloudsmith échouée."
  else
    apt-get install -y -qq caddy || log_warn "Paquet Caddy indisponible ; accès direct sur le port ${PORT:-3000}."
  fi
fi

if command -v caddy &>/dev/null; then
  CADDY_SITE=":80"
  if [[ -n "${ARA_DOMAIN}" ]]; then
    CADDY_SITE="${ARA_DOMAIN}"
  fi

  cat > /etc/caddy/Caddyfile <<EOF
${CADDY_SITE} {
	encode gzip zstd

	request_body {
		max_size 100MB
	}

	header {
		X-Robots-Tag "noindex, nofollow, noarchive, nosnippet, noimageindex"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "same-origin"
		-Server
	}

	reverse_proxy 127.0.0.1:${PORT:-3000}
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
  log_ok "Caddy configuré (${CADDY_SITE} -> 127.0.0.1:${PORT:-3000}, WebSockets Socket.io natifs)."
fi

# ------------------------------------------------------------------------------
# 8. Pare-feu UFW & Fail2ban SSH
# ------------------------------------------------------------------------------
log_info "8/9 — Durcissement pare-feu UFW & protection SSH Fail2ban..."
systemctl enable --now fail2ban
if [[ ! -f /etc/fail2ban/jail.d/ara-ssh.local ]]; then
  cat > /etc/fail2ban/jail.d/ara-ssh.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
EOF
  systemctl restart fail2ban || true
fi

ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw allow 22/tcp comment 'SSH' >/dev/null
ufw allow 80/tcp comment 'HTTP / Caddy ACME' >/dev/null
ufw allow 443/tcp comment 'HTTPS / Caddy' >/dev/null
ufw allow 3000/tcp comment 'Ara direct fallback' >/dev/null
ufw deny 5432/tcp comment 'Block external PostgreSQL' >/dev/null
ufw deny 11434/tcp comment 'Block external Ollama' >/dev/null
ufw --force enable >/dev/null
log_ok "Pare-feu UFW actif (22, 80, 443, 3000 ouverts ; 5432 et 11434 bloqués depuis l'extérieur)."

# ------------------------------------------------------------------------------
# 9. Sauvegarde quotidienne automatisée (PostgreSQL + PDFs, rétention 7 jours)
# ------------------------------------------------------------------------------
log_info "9/9 — Mise en place des sauvegardes automatiques quotidiennes (03h30)..."
cat > /usr/local/bin/ara-backup.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR}"
BACKUP_DIR="\${APP_DIR}/storage/backups"
mkdir -p "\${BACKUP_DIR}"
set -a
source "\${APP_DIR}/.env"
set +a

STAMP="\$(date +%Y%m%d_%H%M%S)"
cd "\${APP_DIR}"
docker compose exec -T postgres pg_dump -U "\${POSTGRES_USER:-ara}" "\${POSTGRES_DB:-ara}" | gzip > "\${BACKUP_DIR}/db_\${STAMP}.sql.gz"
tar -czf "\${BACKUP_DIR}/uploads_\${STAMP}.tar.gz" -C "\${APP_DIR}/storage" uploads
chmod 600 "\${BACKUP_DIR}/db_\${STAMP}.sql.gz" "\${BACKUP_DIR}/uploads_\${STAMP}.tar.gz"
find "\${BACKUP_DIR}" -type f -mtime +7 -delete
EOF
chmod 700 /usr/local/bin/ara-backup.sh

cat > /etc/cron.d/ara-backup <<'EOF'
30 3 * * * root /usr/local/bin/ara-backup.sh >> /var/log/ara-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/ara-backup
systemctl enable --now cron || true
log_ok "Sauvegarde quotidienne configurée (/usr/local/bin/ara-backup.sh -> storage/backups/, rétention 7j)."

# ------------------------------------------------------------------------------
# Récapitulatif final
# ------------------------------------------------------------------------------
echo ""
echo "=============================================================================="
echo -e "${GREEN}  INSTALLATION & DURCISSEMENT D'ARA TERMINÉS AVEC SUCCÈS !${NC}"
echo "=============================================================================="
if [[ -n "${ARA_DOMAIN}" ]]; then
  echo "  URL HTTPS        : https://${ARA_DOMAIN}"
else
  echo "  URL HTTP Caddy   : http://${SERVER_IP}"
  echo "  URL directe      : http://${SERVER_IP}:${PORT:-3000}"
fi
echo "  Stockage PDF     : ${APP_DIR}/storage/uploads (chmod 750)"
echo "  Sauvegardes      : ${APP_DIR}/storage/backups (tous les jours à 03h30, 7j)"
echo "  Base de données  : Docker 'ara-postgres' (PostgreSQL 16 + pgvector sur 127.0.0.1)"
echo "  IA Spix          : Ollama (${OLLAMA_MODEL:-qwen2.5:7b}) isolé sur 127.0.0.1:11434"
echo "  Sécurité         : UFW + Fail2ban + X-Robots-Tag noindex + robots.txt anti-IA"
echo ""
echo "  Astuce confidentialité :"
echo "    Activez la validation admin : créez votre compte Responsable d'Année"
echo "    en premier, puis validez chaque étudiant depuis /admin."
echo ""
echo "  Commandes utiles :"
echo "    - Logs app         : journalctl -u ara -f"
echo "    - Backup manuel    : sudo /usr/local/bin/ara-backup.sh"
echo "    - Redémarrer Caddy : sudo systemctl reload caddy"
echo "=============================================================================="
