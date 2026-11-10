#!/usr/bin/env bash
# SMV Player — installation rapide (Raspberry Pi OS, Debian, Ubuntu…)
#
#   ./install.sh
#
# Installe Docker si besoin, prépare .env (domaine + compte) puis démarre SMV Player.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
    say "Installation de Docker"
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER" || true
    echo "Docker installé. Si la commande suivante échoue, déconnectez-vous puis relancez ./install.sh"
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

if [ ! -f .env ]; then
    say "Configuration"
    cp .env.example .env
    read -rp "Nom de domaine (ex. matv.duckdns.org, vide = localhost) : " domain
    read -rp "Identifiant administrateur [admin] : " user
    while true; do
        read -rsp "Mot de passe administrateur (8 caractères min.) : " pass; echo
        if [ "${#pass}" -lt 8 ]; then echo "Trop court."; continue; fi
        case "$pass" in *"'"*) echo "Évitez l'apostrophe dans le mot de passe."; continue ;; esac
        break
    done
    read -rp "Sous-domaine DuckDNS (vide si vous n'utilisez pas DuckDNS) : " duck
    token=""
    if [ -n "$duck" ]; then read -rp "Jeton DuckDNS : " token; fi

    # Remplace « CLÉ=… » dans .env sans interpréter la valeur (caractères spéciaux)
    set_env() {
        local key="$1" value="$2" line tmp
        tmp=$(mktemp)
        while IFS= read -r line || [ -n "$line" ]; do
            if [[ "$line" == "$key="* ]]; then printf '%s=%s\n' "$key" "$value"; else printf '%s\n' "$line"; fi
        done < .env > "$tmp"
        mv "$tmp" .env
    }
    set_env DOMAIN "${domain:-localhost}"
    set_env SMV_ADMIN_USER "${user:-admin}"
    # Entre apostrophes : Docker Compose ne remplace pas les « $ » qu'il contiendrait
    set_env SMV_ADMIN_PASSWORD "'$pass'"
    set_env DUCKDNS_SUBDOMAINS "$duck"
    set_env DUCKDNS_TOKEN "$token"
    chmod 600 .env
fi

mkdir -p data
PROFILE=""
if grep -q '^DUCKDNS_TOKEN=.\+' .env; then PROFILE="--profile duckdns"; fi

say "Construction et démarrage (premier lancement : quelques minutes sur Raspberry Pi)"
# shellcheck disable=SC2086
$DOCKER compose $PROFILE up -d --build

domain=$(grep '^DOMAIN=' .env | cut -d= -f2 | cut -d, -f1)
say "SMV Player est démarré : https://${domain:-localhost}"
echo "Logs : $DOCKER compose logs -f smv"
