#!/usr/bin/env bash
# Обновяване и пускане на Helious/HEROS.
#   ./deploy.sh          — build без кеш + стартиране (обновява от GitHub при build и при старт)
#   ./deploy.sh logs     — показва логовете
#   ./deploy.sh restart  — само рестарт (entrypoint-ът пак тегли от GitHub + миграции)
#   ./deploy.sh down     — спира
set -e
cd "$(dirname "$0")"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Липсва Docker Compose."; exit 1
fi

if [ ! -f .env ]; then
  echo "Липсва .env — копирай .env.example на .env и попълни стойностите."; exit 1
fi

case "${1:-up}" in
  logs)
    $DC logs -f --tail=200
    ;;
  restart)
    echo "[deploy] рестарт (entrypoint тегли последното от GitHub + миграции)..."
    $DC restart
    ;;
  down)
    $DC down
    ;;
  up)
    echo "[deploy] изчистване на Docker build кеша..."
    docker builder prune -af >/dev/null 2>&1 || true
    echo "[deploy] build без кеш (тегли от GitHub)..."
    $DC build --no-cache
    echo "[deploy] стартиране..."
    $DC up -d --force-recreate
    $DC ps
    ;;
  *)
    echo "Употреба: $0 [up|restart|logs|down]"; exit 1
    ;;
esac
