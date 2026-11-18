#!/usr/bin/env bash
# ==============================================================================
# ARA — Script de mise à jour rapide en production (Ubuntu / Debian VPS)
# Usage :
#   sudo bash update.sh   (ou simplement : bash update.sh)
# ==============================================================================
set -euo pipefail

main() {
  local GREEN='\033[0;32m'
  local BLUE='\033[0;34m'
  local YELLOW='\033[1;33m'
  local RED='\033[0;31m'
  local NC='\033[0m'

  log_info() { echo -e "${BLUE}[ARA-UPDATE]${NC} $1"; }
  log_ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
  log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
  log_err()  { echo -e "${RED}[ERREUR]${NC} $1"; }

  # Élévation automatique en root via sudo
  if [[ "${EUID}" -ne 0 ]]; then
    exec sudo -E bash "$0" "$@"
  fi

  # Détermination automatique de la racine du projet (./update.sh ou ./scripts/update.sh)
  local SCRIPT_DIR
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local APP_DIR
  if [[ -f "${SCRIPT_DIR}/package.json" ]]; then
    APP_DIR="${SCRIPT_DIR}"
  elif [[ -f "${SCRIPT_DIR}/../package.json" ]]; then
    APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  else
    log_err "Impossible de localiser package.json depuis ${SCRIPT_DIR}."
    exit 1
  fi

  local APP_USER
  APP_USER="$(stat -c '%U' "${APP_DIR}" 2>/dev/null || echo "${SUDO_USER:-root}")"
  if [[ "${APP_USER}" == "root" ]] && id -u ubuntu &>/dev/null; then
    APP_USER="ubuntu"
  fi

  cd "${APP_DIR}"
  log_info "Mise à jour d'Ara dans : ${APP_DIR} (utilisateur : ${APP_USER})"

  # ----------------------------------------------------------------------------
  # 1/5 — Sauvegarde automatique pré-update
  # ----------------------------------------------------------------------------
  log_info "1/5 — Sauvegarde de sécurité pré-mise à jour..."
  if [[ -x /usr/local/bin/ara-backup.sh ]]; then
    if /usr/local/bin/ara-backup.sh; then
      log_ok "Sauvegarde effectuée."
    else
      log_warn "La sauvegarde pré-update a retourné un avertissement (poursuite de la mise à jour)."
    fi
  else
    log_warn "Script /usr/local/bin/ara-backup.sh absent — étape ignorée."
  fi

  # ----------------------------------------------------------------------------
  # 2/5 — Mise à jour Git depuis GitHub (.env et storage/ conservés)
  # ----------------------------------------------------------------------------
  log_info "2/5 — Récupération de la dernière version depuis GitHub..."
  git config --global --add safe.directory "${APP_DIR}" 2>/dev/null || true

  local BRANCH
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
  if [[ "${BRANCH}" == "HEAD" ]] || [[ -z "${BRANCH}" ]]; then
    BRANCH="main"
  fi

  git fetch origin
  if git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
    git reset --hard "origin/${BRANCH}"
  else
    git reset --hard "origin/main"
  fi

  local COMMIT_INFO
  COMMIT_INFO="$(git log -1 --oneline)"
  log_ok "Code à jour sur ${BRANCH} (${COMMIT_INFO})."

  # ----------------------------------------------------------------------------
  # 3/5 — Vérification .env & PostgreSQL
  # ----------------------------------------------------------------------------
  log_info "3/5 — Vérification de .env et de PostgreSQL..."
  if [[ ! -f "${APP_DIR}/.env" ]]; then
    log_err "Fichier .env introuvable dans ${APP_DIR}. Lancez d'abord : sudo bash install.sh"
    exit 1
  fi

  # Alignement horloge système sur Europe/Paris (heures creuses 00h–07h & Quiz 06h00)
  if command -v timedatectl &>/dev/null; then
    timedatectl set-timezone Europe/Paris 2>/dev/null || true
  fi

  # Bascule automatique vers qwen2.5:3b (plus rapide et mieux calibré sur CPU)
  if grep -qE '^OLLAMA_MODEL="?qwen2\.5:7b"?$' "${APP_DIR}/.env"; then
    sed -i 's|^OLLAMA_MODEL=.*|OLLAMA_MODEL="qwen2.5:3b"|' "${APP_DIR}/.env"
    log_ok "Modèle Ollama configuré sur qwen2.5:3b dans .env."
  fi

  mkdir -p "${APP_DIR}/storage/uploads" "${APP_DIR}/storage/backups"

  set -a
  # shellcheck disable=SC1091
  source "${APP_DIR}/.env"
  set +a

  if command -v ollama &>/dev/null && curl -sf http://127.0.0.1:11434/api/tags &>/dev/null; then
    local TARGET_MODEL="${OLLAMA_MODEL:-qwen2.5:3b}"
    if ! ollama list 2>/dev/null | grep -qF "${TARGET_MODEL}"; then
      log_info "Téléchargement du modèle Ollama ${TARGET_MODEL}..."
      ollama pull "${TARGET_MODEL}" || log_warn "Échec du pull ${TARGET_MODEL}, conservation du modèle local."
    fi
  fi

  docker compose up -d
  local RETRIES=30
  until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-ara}" -d "${POSTGRES_DB:-ara}" &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    if [[ "${RETRIES}" -le 0 ]]; then
      log_err "PostgreSQL n'a pas répondu à temps."
      exit 1
    fi
    sleep 2
  done
  log_ok "PostgreSQL prêt."

  # ----------------------------------------------------------------------------
  # 4/5 — Dépendances NPM, synchronisation Prisma & Build Next.js
  # ----------------------------------------------------------------------------
  log_info "4/5 — Installation NPM, synchronisation Prisma et compilation Next.js..."
  npm ci
  npx prisma generate
  npx prisma migrate resolve --applied 20261116180000_community_quizzes >/dev/null 2>&1 || true
  npx prisma migrate deploy || true
  npx prisma db push --skip-generate
  npm run build

  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
  chmod 600 "${APP_DIR}/.env"
  chmod 750 "${APP_DIR}/storage/uploads" "${APP_DIR}/storage/backups"
  chmod +x "${APP_DIR}/update.sh" "${APP_DIR}/install.sh" 2>/dev/null || true
  chmod +x "${APP_DIR}/scripts/"*.sh 2>/dev/null || true
  log_ok "Build de production et schéma PostgreSQL à jour."

  # ----------------------------------------------------------------------------
  # 5/5 — Redémarrage du service ara & contrôle de santé
  # ----------------------------------------------------------------------------
  log_info "5/5 — Redémarrage du service ara et vérification HTTP..."
  systemctl restart ara

  local APP_PORT="${PORT:-3000}"
  local HEALTH_RETRIES=20
  local HEALTH_OK=false
  while [[ "${HEALTH_RETRIES}" -gt 0 ]]; do
    if systemctl is-active --quiet ara && curl -sf -o /dev/null "http://127.0.0.1:${APP_PORT}/login"; then
      HEALTH_OK=true
      break
    fi
    HEALTH_RETRIES=$((HEALTH_RETRIES - 1))
    sleep 1
  done

  echo ""
  echo "======================================================================"
  if [[ "${HEALTH_OK}" == "true" ]]; then
    log_ok "MISE À JOUR D'ARA TERMINÉE AVEC SUCCÈS !"
  else
    log_warn "Service redémarré mais réponse HTTP lente — vérifiez : sudo journalctl -u ara -n 40 --no-pager"
  fi
  echo "  Commit déployé : ${COMMIT_INFO}"
  echo "  URL publique   : ${NEXTAUTH_URL:-http://127.0.0.1:${APP_PORT}}"
  echo "  Service local  : 127.0.0.1:${APP_PORT} ($(systemctl is-active ara || true))"
  echo "======================================================================"
}

main "$@"
exit 0
