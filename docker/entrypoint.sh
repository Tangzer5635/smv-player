#!/bin/sh
# Démarre SMV Player avec le compte « node » (sans privilèges).
# Le dossier de données monté depuis l'hôte peut appartenir à root : on le lui rend.
set -e

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$SMV_DATA_DIR"
    chown -R node:node "$SMV_DATA_DIR" 2>/dev/null || true
    exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
